"""Arena Hero local SDK runtime backed by the shared pure Python strategy."""

from __future__ import annotations

import hmac
import os
import time
from getpass import getpass
from pathlib import Path

from arena_hero import (
    APIError,
    ArenaHeroClient,
    AuthenticationError,
    ConfigurationError,
    TransportError,
    Turn,
)

from ..adapters.local_memory import TacticMemory
from ..adapters.sdk_input import sdk_turn_to_canonical
from ..adapters.sdk_output import apply_command_plan
from ..configuration.strategy import StrategyConfig, load_strategy_config
from ..dashboard.control import apply_control_commands
from ..dashboard.state import write_dashboard_state
from ..runtime.paths import (
    CONTROL_DIR,
    CONTROL_RECEIPT_FILE,
    DASHBOARD_STATE_FILE,
    ENV_FILE,
    STATE_FILE,
    TACTIC_LOCK_FILE,
)
from ..runtime.process_lock import InstanceAlreadyRunning, SingleInstanceLock
from ..runtime.version_monitor import (
    DEFAULT_MARKER_PATH,
    DEFAULT_REPORT_PATH,
    compatibility_hold_active,
    run_check as run_version_check,
)
from ..strategy_core import planner as _strategy
from ..strategy_core.model import PlannerOptions
from ..training.dataset import record_accepted_turn as record_training_turn
from ..training.experiment import (
    active_block_id,
    ensure_active_experiment_config,
    record_accepted_turn,
)

EnemyTrack = _strategy.EnemyTrack
Pathfinder = _strategy.Pathfinder
PHASE_EARLY = _strategy.PHASE_EARLY
PHASE_MID = _strategy.PHASE_MID
PHASE_LATE = _strategy.PHASE_LATE
POSTURE_ECONOMY = _strategy.POSTURE_ECONOMY
POSTURE_GUARDED = _strategy.POSTURE_GUARDED
POSTURE_SURVIVAL = _strategy.POSTURE_SURVIVAL
_exploration_radius = _strategy._exploration_radius
_neighbors = _strategy._neighbors
_offense_ready = _strategy._offense_ready
_resource_chunk_patrol_targets = _strategy._resource_chunk_patrol_targets
_resource_radius = _strategy._resource_radius
_stale_visibility_patrol_targets = _strategy._stale_visibility_patrol_targets
_strategy_phase = _strategy._strategy_phase
_unit_cost = _strategy._unit_cost
_worker_scout_limit = _strategy._worker_scout_limit


def _dotenv_values() -> dict[str, str]:
    if not ENV_FILE.is_file():
        return {}
    values: dict[str, str] = {}
    for raw_line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        name, separator, value = line.partition("=")
        if separator:
            values[name.strip()] = value.strip().strip('"').strip("'")
    return values


DOTENV_VALUES = _dotenv_values()


def _setting(name: str, default: str) -> str:
    return os.environ.get(name) or DOTENV_VALUES.get(name) or default


_API_KEY_COPY_ARTIFACTS = str.maketrans(
    {
        "\ufeff": "",
        "\u200b": "",
        "\u200c": "",
        "\u200d": "",
        "\u2060": "",
        "\u201c": "",
        "\u201d": "",
        "\u2018": "",
        "\u2019": "",
    }
)


def _normalize_api_key(raw: str) -> str:
    """Remove common copy artifacts, then enforce the SDK's ASCII contract."""
    api_key = "".join(raw.translate(_API_KEY_COPY_ARTIFACTS).split())
    if not api_key:
        raise SystemExit("Arena Hero API key is required")
    if any(not 0x21 <= ord(character) <= 0x7E for character in api_key):
        raise SystemExit(
            "Arena Hero API key must contain visible ASCII only. "
            "Copy the key again without labels or Chinese punctuation."
        )
    return api_key


def _dotenv_credentials() -> tuple[str, str]:
    values = _dotenv_values()
    return (
        values.get("ARENA_HERO_API_KEY", "").strip(),
        values.get("ARENA_HERO_EXPECTED_USERNAME", "").strip(),
    )


def _credentials_match(
    api_key: str,
    expected_username: str,
    configured_api_key: str,
    configured_username: str,
) -> bool:
    return hmac.compare_digest(
        api_key.encode("utf-8"), configured_api_key.encode("utf-8")
    ) and expected_username.casefold() == configured_username.casefold()


def _watch_dotenv_credentials(api_key: str, expected_username: str) -> bool:
    configured_api_key, configured_username = _dotenv_credentials()
    return bool(configured_api_key) and _credentials_match(
        api_key, expected_username, configured_api_key, configured_username
    )


def _dotenv_credentials_changed(api_key: str, expected_username: str) -> bool:
    configured_api_key, configured_username = _dotenv_credentials()
    if not configured_api_key:
        return False
    return not _credentials_match(
        api_key, expected_username, configured_api_key, configured_username
    )


def _expected_owner_matches(turn: Turn, expected_username: str) -> bool | None:
    if not expected_username:
        return True
    core = getattr(turn, "core", None)
    owner_username = str(getattr(core, "owner_username", "") or "").strip()
    if not owner_username:
        return None
    return owner_username.casefold() == expected_username.casefold()


TACTIC_PROFILE = _setting("TACTIC_PROFILE", "economy").strip().lower()
if TACTIC_PROFILE not in {"economy", "balanced"}:
    raise SystemExit("TACTIC_PROFILE must be either 'economy' or 'balanced'")
DEBUG_TURNS = _setting("TACTIC_DEBUG", "1").strip().lower() not in {
    "0",
    "false",
    "off",
    "",
}
EXPECTED_USERNAME = _setting("ARENA_HERO_EXPECTED_USERNAME", "").strip()
VERSION_CHECK_ENABLED = _setting("ARENA_HERO_VERSION_CHECK", "1").strip().lower() not in {
    "0",
    "false",
    "off",
    "no",
    "",
}
try:
    VERSION_CHECK_INTERVAL_TICKS = max(
        1, int(_setting("ARENA_HERO_VERSION_CHECK_INTERVAL_TICKS", "240"))
    )
except ValueError:
    VERSION_CHECK_INTERVAL_TICKS = 240
SAFETY_ENABLED = _setting("TACTIC_SAFETY", "1").strip().lower() not in {
    "0",
    "false",
    "off",
    "no",
    "",
}
CORE_MIGRATION_ENABLED = _setting("TACTIC_CORE_MIGRATION", "1").strip().lower() not in {
    "0",
    "false",
    "off",
    "no",
    "",
}


def choose_actions(
    turn: Turn,
    memory: TacticMemory | None = None,
    config: StrategyConfig | None = None,
) -> None:
    """Plan through the shared Python core, then apply commands to the SDK Turn."""

    if memory is None:
        memory = TacticMemory()
    if config is None:
        config = load_strategy_config()
    memory.sync_economy_experiment(active_block_id())
    canonical = sdk_turn_to_canonical(
        turn,
        PlannerOptions(
            profile=TACTIC_PROFILE,
            safety_enabled=SAFETY_ENABLED,
            core_migration_enabled=CORE_MIGRATION_ENABLED,
        ),
    )
    result = _strategy.plan_tick(
        canonical,
        memory,
        config,
    )
    apply_command_plan(turn, result.plan)


def _format_action(action: object | None) -> str:
    if action is None:
        return "WAIT"
    name = type(action).__name__.removesuffix("Action").upper()
    direction = getattr(action, "direction", None)
    if direction is not None:
        return f"{name}:{direction.value}"
    expected_cell = getattr(action, "expected_cell", None)
    if expected_cell is not None:
        return f"{name}:{expected_cell}"
    unit_type = getattr(action, "unit_type", None)
    if unit_type is not None:
        return f"{name}:{unit_type.value}"
    return name


def _print_turn_debug(
    turn: Turn,
    memory: TacticMemory,
    config: StrategyConfig,
) -> None:
    if not DEBUG_TURNS:
        return
    worker_plans = []
    for worker in turn.workers:
        worker_plans.append(
            " ".join(
                (
                    f"{str(worker.id)[:8]}@{worker.position}",
                    f"cargo={worker.cargo}",
                    f"resource_target={memory.worker_targets.get(worker.id)}",
                    f"scout_target={memory.scout_targets.get(worker.id)}",
                    f"action={_format_action(turn.plan.unit_actions.get(worker.id))}",
                )
            )
        )
    turns = max(memory.turns_seen, 1)
    scout_rate = (
        memory.scouting_worker_ticks / memory.worker_ticks
        if memory.worker_ticks
        else 0.0
    )
    print(
        f"tick={turn.tick} profile={TACTIC_PROFILE} "
        f"posture={memory.last_posture} threat_score={memory.last_threat_score:.2f} "
        f"phase={_strategy_phase(turn, memory, config)} "
        f"resource_radius={memory.effective_resource_radius}/"
        f"{memory.resource_radius_limit} "
        f"resource_candidates={memory.resource_candidate_count} "
        f"resource_assignments={memory.resource_assignment_count} "
        f"exploration_radius={_exploration_radius(turn, memory, config)} "
        f"offense_ready={_offense_ready(turn, memory, config)} "
        f"planned_deposited={memory.planned_deposited} "
        f"per_turn={memory.planned_deposited / turns:.2f} "
        f"scouting={scout_rate:.0%} known={len(memory.known_cells)} "
        f"visible_enemies={len(turn.visible_enemies)} "
        f"remembered_threats={len(memory.enemy_sightings)} "
        f"worker_losses={memory.worker_losses} "
        f"fleeing_ticks={memory.fleeing_worker_ticks} "
        f"visible_resources={sorted(turn.resource_cells)} "
        f"remembered_resources={sorted(memory.resource_hints)} "
        f"workers=[{' | '.join(worker_plans)}]",
        flush=True,
    )


def _is_stale_submission(error: APIError) -> bool:
    return error.status_code == 409 and error.error in {
        "COMMAND_WINDOW_CLOSED",
        "TICK_MISMATCH",
    }


def _version_check_paths() -> tuple[Path, Path]:
    marker = Path(os.environ.get("ARENA_HERO_COMPAT_MARKER", str(DEFAULT_MARKER_PATH))).expanduser()
    report = Path(os.environ.get("ARENA_HERO_COMPAT_REPORT", str(DEFAULT_REPORT_PATH))).expanduser()
    return marker, report


def _report_version_hold(report: dict[str, object], marker: Path) -> None:
    reasons = ",".join(str(item) for item in report.get("reasons", ())) or "unknown"
    print(
        f"compatibility_hold status={report.get('status', 'unknown')} "
        f"reasons={reasons} marker={marker}",
        flush=True,
    )


def _play_locked(api_key: str) -> None:
    memory = TacticMemory.load(STATE_FILE)
    watch_dotenv_credentials = _watch_dotenv_credentials(
        api_key,
        EXPECTED_USERNAME,
    )
    marker_path, report_path = _version_check_paths()
    next_version_check_tick: int | None = None
    if VERSION_CHECK_ENABLED:
        report = run_version_check(
            marker_path=marker_path,
            report_path=report_path,
        )
        if report.get("hold"):
            _report_version_hold(report, marker_path)
            return
        next_version_check_tick = VERSION_CHECK_INTERVAL_TICKS

    with ArenaHeroClient(api_key=api_key) as game:
        for turn in game.turns():
            if watch_dotenv_credentials and _dotenv_credentials_changed(
                api_key,
                EXPECTED_USERNAME,
            ):
                print("credential_config_changed=restarting", flush=True)
                break
            owner_matches = _expected_owner_matches(turn, EXPECTED_USERNAME)
            if owner_matches is False:
                print(
                    "account_verification_failed=api_key_owner_mismatch",
                    flush=True,
                )
                break
            if VERSION_CHECK_ENABLED and (
                next_version_check_tick is None
                or turn.tick >= next_version_check_tick
            ):
                report = run_version_check(
                    marker_path=marker_path,
                    report_path=report_path,
                )
                if report.get("hold"):
                    _report_version_hold(report, marker_path)
                    break
                next_version_check_tick = turn.tick + VERSION_CHECK_INTERVAL_TICKS
            if VERSION_CHECK_ENABLED and compatibility_hold_active(marker_path):
                print(
                    f"compatibility_hold marker={marker_path}",
                    flush=True,
                )
                break

            ensure_active_experiment_config()
            config = load_strategy_config()
            decision_started = time.perf_counter()
            choose_actions(turn, memory, config)
            apply_control_commands(turn, CONTROL_DIR, CONTROL_RECEIPT_FILE)
            decision_ms = (time.perf_counter() - decision_started) * 1000.0
            _print_turn_debug(turn, memory, config)
            try:
                accepted = turn.submit()
            except APIError as error:
                if _is_stale_submission(error):
                    if DEBUG_TURNS:
                        print(
                            f"tick={turn.tick} skipped={error.error}",
                            flush=True,
                        )
                    continue
                raise
            try:
                memory.save(STATE_FILE)
            except OSError as error:
                if DEBUG_TURNS:
                    print(f"state_save_failed={error}", flush=True)
            try:
                record_accepted_turn(turn, memory, config)
            except (OSError, TypeError, ValueError, KeyError) as error:
                if DEBUG_TURNS:
                    print(f"economy_archive_save_failed={error}", flush=True)
            try:
                record_training_turn(
                    turn,
                    memory,
                    config,
                    profile=TACTIC_PROFILE,
                    strategy_phase=_strategy_phase(turn, memory, config),
                    resource_radius=_resource_radius(turn, memory, config),
                    exploration_radius=_exploration_radius(turn, memory, config),
                    offense_ready=_offense_ready(turn, memory, config),
                    decision_ms=decision_ms,
                )
            except (OSError, TypeError, ValueError, KeyError) as error:
                if DEBUG_TURNS:
                    print(f"training_dataset_save_failed={error}", flush=True)
            try:
                write_dashboard_state(
                    turn,
                    memory,
                    config,
                    profile=TACTIC_PROFILE,
                    accepted=accepted.accepted,
                    strategy_phase=_strategy_phase(turn, memory, config),
                    resource_radius=_resource_radius(turn, memory, config),
                    exploration_radius=_exploration_radius(turn, memory, config),
                    offense_ready=_offense_ready(turn, memory, config),
                    path=DASHBOARD_STATE_FILE,
                )
            except OSError as error:
                if DEBUG_TURNS:
                    print(f"dashboard_state_save_failed={error}", flush=True)
            if DEBUG_TURNS:
                print(f"tick={accepted.tick} accepted={accepted.accepted}", flush=True)


def play(api_key: str) -> None:
    try:
        with SingleInstanceLock(TACTIC_LOCK_FILE):
            _play_locked(api_key)
    except InstanceAlreadyRunning as error:
        print(f"tactic_not_started={error}", flush=True)

def _dotenv_api_key() -> str | None:
    return DOTENV_VALUES.get("ARENA_HERO_API_KEY")


def main() -> None:
    api_key = _normalize_api_key(
        os.environ.get("ARENA_HERO_API_KEY")
        or _dotenv_api_key()
        or getpass("Arena Hero API key: ")
    )
    try:
        play(api_key)
    except AuthenticationError:
        raise SystemExit(
            "Arena Hero authentication failed (HTTP 401). "
            "Use a current API key and check for missing or extra characters."
        ) from None
    except ConfigurationError as error:
        raise SystemExit(f"Arena Hero configuration failed: {error}") from None
    except TransportError as error:
        raise SystemExit(
            f"Arena Hero connection failed: {error}. Check the network and retry."
        ) from None
    except KeyboardInterrupt:
        print("Stopped.")


if __name__ == "__main__":
    main()

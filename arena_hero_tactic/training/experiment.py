"""Long-running, anonymous A/B experiments for the fixed 17/1/1 economy.

The live tactic appends one aggregate record per accepted Tick to a local JSONL
archive.  When an experiment is enabled, the controller rotates through the
candidate schedule after warmup and measurement gates are satisfied.  Raw
telemetry stays ignored; only the public plan/report belongs in Git.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, MutableMapping, Sequence

from ..runtime.paths import (
    CONFIG_FILE,
    ECONOMY_TELEMETRY_FILE as ARCHIVE_FILE,
    EXPERIMENT_PLAN_FILE as PLAN_FILE,
    EXPERIMENT_STATE_FILE as STATE_FILE,
)
from ..configuration.strategy import (
    StrategyConfig,
    load_strategy_config,
    save_strategy_config,
)


CONFIDENCE_RANK = {"low": 0, "medium": 1, "high": 2}
MINIMUM_USEFUL_UTILIZATION = 0.75
PHASE_POLICY_VERSION = 2
DEFAULT_MAX_READINESS_SAMPLES = 720


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_copy(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=True))


@contextmanager
def _exclusive_lock(path: Path, timeout_seconds: float = 2.0):
    """Serialize telemetry/state writes across accidentally duplicated tactics."""
    deadline = time.monotonic() + timeout_seconds
    descriptor: int | None = None
    while descriptor is None:
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if time.monotonic() >= deadline:
                try:
                    if time.time() - path.stat().st_mtime > 30:
                        path.unlink()
                        continue
                except FileNotFoundError:
                    continue
                raise TimeoutError(f"timed out waiting for telemetry lock: {path}")
            time.sleep(0.02)
    try:
        os.write(descriptor, str(os.getpid()).encode("ascii"))
        yield
    finally:
        os.close(descriptor)
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def _deep_merge(base: MutableMapping[str, Any], overlay: Mapping[str, Any]) -> None:
    for key, value in overlay.items():
        if isinstance(value, Mapping) and isinstance(base.get(key), MutableMapping):
            _deep_merge(base[key], value)  # type: ignore[index]
        else:
            base[key] = _json_copy(value)


def economy_parameters(config: StrategyConfig) -> dict[str, Any]:
    """Return only anonymous values that can affect peaceful economy output."""
    return {
        "workers": {
            "max_economy_scouts": config.workers.max_economy_scouts,
            "max_scouts_under_threat": config.workers.max_scouts_under_threat,
            "safe_scout_radius": config.workers.safe_scout_radius,
            "recovery_worker_floor": config.workers.recovery_worker_floor,
        },
        "adaptive_economy": {
            "window_ticks": config.adaptive_economy.window_ticks,
            "warmup_ticks": config.adaptive_economy.warmup_ticks,
            "adjustment_cooldown_ticks": config.adaptive_economy.adjustment_cooldown_ticks,
            "radius_step": config.adaptive_economy.radius_step,
            "min_resource_radius": config.adaptive_economy.min_resource_radius,
            "max_resource_radius": config.adaptive_economy.max_resource_radius,
            "scarcity_ticks": config.adaptive_economy.scarcity_ticks,
            "long_cycle_ticks": config.adaptive_economy.long_cycle_ticks,
            "low_throughput_per_worker": config.adaptive_economy.low_throughput_per_worker,
            "healthy_throughput_per_worker": config.adaptive_economy.healthy_throughput_per_worker,
            "max_harvest_failure_rate": config.adaptive_economy.max_harvest_failure_rate,
            "storage_full_ratio": config.adaptive_economy.storage_full_ratio,
            "max_scout_bonus": config.adaptive_economy.max_scout_bonus,
        },
        "production": {
            "workers": 17,
            "vanguards": 1,
            "rangers": 1,
            "reserve_resources": config.production.reserve_resources,
        },
        "vanguards": {
            "early_scout_radius": config.vanguards.early_scout_radius,
            "late_scout_radius": config.vanguards.late_scout_radius,
        },
        "rangers": {
            "guard_numerator": config.rangers.guard_numerator,
            "guard_denominator": config.rangers.guard_denominator,
            "guard_radius": config.rangers.guard_radius,
        },
    }


def parameter_id(parameters: Mapping[str, Any]) -> str:
    payload = json.dumps(parameters, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def _sample_reward(sample: Mapping[str, Any]) -> float:
    workers = float(sample.get("workers", 0) or 0)
    busy = min(workers, float(sample.get("busy", 0) or 0))
    idle = max(0.0, workers - busy)
    return (
        8.0 * float(sample.get("deposited", 0) or 0)
        + 4.0 * float(sample.get("harvested", 0) or 0)
        + 0.75 * float(sample.get("assignments", 0) or 0)
        + 0.2 * float(sample.get("new_cells", 0) or 0)
        - 4.0 * float(sample.get("harvest_failures", 0) or 0)
        - 2.0 * float(sample.get("storage_full", 0) or 0)
        - idle
    )


def _record_metrics(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    if not records:
        return {
            "sample_count": 0,
            "outcome_events": 0,
            "score": 0.0,
            "confidence": "low",
        }
    worker_ticks = sum(float(r.get("workers", 0) or 0) for r in records)
    scout_ticks = sum(float(r.get("scouts", 0) or 0) for r in records)
    deposited = sum(float(r.get("deposited", 0) or 0) for r in records)
    harvested = sum(float(r.get("harvested", 0) or 0) for r in records)
    harvest_successes = sum(float(r.get("harvest_successes", 0) or 0) for r in records)
    harvest_failures = sum(float(r.get("harvest_failures", 0) or 0) for r in records)
    outcomes = int(sum(
        float(r.get("harvest_successes", 0) or 0)
        + float(r.get("deposit_successes", 0) or 0)
        for r in records
    ))
    attempts = harvest_successes + harvest_failures
    score = sum(_sample_reward(r) for r in records) / len(records)
    sample_count = len(records)
    blocks = len({str(r.get("block_id", "")) for r in records if r.get("block_id")})
    utilization = (
        sum(
            min(
                float(r.get("workers", 0) or 0),
                float(r.get("busy", 0) or 0),
            )
            for r in records
        )
        / worker_ticks
        if worker_ticks
        else 0.0
    )
    viable = utilization >= MINIMUM_USEFUL_UTILIZATION
    if viable and sample_count >= 720 and outcomes >= 60 and blocks >= 3:
        confidence = "high"
    elif viable and sample_count >= 480 and outcomes >= 40 and blocks >= 2:
        confidence = "medium"
    else:
        confidence = "low"
    return {
        "sample_count": sample_count,
        "outcome_events": outcomes,
        "blocks": blocks,
        "score": round(score, 4),
        "throughput_per_worker": round(deposited / worker_ticks, 6) if worker_ticks else 0.0,
        "harvest_per_worker": round(harvested / worker_ticks, 6) if worker_ticks else 0.0,
        "utilization": round(utilization, 6),
        "viable": viable,
        "failure_rate": round(harvest_failures / attempts, 6) if attempts else 0.0,
        "storage_full_ratio": round(
            sum(bool(r.get("storage_full", 0)) for r in records) / sample_count,
            6,
        ),
        "discovery_per_scout_tick": round(
            sum(float(r.get("new_cells", 0) or 0) for r in records) / scout_ticks,
            6,
        ) if scout_ticks else 0.0,
        "confidence": confidence,
    }


def _measurement_eligible(record: Mapping[str, Any]) -> bool:
    return bool(record.get("measurement_eligible"))


def _stable_economy_record(record: Mapping[str, Any]) -> bool:
    return bool(
        int(record.get("workers", 0) or 0) == 17
        and int(record.get("vanguards", 0) or 0) == 1
        and int(record.get("rangers", 0) or 0) == 1
        and str(record.get("posture", "")) == "ECONOMY"
    )


def _block_phase(record: Mapping[str, Any], experiment: Mapping[str, Any]) -> str:
    if not experiment.get("enabled"):
        return "untracked"
    if not _stable_economy_record(record):
        return "readiness"
    warmup_samples = int(experiment.get("warmup_samples", 24))
    warmup_collected = int(experiment.get("warmup_samples_collected", 0))
    return "warmup" if warmup_collected < warmup_samples else "measure"


def append_telemetry(
    sample: Mapping[str, Any],
    config: StrategyConfig,
    *,
    composition: Mapping[str, int],
    posture: str,
    threat_score: float,
    worker_losses: int,
    path: Path = ARCHIVE_FILE,
    state_path: Path = STATE_FILE,
) -> dict[str, Any]:
    """Append one anonymous accepted-Tick record and return the record."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with _exclusive_lock(lock_path):
        parameters = economy_parameters(config)
        state = load_state(state_path)
        experiment = state if state.get("enabled") else {}
        record = {
            "version": 1,
            "phase_policy_version": PHASE_POLICY_VERSION,
            "recorded_at": _now(),
            "tick": int(sample.get("tick", 0) or 0),
            "workers": int(composition.get("workers", sample.get("workers", 0)) or 0),
            "vanguards": int(composition.get("vanguards", 0) or 0),
            "rangers": int(composition.get("rangers", 0) or 0),
            "posture": str(posture),
            "threat_score": round(float(threat_score), 4),
            "worker_losses": max(0, int(worker_losses)),
            "experiment_id": str(experiment.get("experiment_id", "")),
            "candidate_id": str(experiment.get("candidate_id", "published-default")),
            "block_id": str(experiment.get("block_id", "")),
            "sample": {str(key): int(value) for key, value in sample.items()},
            "parameters": parameters,
            "parameter_id": parameter_id(parameters),
        }
        phase = _block_phase(record, experiment)
        record["block_phase"] = phase
        record["measurement_eligible"] = bool(
            experiment.get("enabled")
            and phase == "measure"
            and _stable_economy_record(record)
        )
        record_key = f"{record['block_id']}:{record['tick']}:{record['parameter_id']}"
        if state.get("last_record_key") == record_key:
            record["duplicate"] = True
            return record
        with path.open("a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n"
            )
        state["last_record_key"] = record_key
        if experiment.get("enabled"):
            _advance_experiment(record, state, state_path, archive_path=path)
        else:
            _save_state(state, state_path)
        return record


def load_records(path: Path = ARCHIVE_FILE) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    seen_experiment_ticks: set[tuple[str, int]] = set()
    if not path.is_file():
        return records
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(raw, Mapping) or not isinstance(raw.get("sample"), Mapping):
                continue
            sample = dict(raw["sample"])
            record = dict(raw)
            record.update(sample)
            block_id = str(record.get("block_id", ""))
            if block_id:
                key = (block_id, int(record.get("tick", 0) or 0))
                if key in seen_experiment_ticks:
                    continue
                seen_experiment_ticks.add(key)
            records.append(record)
    return records


def load_state(path: Path = STATE_FILE) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return dict(raw) if isinstance(raw, Mapping) else {}
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return {}


def active_block_id(path: Path = STATE_FILE) -> str | None:
    state = load_state(path)
    if not state.get("enabled"):
        return None
    block_id = str(state.get("block_id", "")).strip()
    return block_id or None


def ensure_active_experiment_config(
    *,
    plan_path: Path = PLAN_FILE,
    state_path: Path = STATE_FILE,
    config_path: Path = CONFIG_FILE,
) -> dict[str, Any]:
    """Restore the active candidate if another process overwrote its config."""
    state = load_state(state_path)
    if not state.get("enabled"):
        return {"enabled": False, "corrected": False}
    plan = _plan(plan_path)
    candidate = _candidate_map(plan).get(str(state.get("candidate_id", "")))
    if candidate is None:
        return {
            "enabled": True,
            "corrected": False,
            "error": "active candidate is missing from the experiment plan",
        }
    expected = _candidate_document(
        candidate,
        base_document=state.get("original_config", {}),
    )
    current = load_strategy_config(config_path, strict=True).to_dict()
    corrected = current != expected
    if corrected:
        save_strategy_config(expected, config_path)
    return {
        "enabled": True,
        "corrected": corrected,
        "candidate_id": str(state.get("candidate_id", "")),
        "block_id": str(state.get("block_id", "")),
    }


def _save_state(state: Mapping[str, Any], path: Path = STATE_FILE) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def _plan(path: Path = PLAN_FILE) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _candidate_map(plan: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    candidates = plan.get("experiment_plan", {}).get("candidates", [])
    return {str(item["id"]): item for item in candidates if isinstance(item, Mapping) and item.get("id")}


def _candidate_document(
    candidate: Mapping[str, Any],
    *,
    base_document: Mapping[str, Any],
) -> dict[str, Any]:
    updated = _json_copy(base_document)
    updated.setdefault("production", {})
    updated["production"].update({
        "enabled": True,
        "order": [
            {"unit_type": "WORKER", "target": 17},
            {"unit_type": "VANGUARD", "target": 1},
            {"unit_type": "RANGER", "target": 1},
        ],
        "max_population": 19,
        "after_plan": "hold",
    })
    updated.setdefault("pacing", {})["enabled"] = False
    updated.setdefault("core", {})["migration_enabled"] = False
    _deep_merge(updated, candidate.get("overrides", {}))
    return updated


def _apply_candidate(
    candidate: Mapping[str, Any],
    *,
    base_document: Mapping[str, Any],
    config_path: Path = CONFIG_FILE,
) -> None:
    save_strategy_config(
        _candidate_document(candidate, base_document=base_document),
        config_path,
    )


def start_experiment(
    *,
    plan_path: Path = PLAN_FILE,
    state_path: Path = STATE_FILE,
    config_path: Path = CONFIG_FILE,
    archive_path: Path = ARCHIVE_FILE,
) -> dict[str, Any]:
    existing = load_state(state_path)
    if existing.get("enabled"):
        return existing
    plan = _plan(plan_path)
    experiment_plan = plan["experiment_plan"]
    schedule = list(experiment_plan["schedule"])
    candidates = _candidate_map(plan)
    if not schedule or any(item not in candidates for item in schedule):
        raise ValueError("experiment plan contains an invalid candidate schedule")
    original = load_strategy_config(config_path, strict=True).to_dict()
    state = {
        "version": 2,
        "phase_policy_version": PHASE_POLICY_VERSION,
        "enabled": True,
        "experiment_id": str(experiment_plan["id"]),
        "started_at": _now(),
        "schedule": schedule,
        "schedule_index": 0,
        "candidate_id": str(schedule[0]),
        "block_id": f"{experiment_plan['id']}-0001",
        "block_started_at": _now(),
        "block_ticks": 0,
        "readiness_samples_collected": 0,
        "warmup_samples_collected": 0,
        "measurement_samples_collected": 0,
        "block_outcomes": 0,
        "warmup_samples": int(experiment_plan.get("warmup_samples", 24)),
        "measurement_samples": int(experiment_plan.get("measurement_samples", 240)),
        "minimum_outcomes": int(experiment_plan.get("minimum_outcomes", 20)),
        "max_measurement_samples": int(experiment_plan.get("max_measurement_samples", 720)),
        "max_readiness_samples": int(experiment_plan.get("max_readiness_samples", DEFAULT_MAX_READINESS_SAMPLES)),
        "plan_path": str(plan_path.resolve()),
        "archive_path": str(archive_path.resolve()),
        "config_path": str(config_path.resolve()),
        "original_config": original,
        "completed_blocks": [],
    }
    _apply_candidate(candidates[state["candidate_id"]], base_document=original, config_path=config_path)
    _save_state(state, state_path)
    return state


def _pause_experiment(
    state: dict[str, Any],
    state_path: Path,
    *,
    reason: str,
) -> None:
    if state.get("original_config"):
        save_strategy_config(
            state["original_config"],
            Path(str(state.get("config_path", CONFIG_FILE))),
        )
    state["enabled"] = False
    state["paused"] = True
    state["paused_at"] = _now()
    state["pause_reason"] = reason
    _save_state(state, state_path)


def _advance_experiment(
    record: Mapping[str, Any],
    state: dict[str, Any],
    state_path: Path,
    *,
    archive_path: Path = ARCHIVE_FILE,
) -> None:
    state["block_ticks"] = int(state.get("block_ticks", 0)) + 1
    sample = record.get("sample", {})
    phase = str(record.get("block_phase", "readiness"))
    if phase == "readiness":
        state["readiness_samples_collected"] = int(
            state.get("readiness_samples_collected", 0)
        ) + 1
        max_readiness = int(
            state.get("max_readiness_samples", DEFAULT_MAX_READINESS_SAMPLES)
        )
        if max_readiness > 0 and state["readiness_samples_collected"] >= max_readiness:
            _pause_experiment(
                state,
                state_path,
                reason="stable_composition_unavailable",
            )
            return
    elif phase == "warmup":
        state["warmup_samples_collected"] = int(
            state.get("warmup_samples_collected", 0)
        ) + 1
    elif _measurement_eligible(record):
        state["measurement_samples_collected"] = int(
            state.get("measurement_samples_collected", 0)
        ) + 1
        state["block_outcomes"] = int(state.get("block_outcomes", 0)) + int(
            sample.get("harvest_successes", 0) or 0
        ) + int(sample.get("deposit_successes", 0) or 0)
    measurement = int(state.get("measurement_samples", 240))
    max_measurement = int(state.get("max_measurement_samples", 720))
    measured = int(state.get("measurement_samples_collected", 0))
    enough = measured >= measurement and int(state["block_outcomes"]) >= int(state.get("minimum_outcomes", 20))
    forced = measured >= max_measurement
    if not (enough or forced):
        _save_state(state, state_path)
        return
    records = [
        item for item in load_records(archive_path)
        if item.get("block_id") == state.get("block_id")
        and _measurement_eligible(item)
    ]
    result = {
        "candidate_id": state["candidate_id"],
        "block_id": state["block_id"],
        "started_at": state.get("block_started_at"),
        "completed_at": _now(),
        "forced_by_max_samples": forced and not enough,
        **_record_metrics(records),
    }
    state.setdefault("completed_blocks", []).append(result)
    schedule_index = int(state.get("schedule_index", 0)) + 1
    state["schedule_index"] = schedule_index
    schedule = state.get("schedule", [])
    if schedule_index >= len(schedule):
        state["enabled"] = False
        state["completed_at"] = _now()
        state["candidate_results"] = _candidate_results(
            load_records(archive_path),
            experiment_id=str(state.get("experiment_id", "")),
        )
        state["selected_candidate"] = _select_best(state["candidate_results"])
        config_path = Path(str(state.get("config_path", CONFIG_FILE)))
        save_strategy_config(state["original_config"], config_path)
        _save_state(state, state_path)
        return
    next_candidate = str(schedule[schedule_index])
    plan_path = Path(str(state.get("plan_path", PLAN_FILE)))
    config_path = Path(str(state.get("config_path", CONFIG_FILE)))
    plan = _plan(plan_path)
    candidates = _candidate_map(plan)
    _apply_candidate(
        candidates[next_candidate],
        base_document=state["original_config"],
        config_path=config_path,
    )
    state.update({
        "candidate_id": next_candidate,
        "block_id": f"{state['experiment_id']}-{schedule_index + 1:04d}",
        "block_started_at": _now(),
        "block_ticks": 0,
        "readiness_samples_collected": 0,
        "warmup_samples_collected": 0,
        "measurement_samples_collected": 0,
        "block_outcomes": 0,
    })
    _save_state(state, state_path)


def _select_best(results: Sequence[Mapping[str, Any]]) -> str | None:
    eligible = [
        item for item in results
        if CONFIDENCE_RANK.get(str(item.get("confidence", "low")), 0) >= 1
        and bool(item.get("viable"))
    ]
    if not eligible:
        return None
    return str(
        max(
            eligible,
            key=lambda item: (
                float(item.get("throughput_per_worker", 0.0)),
                float(item.get("harvest_per_worker", 0.0)),
                float(item.get("utilization", 0.0)),
                float(item.get("score", 0.0)),
                int(item.get("sample_count", 0)),
            ),
        ).get("candidate_id")
    )


def _candidate_results(
    records: Sequence[Mapping[str, Any]],
    *,
    experiment_id: str | None = None,
) -> list[dict[str, Any]]:
    grouped: dict[str, list[Mapping[str, Any]]] = {}
    for record in records:
        if _measurement_eligible(record) and (
            experiment_id is None
            or str(record.get("experiment_id", "")) == experiment_id
        ):
            grouped.setdefault(str(record.get("candidate_id", "")), []).append(record)
    return [
        {"candidate_id": candidate, **_record_metrics(items)}
        for candidate, items in sorted(grouped.items())
        if candidate
    ]


def status(*, state_path: Path = STATE_FILE) -> dict[str, Any]:
    state = load_state(state_path)
    archive_path = Path(str(state.get("archive_path", ARCHIVE_FILE)))
    records = load_records(archive_path)
    experiment_id = str(state.get("experiment_id", ""))
    by_candidate: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        if _measurement_eligible(record) and (
            not experiment_id
            or str(record.get("experiment_id", "")) == experiment_id
        ):
            by_candidate.setdefault(str(record.get("candidate_id", "published-default")), []).append(record)
    state["archive_records"] = len(records)
    state["experiment_records"] = sum(len(items) for items in by_candidate.values())
    state["candidate_metrics"] = {
        candidate: _record_metrics(items) for candidate, items in by_candidate.items()
    }
    return state


def reconcile_state(
    *,
    state_path: Path = STATE_FILE,
    archive_path: Path | None = None,
) -> dict[str, Any]:
    """Rebuild active block counters from deduplicated archived Tick records."""
    state = load_state(state_path)
    path = archive_path or Path(str(state.get("archive_path", ARCHIVE_FILE)))
    current_block = str(state.get("block_id", ""))
    records = [item for item in load_records(path) if item.get("block_id") == current_block]
    readiness = [item for item in records if item.get("block_phase") == "readiness"]
    warmup = [item for item in records if item.get("block_phase") == "warmup"]
    measured = [item for item in records if _measurement_eligible(item)]
    state["block_ticks"] = len(records)
    state["readiness_samples_collected"] = len(readiness)
    state["warmup_samples_collected"] = len(warmup)
    state["measurement_samples_collected"] = len(measured)
    state["block_outcomes"] = int(sum(
        int(item.get("harvest_successes", 0) or 0)
        + int(item.get("deposit_successes", 0) or 0)
        for item in measured
    ))
    if records:
        latest = records[-1]
        state["last_record_key"] = (
            f"{latest.get('block_id', '')}:{latest.get('tick', 0)}:"
            f"{latest.get('parameter_id', '')}"
        )
    _save_state(state, state_path)
    return state


def restart_current_block(
    *,
    state_path: Path = STATE_FILE,
) -> dict[str, Any]:
    """Start the active candidate in a fresh block without deleting telemetry."""
    state = load_state(state_path)
    if not state.get("enabled"):
        raise ValueError("no active experiment to restart")
    restart = int(state.get("block_restart", 1)) + 1
    state["version"] = 2
    state["phase_policy_version"] = PHASE_POLICY_VERSION
    state["block_restart"] = restart
    state["block_id"] = (
        f"{state['experiment_id']}-{int(state.get('schedule_index', 0)) + 1:04d}"
        f"-r{restart}"
    )
    state["block_started_at"] = _now()
    state["block_ticks"] = 0
    state["readiness_samples_collected"] = 0
    state["warmup_samples_collected"] = 0
    state["measurement_samples_collected"] = 0
    state["block_outcomes"] = 0
    state.pop("last_record_key", None)
    _save_state(state, state_path)
    return state


def publish_report(
    *,
    plan_path: Path = PLAN_FILE,
    state_path: Path = STATE_FILE,
    archive_path: Path = ARCHIVE_FILE,
) -> dict[str, Any]:
    plan = _plan(plan_path)
    report = _json_copy(plan)
    state = load_state(state_path)
    experiment_id = str(state.get("experiment_id", ""))
    records = load_records(archive_path)
    grouped: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        if _measurement_eligible(record) and (
            not experiment_id
            or str(record.get("experiment_id", "")) == experiment_id
        ):
            grouped.setdefault(str(record.get("candidate_id", "published-default")), []).append(record)
    report["published_at"] = _now()
    report["results"] = [
        {"candidate_id": candidate, **_record_metrics(items)}
        for candidate, items in sorted(grouped.items())
    ]
    report["last_run"] = {
        key: value for key, value in state.items()
        if key in {"experiment_id", "started_at", "completed_at", "selected_candidate", "completed_blocks"}
    }
    plan_path.write_text(json.dumps(report, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    return report


def stop_experiment(*, state_path: Path = STATE_FILE, config_path: Path = CONFIG_FILE) -> dict[str, Any]:
    state = load_state(state_path)
    if state.get("original_config"):
        save_strategy_config(state["original_config"], config_path)
    state["enabled"] = False
    state["stopped_at"] = _now()
    _save_state(state, state_path)
    return state


def record_accepted_turn(turn: Any, memory: Any, config: StrategyConfig) -> None:
    """Best-effort hook called after a successful submission by the tactic."""
    sample = next(
        (item for item in reversed(getattr(memory, "economy_history", [])) if item.get("tick") == turn.tick),
        None,
    )
    if sample is None:
        return
    append_telemetry(
        sample,
        config,
        composition={
            "workers": len(getattr(turn, "workers", ())),
            "vanguards": len(getattr(turn, "vanguards", ())),
            "rangers": len(getattr(turn, "rangers", ())),
        },
        posture=str(getattr(memory, "last_posture", "UNKNOWN")),
        threat_score=float(getattr(memory, "last_threat_score", 0.0)),
        worker_losses=int(getattr(memory, "worker_losses", 0)),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=("start", "status", "reconcile", "restart", "stop", "publish"),
    )
    args = parser.parse_args()
    if args.command == "start":
        result = start_experiment()
    elif args.command == "status":
        result = status()
    elif args.command == "reconcile":
        result = reconcile_state()
    elif args.command == "restart":
        result = restart_current_block()
    elif args.command == "stop":
        result = stop_experiment()
    else:
        result = publish_report()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

"""Arena Hero tactic balancing economic growth with fleet survival.

The default `economy` profile uses one shared threat assessment to switch the
whole fleet between ECONOMY, GUARDED, and SURVIVAL postures. Workers run a
harvest-return-deposit loop with unique resource assignments and sector-based
scouting. Vanguards explore near the Core early instead of chasing the public
Beacon. Rangers split between Core guard and outer patrol, while safe Core
migration is allowed only when it cannot interrupt cargo delivery.

Set `TACTIC_PROFILE=balanced` only to A/B test the retained legacy economy
layer. Combat roles, Beacon restraint, threat posture, and Core safety remain
shared.
"""

from __future__ import annotations

import json
import os
import time
from collections import Counter, deque
from dataclasses import dataclass, field
from getpass import getpass
from pathlib import Path
from typing import Iterable
from uuid import UUID

from arena_hero import (
    APIError,
    ArenaHeroClient,
    AuthenticationError,
    BeaconStatus,
    ConfigurationError,
    CoreState,
    Direction,
    HarvestSource,
    TransportError,
    Turn,
    UnitType,
    unit_cost,
)

from ..dashboard.state import write_dashboard_state
from ..runtime.version_monitor import (
    DEFAULT_MARKER_PATH,
    DEFAULT_REPORT_PATH,
    compatibility_hold_active,
    run_check as run_version_check,
)
from ..training.experiment import (
    active_block_id,
    ensure_active_experiment_config,
    record_accepted_turn,
)
from ..runtime.process_lock import InstanceAlreadyRunning, SingleInstanceLock
from ..configuration.strategy import StrategyConfig, load_strategy_config
from ..training.dataset import record_accepted_turn as record_training_turn
from ..runtime.paths import (
    DASHBOARD_STATE_FILE,
    ENV_FILE,
    STATE_FILE,
    TACTIC_LOCK_FILE,
)

Position = tuple[int, int]


def _dotenv_values() -> dict[str, str]:
    env_file = ENV_FILE
    if not env_file.is_file():
        return {}

    values: dict[str, str] = {}
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
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
        "“": "",
        "”": "",
        "‘": "",
        "’": "",
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


# --------------------------------------------------------------------------
# Profile switch
# --------------------------------------------------------------------------
TACTIC_PROFILE = _setting("TACTIC_PROFILE", "economy").strip().lower()
if TACTIC_PROFILE not in {"economy", "balanced"}:
    raise SystemExit("TACTIC_PROFILE must be either 'economy' or 'balanced'")
ECONOMY_MODE = TACTIC_PROFILE != "balanced"
DEBUG_TURNS = _setting("TACTIC_DEBUG", "1").strip().lower() not in {
    "0",
    "false",
    "off",
    "",
}
# --------------------------------------------------------------------------
# Tunables
# --------------------------------------------------------------------------
DIRECTION_ORDER = (
    Direction.UP,
    Direction.RIGHT,
    Direction.DOWN,
    Direction.LEFT,
)
DEFENSE_RADIUS = 6
EXPLORATION_RADIUS = 7
EXPLORATION_TICKS_PER_WAYPOINT = 10
STAGING_RADIUS = 2


# Economy
RETURN_TRIP_WEIGHT = 1.0  # every outbound step also needs a reliable trip home
REMEMBERED_NODE_PENALTY = 2.0  # unseen (remembered) nodes are less trustworthy
STICKY_TARGET_BONUS = 1.5  # avoid target flip-flopping between ticks
ADAPTIVE_HISTORY_LIMIT = 256


# Spawning / reserves
BASE_RESOURCE_RESERVE = 5 if ECONOMY_MODE else 2
THREAT_RESOURCE_RESERVE = 4
ECONOMY_RUSH_TICKS = 60
EARLY_WORKER_TARGET = 6

def _unit_cost(turn: Turn, unit_type: UnitType) -> int:
    state = getattr(turn, "state", None)
    population = getattr(state, "population", None)
    if not isinstance(population, int):
        population = len(getattr(turn, "units", ()))
    return int(unit_cost(unit_type, max(0, population)))
UNIT_MAX_HP = {
    UnitType.WORKER: 2,
    UnitType.VANGUARD: 4,
    UnitType.RANGER: 2,
}
UNIT_TARGETS = {
    UnitType.WORKER: 8 if ECONOMY_MODE else 7,
    UnitType.VANGUARD: 6,
    UnitType.RANGER: 5,
}

# Pathing / exploration
PATH_NODE_LIMIT = 20000
PATH_MAX_DISTANCE = 192
OSCILLATION_WINDOW = 4
SCOUT_TARGET_MAX_TICKS = 96
STALE_VISIBILITY_TICKS = 48
STALE_PATROL_TARGET_LIMIT = 64
MAP_MARGIN = 14
ECONOMY_MIN_RECOVERY_RADIUS = 64
VIEW_RADIUS_CORE = 5
VIEW_RADIUS_WORKER = 3
VIEW_RADIUS_VANGUARD = 4
VIEW_RADIUS_RANGER = 5
SCARCITY_EXPEDITION_MIN_STEP = 8
SCARCITY_EXPEDITION_LOW_GAIN = 1.0

# The server contract can change independently of the local tactic process.
# Keep the check outside Turn planning and fail closed for unattended runners.
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
# Safety (worker preservation)
SAFETY_ENABLED = _setting("TACTIC_SAFETY", "1").strip().lower() not in {
    "0",
    "false",
    "off",
    "no",
    "",
}
ENEMY_DANGER_RADII = {UnitType.RANGER: 4, UnitType.VANGUARD: 3}
DEFAULT_ENEMY_DANGER_RADIUS = 3
UNSAFE_SCORE = 0.8  # danger score at/above which a cell is off-limits to workers
REMEMBERED_THREAT_TICKS = 25  # how long an enemy sighting keeps a cell scary
REMEMBERED_THREAT_WEIGHT = 0.5  # remembered threats weigh less than visible ones
DANGER_NODE_PENALTY = 6.0  # extra cost for mining a node inside a threatened area
WORKER_RETREAT_HP_RATIO = 0.6  # run home below this share of peak HP
WORKER_FLEE_SEARCH_RADIUS = 6  # BFS radius used when looking for a safe tile


WORKER_GUARD_RADIUS = 4  # defenders react to enemies this close to any worker
WORKER_LOSS_PAUSE_TICKS = 30  # pause the economy rush after losing a worker
MIN_DEFENDERS_UNDER_THREAT = 2  # buy defenders before more workers when pressured
SURVIVAL_DEFENDER_TARGET = 3


POSTURE_ECONOMY = "ECONOMY"
POSTURE_GUARDED = "GUARDED"
POSTURE_SURVIVAL = "SURVIVAL"

PHASE_EARLY = "EARLY"
PHASE_MID = "MID"
PHASE_LATE = "LATE"


COMBAT_PATROL_RADIUS = 16
CORE_RING_GUARD_COUNT = 2
CORE_RING_RADIUS = 6
ENEMY_LOST_SEARCH_TICKS = 12
ENEMY_TRACK_TTL = 40
ENEMY_SEARCH_RADIUS = 4
WORKER_BLOCK_RADIUS = 6
MAX_WORKER_BLOCKERS = 2
EMERGENCY_RANGER_CAP = 6


CORE_MIGRATION_ENABLED = _setting("TACTIC_CORE_MIGRATION", "1").strip().lower() not in {
    "0",
    "false",
    "off",
    "no",
    "",
}






EXPLORATION_OFFSETS = (
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
    (0, -1),
    (1, -1),
)


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------
def _uuid_key(value: UUID | str) -> bytes:
    return value.bytes if isinstance(value, UUID) else UUID(str(value)).bytes


def _chunk_position(position: Position) -> Position:
    return position[0] // 32, position[1] // 32


def _chunk_center(chunk: Position) -> Position:
    return chunk[0] * 32 + 15, chunk[1] * 32 + 15


def _distance(left: Position, right: Position) -> int:
    return abs(left[0] - right[0]) + abs(left[1] - right[1])


def _step(position: Position, direction: Direction) -> Position:
    dx, dy = direction.delta
    return position[0] + dx, position[1] + dy


def _neighbors(position: Position) -> tuple[Position, ...]:
    x, y = position
    return ((x, y - 1), (x + 1, y), (x, y + 1), (x - 1, y))


def _direction_between(source: Position, destination: Position) -> Direction:
    delta = destination[0] - source[0], destination[1] - source[1]
    for direction in DIRECTION_ORDER:
        if direction.delta == delta:
            return direction
    raise ValueError("positions are not cardinally adjacent")


def _supercover_cells(source: Position, target: Position) -> list[Position]:
    x, y = source
    delta_x = target[0] - x
    delta_y = target[1] - y
    count_x = abs(delta_x)
    count_y = abs(delta_y)
    step_x = 0 if delta_x == 0 else (1 if delta_x > 0 else -1)
    step_y = 0 if delta_y == 0 else (1 if delta_y > 0 else -1)
    index_x = 0
    index_y = 0
    cells: list[Position] = []

    while index_x < count_x or index_y < count_y:
        decision = (1 + 2 * index_x) * count_y - (1 + 2 * index_y) * count_x
        if decision == 0:
            cells.append((x + step_x, y))
            cells.append((x, y + step_y))
            x += step_x
            y += step_y
            index_x += 1
            index_y += 1
            cells.append((x, y))
        elif decision < 0:
            x += step_x
            index_x += 1
            cells.append((x, y))
        else:
            y += step_y
            index_y += 1
            cells.append((x, y))

    return cells


def _has_line_of_sight(
    source: Position,
    target: Position,
    obstacles: set[Position],
) -> bool:
    return all(
        cell == target or cell not in obstacles
        for cell in _supercover_cells(source, target)
    )


def _viewers(turn: Turn) -> list[tuple[Position, int]]:
    viewers: list[tuple[Position, int]] = []
    if turn.core is not None:
        viewers.append((turn.core.position, VIEW_RADIUS_CORE))
    viewers.extend((worker.position, VIEW_RADIUS_WORKER) for worker in turn.workers)
    viewers.extend((unit.position, VIEW_RADIUS_VANGUARD) for unit in turn.vanguards)
    viewers.extend((unit.position, VIEW_RADIUS_RANGER) for unit in turn.rangers)
    return viewers



def _visible_cells(turn: Turn, obstacles: set[Position]) -> set[Position]:
    """All cells currently observed by friendly units (used to build the map)."""
    seen: set[Position] = set()
    for (origin_x, origin_y), radius in _viewers(turn):
        for dx in range(-radius, radius + 1):
            span = radius - abs(dx)
            for dy in range(-span, span + 1):
                cell = (origin_x + dx, origin_y + dy)
                if cell in seen:
                    continue
                if _has_line_of_sight((origin_x, origin_y), cell, obstacles):
                    seen.add(cell)
    return seen


def _unit_type_of(unit: object) -> UnitType | None:
    unit_type = getattr(unit, "unit_type", None)
    if isinstance(unit_type, UnitType):
        return unit_type
    if isinstance(unit_type, str):
        try:
            return UnitType(unit_type.upper())
        except ValueError:
            return None
    return None


def _enemy_danger_radius(enemy: object) -> int | None:
    if str(getattr(enemy, "kind", "") or "").upper() == "CORE":
        return None
    unit_type = _unit_type_of(enemy)
    if unit_type is UnitType.WORKER:
        return None
    if unit_type is not None:
        return ENEMY_DANGER_RADII.get(unit_type)
    return DEFAULT_ENEMY_DANGER_RADIUS


# --------------------------------------------------------------------------
# Memory
# --------------------------------------------------------------------------
@dataclass
class EnemyTrack:
    position: Position
    previous_position: Position | None
    first_seen_tick: int
    last_seen_tick: int
    missing_since_tick: int | None
    kind: str
    unit_type: UnitType | None
    hp: int


@dataclass
class TacticMemory:
    owner_username: str | None = None
    resource_hints: set[Position] = field(default_factory=set)
    obstacle_cells: set[Position] = field(default_factory=set)
    worker_targets: dict[UUID, Position] = field(default_factory=dict)
    scout_targets: dict[UUID, Position] = field(default_factory=dict)
    scout_target_started: dict[UUID, int] = field(default_factory=dict)
    worker_sectors: dict[UUID, int] = field(default_factory=dict)
    combat_targets: dict[UUID, Position] = field(default_factory=dict)
    combat_target_started: dict[UUID, int] = field(default_factory=dict)
    combat_sectors: dict[UUID, int] = field(default_factory=dict)
    guard_targets: dict[UUID, Position] = field(default_factory=dict)
    guard_sectors: dict[UUID, int] = field(default_factory=dict)
    worker_block_targets: dict[UUID, Position] = field(default_factory=dict)
    guard_ranger_ids: set[UUID] = field(default_factory=set)
    pursuit_unit_ids: set[UUID] = field(default_factory=set)
    known_cells: set[Position] = field(default_factory=set)
    visited_cells: Counter[Position] = field(default_factory=Counter)
    cell_last_seen: dict[Position, int] = field(default_factory=dict)
    resource_chunks: set[Position] = field(default_factory=set)
    recent_positions: dict[UUID, deque[Position]] = field(default_factory=dict)
    bounds: tuple[int, int, int, int] | None = None
    planned_deposited: int = 0
    planned_deposit_this_turn: int = 0
    resource_radius_limit: int | None = None
    effective_resource_radius: int | None = None
    resource_candidate_count: int = 0
    resource_assignment_count: int = 0
    scouting_worker_ticks: int = 0
    worker_ticks: int = 0
    turns_seen: int = 0
    first_tick: int | None = None
    last_tick: int = 0
    enemy_sightings: dict[Position, int] = field(default_factory=dict)
    enemy_tracks: dict[UUID, EnemyTrack] = field(default_factory=dict)
    tracker_assignments: dict[UUID, UUID] = field(default_factory=dict)
    peak_hp: dict[UUID, int] = field(default_factory=dict)
    peak_hp_by_type: dict[UnitType, int] = field(default_factory=dict)
    living_worker_ids: set[UUID] = field(default_factory=set)
    last_worker_loss_tick: int | None = None
    worker_losses: int = 0
    fleeing_worker_ticks: int = 0
    last_posture: str = POSTURE_ECONOMY
    last_threat_score: float = 0.0
    last_core_damage_tick: int | None = None
    last_core_move_tick: int | None = None
    planned_population_relief: int = 0
    population_relief_worker_ids: set[UUID] = field(default_factory=set)

    economy_history: list[dict[str, int]] = field(default_factory=list)
    worker_cycle_started: dict[UUID, int] = field(default_factory=dict)
    cycle_durations: list[int] = field(default_factory=list)
    adaptive_radius_delta: int = 0
    adaptive_scout_bonus: int = 0
    adaptive_worker_target: int | None = None
    adaptive_worker_base_target: int | None = None
    adaptive_last_adjust_tick: int | None = None
    adaptive_action: str = "WARMUP"
    adaptive_reason: str = "collecting economy samples"
    adaptive_throughput: float = 0.0
    adaptive_utilization: float = 0.0
    adaptive_failure_rate: float = 0.0
    adaptive_average_cycle_ticks: float = 0.0
    adaptive_storage_full_ratio: float = 0.0
    adaptive_new_cells_per_scout: float = 0.0
    adaptive_sample_count: int = 0
    adaptive_scarcity_streak: int = 0
    economy_experiment_block_id: str | None = None

    def sync_economy_experiment(self, block_id: str | None) -> bool:
        """Reset candidate-sensitive learning when the experiment block changes."""
        if block_id == self.economy_experiment_block_id:
            return False
        self.economy_experiment_block_id = block_id
        self.economy_history.clear()
        self.worker_cycle_started.clear()
        self.cycle_durations.clear()
        self.adaptive_radius_delta = 0
        self.adaptive_scout_bonus = 0
        self.adaptive_worker_target = None
        self.adaptive_worker_base_target = None
        self.adaptive_last_adjust_tick = None
        self.adaptive_action = "WARMUP"
        self.adaptive_reason = "collecting_samples"
        self.adaptive_throughput = 0.0
        self.adaptive_utilization = 0.0
        self.adaptive_failure_rate = 0.0
        self.adaptive_average_cycle_ticks = 0.0
        self.adaptive_storage_full_ratio = 0.0
        self.adaptive_new_cells_per_scout = 0.0
        self.adaptive_sample_count = 0
        self.adaptive_scarcity_streak = 0
        return True

    def observe(self, turn: Turn) -> None:
        owner_username = (
            getattr(turn.core, "owner_username", None)
            if turn.core is not None
            else None
        )
        # A lower Tick means a new world epoch. Old targets and threat sightings
        # must not pull workers around stale coordinates.
        if self.last_tick and turn.tick < self.last_tick:
            self._reset_for_owner(owner_username or self.owner_username)

        if (
            owner_username is not None
            and self.owner_username is not None
            and owner_username != self.owner_username
        ):
            self._reset_for_owner(owner_username)
        elif owner_username is not None:
            self.owner_username = owner_username
        previous_resource_candidates = self.resource_candidate_count
        previous_resource_assignments = self.resource_assignment_count
        previous_scouts = len(self.scout_targets)
        is_new_tick = turn.tick != self.last_tick


        if turn.tick != self.last_tick:
            self.turns_seen += 1
            if self.first_tick is None:
                self.first_tick = turn.tick
        self.last_tick = turn.tick
        self.planned_deposit_this_turn = 0
        self.planned_population_relief = 0
        self.population_relief_worker_ids.clear()
        self.worker_block_targets.clear()
        self.guard_ranger_ids.clear()
        self.pursuit_unit_ids.clear()
        self.resource_radius_limit = None
        self.effective_resource_radius = None
        self.resource_candidate_count = 0
        self.resource_assignment_count = 0
        current_resources = set(turn.resource_cells)
        self.obstacle_cells.update(turn.obstacle_cells)
        self.resource_hints.update(current_resources)
        self.resource_chunks.update(_chunk_position(cell) for cell in current_resources)

        known_cells_before = len(self.known_cells)
        visible = _visible_cells(turn, self.obstacle_cells)
        for cell in visible:
            self.cell_last_seen[cell] = turn.tick
        self.known_cells.update(visible)
        self.known_cells.update(self.obstacle_cells)
        self.known_cells.update(current_resources)
        self.known_cells.update(unit.position for unit in turn.units)
        if turn.core is not None:
            self.known_cells.add(turn.core.position)
        new_known_cells = len(self.known_cells) - known_cells_before

        for event in turn.events:
            if (
                event.event_type == "CORE_DAMAGED"
                and event.reason_code == "ATTACK"
            ):
                self.last_core_damage_tick = event.tick
            elif event.event_type in {
                "CORE_MOVE_STARTED",
                "CORE_MOVE_SUCCEEDED",
                "CORE_MOVE_FAILED",
                "CORE_MOVE_CANCELLED",
            }:
                self.last_core_move_tick = event.tick

            position = getattr(event, "position", None)
            if position is None:
                continue
            if event.event_type == "WORKER_CARGO_DROPPED":
                self.resource_hints.add(position)
                continue
            if position in current_resources:
                continue
            if (
                event.event_type == "HARVEST_SUCCEEDED"
                and getattr(event, "harvest_source", None) is HarvestSource.RESOURCE_NODE
            ):
                self.resource_hints.discard(position)
            elif (
                event.event_type == "HARVEST_FAILED"
                and event.reason_code in {"RESOURCE_DEPLETED", "NOT_RESOURCE_CELL"}
            ):
                self.resource_hints.discard(position)

        # A remembered coordinate that is currently visible but not a resource
        # is unavailable now. Future quota refills are rediscovered by patrols.
        for position in tuple(self.resource_hints - current_resources):
            if position in visible:
                self.resource_hints.discard(position)

        living = {unit.id for unit in turn.units}
        self.worker_targets = {
            worker_id: target
            for worker_id, target in self.worker_targets.items()
            if worker_id in living and target in self.resource_hints
        }
        self.scout_targets = {
            worker_id: target
            for worker_id, target in self.scout_targets.items()
            if worker_id in living and target not in self.obstacle_cells
        }
        self.scout_target_started = {
            worker_id: started
            for worker_id, started in self.scout_target_started.items()
            if worker_id in self.scout_targets
        }
        self.worker_sectors = {
            worker_id: sector
            for worker_id, sector in self.worker_sectors.items()
            if worker_id in living and 0 <= sector < len(EXPLORATION_OFFSETS)
        }
        self.combat_targets = {
            unit_id: target
            for unit_id, target in self.combat_targets.items()
            if unit_id in living and target not in self.obstacle_cells
        }
        self.combat_target_started = {
            unit_id: started
            for unit_id, started in self.combat_target_started.items()
            if unit_id in self.combat_targets
        }
        self.combat_sectors = {
            unit_id: sector
            for unit_id, sector in self.combat_sectors.items()
            if unit_id in living and 0 <= sector < len(EXPLORATION_OFFSETS)
        }
        ranger_ids = {ranger.id for ranger in turn.rangers}
        self.guard_targets = {
            ranger_id: target
            for ranger_id, target in self.guard_targets.items()
            if ranger_id in ranger_ids and target not in self.obstacle_cells
        }
        self.guard_sectors = {
            ranger_id: sector
            for ranger_id, sector in self.guard_sectors.items()
            if ranger_id in ranger_ids and sector in {0, 1}
        }
        self.recent_positions = {
            unit_id: trail
            for unit_id, trail in self.recent_positions.items()
            if unit_id in living
        }
        for unit in turn.units:
            trail = self.recent_positions.setdefault(
                unit.id, deque(maxlen=OSCILLATION_WINDOW)
            )
            trail.append(unit.position)
            self.visited_cells[unit.position] += 1
            if self.scout_targets.get(unit.id) == unit.position:
                self.scout_targets.pop(unit.id, None)
                self.scout_target_started.pop(unit.id, None)
            if self.combat_targets.get(unit.id) == unit.position:
                self.combat_targets.pop(unit.id, None)
                self.combat_target_started.pop(unit.id, None)

        if is_new_tick:
            self._observe_economy(
                turn,
                previous_resource_candidates,
                previous_resource_assignments,
                previous_scouts,
                new_known_cells,
            )

        self._observe_threats(turn)
        self.bounds = self._compute_bounds(turn)

    def begin_worker_cycle(self, worker_id: UUID, tick: int) -> None:
        self.worker_cycle_started.setdefault(worker_id, tick)

    @staticmethod
    def _event_resource_amount(event: object) -> int:
        amount = getattr(event, "resource_amount", None)
        if callable(amount):
            amount = amount()
        if amount is None:
            values = getattr(event, "values", None) or {}
            amount = values.get("amount", 0)
        try:
            return max(0, int(amount))
        except (TypeError, ValueError):
            return 0

    def _observe_economy(
        self,
        turn: Turn,
        previous_resource_candidates: int,
        previous_resource_assignments: int,
        previous_scouts: int,
        new_known_cells: int,
    ) -> None:
        deposited = 0
        harvested = 0
        harvest_successes = 0
        harvest_failures = 0
        deposit_successes = 0
        deposit_full = 0

        for event in turn.events:
            event_type = getattr(event, "event_type", "")
            actor_id = getattr(event, "actor_id", None)
            if actor_id is not None and not isinstance(actor_id, UUID):
                try:
                    actor_id = UUID(str(actor_id))
                except ValueError:
                    actor_id = None

            if event_type == "HARVEST_SUCCEEDED":
                harvested += self._event_resource_amount(event)
                harvest_successes += 1
                if actor_id is not None:
                    self.worker_cycle_started.setdefault(actor_id, max(0, turn.tick - 1))
            elif event_type == "HARVEST_FAILED":
                harvest_failures += 1
            elif event_type == "DEPOSIT_SUCCEEDED":
                deposited += self._event_resource_amount(event)
                deposit_successes += 1
                if actor_id is not None:
                    started = self.worker_cycle_started.pop(actor_id, None)
                    if started is not None:
                        self.cycle_durations.append(max(1, turn.tick - started))
            elif (
                event_type == "DEPOSIT_FAILED"
                and getattr(event, "reason_code", None) == "CORE_RESOURCE_FULL"
            ):
                deposit_full += 1

        living_workers = {worker.id for worker in turn.workers}
        self.worker_cycle_started = {
            worker_id: started
            for worker_id, started in self.worker_cycle_started.items()
            if worker_id in living_workers
        }
        self.cycle_durations = self.cycle_durations[-ADAPTIVE_HISTORY_LIMIT:]

        worker_count = len(turn.workers)
        carrying = sum(1 for worker in turn.workers if worker.cargo > 0)
        busy = min(
            worker_count,
            previous_resource_assignments
            + previous_scouts
            + carrying
            + harvest_successes
            + deposit_successes,
        )
        sample = {
            "tick": int(turn.tick),
            "workers": worker_count,
            "deposited": deposited,
            "harvested": harvested,
            "harvest_successes": harvest_successes,
            "harvest_failures": harvest_failures,
            "deposit_successes": deposit_successes,
            "deposit_full": deposit_full,
            "candidates": max(0, previous_resource_candidates),
            "assignments": max(0, previous_resource_assignments),
            "scouts": max(0, previous_scouts),
            "busy": busy,
            "storage_full": int(getattr(turn, "resource_space", 0) <= 0),
            "new_cells": max(0, new_known_cells),
        }
        if self.economy_history and self.economy_history[-1].get("tick") == turn.tick:
            self.economy_history[-1] = sample
        else:
            self.economy_history.append(sample)
        self.economy_history = self.economy_history[-ADAPTIVE_HISTORY_LIMIT:]


    def _observe_threats(self, turn: Turn) -> None:
        """Update persistent enemy tracks, loss search, and friendly health."""
        visible_enemy_ids: set[UUID] = set()
        for enemy in turn.visible_enemies:
            enemy_id = getattr(enemy, "id", None)
            if not isinstance(enemy_id, UUID):
                try:
                    enemy_id = UUID(str(enemy_id))
                except (TypeError, ValueError):
                    enemy_id = None
            if enemy_id is not None:
                visible_enemy_ids.add(enemy_id)
                previous = self.enemy_tracks.get(enemy_id)
                raw_hp = getattr(enemy, "hp", 1)
                try:
                    hp = max(1, int(raw_hp))
                except (TypeError, ValueError):
                    hp = 1
                self.enemy_tracks[enemy_id] = EnemyTrack(
                    position=enemy.position,
                    previous_position=previous.position if previous is not None else None,
                    first_seen_tick=(
                        previous.first_seen_tick if previous is not None else turn.tick
                    ),
                    last_seen_tick=turn.tick,
                    missing_since_tick=None,
                    kind=str(getattr(enemy, "kind", "UNIT") or "UNIT").upper(),
                    unit_type=_unit_type_of(enemy),
                    hp=hp,
                )
            if _enemy_danger_radius(enemy) is not None:
                self.enemy_sightings[enemy.position] = turn.tick

        for enemy_id, track in tuple(self.enemy_tracks.items()):
            if enemy_id in visible_enemy_ids:
                continue
            if track.missing_since_tick is None:
                track.missing_since_tick = turn.tick
            age = turn.tick - track.last_seen_tick
            search_age = turn.tick - track.missing_since_tick
            search_cells = {
                cell
                for cell in self.known_cells
                if cell not in self.obstacle_cells
                and _distance(cell, track.position) <= ENEMY_SEARCH_RADIUS
            }
            searched_cells = {
                cell
                for cell in search_cells
                if self.cell_last_seen.get(cell, -1) >= track.missing_since_tick
            }
            covered = len(search_cells) >= 8 and searched_cells == search_cells
            if age > ENEMY_TRACK_TTL or search_age >= ENEMY_LOST_SEARCH_TICKS or covered:
                self.enemy_tracks.pop(enemy_id, None)

        living_combat_ids = {
            unit.id for unit in (*turn.vanguards, *turn.rangers)
        }
        self.tracker_assignments = {
            unit_id: enemy_id
            for unit_id, enemy_id in self.tracker_assignments.items()
            if unit_id in living_combat_ids and enemy_id in self.enemy_tracks
        }

        current_worker_ids = {worker.id for worker in turn.workers}
        lost_worker_ids = self.living_worker_ids - current_worker_ids
        if lost_worker_ids:
            self.worker_losses += len(lost_worker_ids)
            self.last_worker_loss_tick = turn.tick
            for event in turn.events:
                target_id = getattr(event, "target_id", None)
                values = getattr(event, "values", None) or {}
                if (
                    event.event_type == "UNIT_DAMAGED"
                    and target_id in lost_worker_ids
                    and values.get("hp") == 0
                    and event.position is not None
                ):
                    self.enemy_sightings[event.position] = turn.tick
        self.living_worker_ids = current_worker_ids

        self.enemy_sightings = {
            cell: tick
            for cell, tick in self.enemy_sightings.items()
            if 0 <= turn.tick - tick <= REMEMBERED_THREAT_TICKS
        }

        living = {unit.id for unit in turn.units}
        for unit in turn.units:
            hp = getattr(unit, "hp", None)
            if not isinstance(hp, int) or hp <= 0:
                continue
            self.peak_hp[unit.id] = max(self.peak_hp.get(unit.id, hp), hp)
            # Units of the same kind share a max HP, so the healthiest one we
            # have ever seen is a good stand-in when the SDK hides max_hp and a
            # unit is first observed already damaged.
            unit_type = _unit_type_of(unit)
            if unit_type is not None:
                self.peak_hp_by_type[unit_type] = max(
                    self.peak_hp_by_type.get(unit_type, hp), hp
                )
        self.peak_hp = {
            unit_id: hp for unit_id, hp in self.peak_hp.items() if unit_id in living
        }

    def recent_worker_loss(self, tick: int) -> bool:
        return (
            self.last_worker_loss_tick is not None
            and 0 <= tick - self.last_worker_loss_tick <= WORKER_LOSS_PAUSE_TICKS
        )

    def _reset_for_owner(self, owner_username: str | None) -> None:
        self.owner_username = owner_username
        self.resource_hints.clear()
        self.obstacle_cells.clear()
        self.worker_targets.clear()
        self.scout_targets.clear()
        self.scout_target_started.clear()
        self.worker_sectors.clear()
        self.combat_targets.clear()
        self.combat_target_started.clear()
        self.combat_sectors.clear()
        self.guard_targets.clear()
        self.guard_sectors.clear()
        self.worker_block_targets.clear()
        self.guard_ranger_ids.clear()
        self.pursuit_unit_ids.clear()
        self.known_cells.clear()
        self.visited_cells.clear()
        self.cell_last_seen.clear()
        self.resource_chunks.clear()
        self.recent_positions.clear()
        self.bounds = None
        self.planned_deposited = 0
        self.planned_deposit_this_turn = 0
        self.planned_population_relief = 0
        self.population_relief_worker_ids.clear()
        self.worker_block_targets.clear()
        self.guard_ranger_ids.clear()
        self.pursuit_unit_ids.clear()
        self.resource_radius_limit = None
        self.effective_resource_radius = None
        self.resource_candidate_count = 0
        self.resource_assignment_count = 0
        self.scouting_worker_ticks = 0
        self.worker_ticks = 0
        self.turns_seen = 0
        self.first_tick = None
        self.last_tick = 0
        self.enemy_sightings.clear()
        self.enemy_tracks.clear()
        self.tracker_assignments.clear()
        self.peak_hp.clear()
        self.peak_hp_by_type.clear()
        self.living_worker_ids.clear()
        self.last_worker_loss_tick = None
        self.worker_losses = 0
        self.fleeing_worker_ticks = 0
        self.last_posture = POSTURE_ECONOMY
        self.last_threat_score = 0.0
        self.last_core_damage_tick = None
        self.last_core_move_tick = None
        self.economy_history.clear()
        self.worker_cycle_started.clear()
        self.cycle_durations.clear()
        self.adaptive_radius_delta = 0
        self.adaptive_scout_bonus = 0
        self.adaptive_worker_target = None
        self.adaptive_worker_base_target = None
        self.adaptive_last_adjust_tick = None
        self.adaptive_action = "WARMUP"
        self.adaptive_reason = "collecting_samples"
        self.adaptive_throughput = 0.0
        self.adaptive_utilization = 0.0
        self.adaptive_failure_rate = 0.0
        self.adaptive_average_cycle_ticks = 0.0
        self.adaptive_storage_full_ratio = 0.0
        self.adaptive_new_cells_per_scout = 0.0
        self.adaptive_sample_count = 0
        self.adaptive_scarcity_streak = 0

    @classmethod
    def load(cls, path: Path) -> TacticMemory:
        if not path.is_file():
            return cls()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("version") not in {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}:
                return cls()
            raw_bounds = data.get("bounds")
            bounds = (
                tuple(int(value) for value in raw_bounds)
                if isinstance(raw_bounds, list) and len(raw_bounds) == 4
                else None
            )
            enemy_tracks: dict[UUID, EnemyTrack] = {}
            for enemy_id, raw_track in data.get("enemy_tracks", {}).items():
                if not isinstance(raw_track, dict):
                    continue
                raw_unit_type = raw_track.get("unit_type")
                enemy_tracks[UUID(enemy_id)] = EnemyTrack(
                    position=tuple(raw_track["position"]),
                    previous_position=(
                        tuple(raw_track["previous_position"])
                        if raw_track.get("previous_position") is not None
                        else None
                    ),
                    first_seen_tick=max(0, int(raw_track.get("first_seen_tick", 0))),
                    last_seen_tick=max(0, int(raw_track.get("last_seen_tick", 0))),
                    missing_since_tick=(
                        max(0, int(raw_track["missing_since_tick"]))
                        if raw_track.get("missing_since_tick") is not None
                        else None
                    ),
                    kind=str(raw_track.get("kind", "UNIT")).upper(),
                    unit_type=UnitType(raw_unit_type) if raw_unit_type else None,
                    hp=max(1, int(raw_track.get("hp", 1))),
                )
            return cls(
                owner_username=data.get("owner_username"),
                resource_hints={tuple(cell) for cell in data.get("resource_hints", [])},
                obstacle_cells={tuple(cell) for cell in data.get("obstacle_cells", [])},
                worker_targets={
                    UUID(worker_id): tuple(target)
                    for worker_id, target in data.get("worker_targets", {}).items()
                },
                scout_targets={
                    UUID(worker_id): tuple(target)
                    for worker_id, target in data.get("scout_targets", {}).items()
                },
                scout_target_started={
                    UUID(worker_id): max(0, int(started))
                    for worker_id, started in data.get(
                        "scout_target_started", {}
                    ).items()
                },
                worker_sectors={
                    UUID(worker_id): int(sector)
                    for worker_id, sector in data.get("worker_sectors", {}).items()
                },
                combat_targets={
                    UUID(unit_id): tuple(target)
                    for unit_id, target in data.get("combat_targets", {}).items()
                },
                combat_target_started={
                    UUID(unit_id): max(0, int(started))
                    for unit_id, started in data.get(
                        "combat_target_started", {}
                    ).items()
                },
                combat_sectors={
                    UUID(unit_id): int(sector)
                    for unit_id, sector in data.get("combat_sectors", {}).items()
                },
                guard_targets={
                    UUID(ranger_id): tuple(target)
                    for ranger_id, target in data.get("guard_targets", {}).items()
                },
                guard_sectors={
                    UUID(ranger_id): int(sector)
                    for ranger_id, sector in data.get("guard_sectors", {}).items()
                },
                known_cells={tuple(cell) for cell in data.get("known_cells", [])},
                visited_cells=Counter(
                    {
                        tuple(cell): max(0, int(count))
                        for cell, count in data.get("visited_cells", [])
                    }
                ),
                cell_last_seen={
                    (int(entry[0]), int(entry[1])): max(0, int(entry[2]))
                    for entry in data.get("cell_last_seen", [])
                    if len(entry) == 3
                },
                resource_chunks={
                    tuple(chunk) for chunk in data.get("resource_chunks", [])
                }
                | {
                    _chunk_position(tuple(cell))
                    for cell in data.get("resource_hints", [])
                },
                bounds=bounds,
                planned_deposited=max(0, int(data.get("planned_deposited", 0))),
                scouting_worker_ticks=max(
                    0, int(data.get("scouting_worker_ticks", 0))
                ),
                worker_ticks=max(0, int(data.get("worker_ticks", 0))),
                turns_seen=max(0, int(data.get("turns_seen", 0))),
                first_tick=data.get("first_tick"),
                last_tick=max(0, int(data.get("last_tick", 0))),
                enemy_sightings={
                    (int(entry[0]), int(entry[1])): int(entry[2])
                    for entry in data.get("enemy_sightings", [])
                    if len(entry) == 3
                },
                enemy_tracks=enemy_tracks,
                tracker_assignments={
                    UUID(unit_id): UUID(enemy_id)
                    for unit_id, enemy_id in data.get("tracker_assignments", {}).items()
                },
                peak_hp={
                    UUID(unit_id): max(1, int(hp))
                    for unit_id, hp in data.get("peak_hp", {}).items()
                },
                peak_hp_by_type={
                    UnitType(unit_type): max(1, int(hp))
                    for unit_type, hp in data.get("peak_hp_by_type", {}).items()
                },
                living_worker_ids={
                    UUID(worker_id) for worker_id in data.get("living_worker_ids", [])
                },
                last_worker_loss_tick=data.get("last_worker_loss_tick"),
                worker_losses=max(0, int(data.get("worker_losses", 0))),
                fleeing_worker_ticks=max(
                    0, int(data.get("fleeing_worker_ticks", 0))
                ),
                last_core_damage_tick=data.get("last_core_damage_tick"),
                last_core_move_tick=data.get("last_core_move_tick"),
                economy_history=[
                    {str(key): max(0, int(value)) for key, value in sample.items()}
                    for sample in data.get("economy_history", [])
                    if isinstance(sample, dict)
                ][-ADAPTIVE_HISTORY_LIMIT:],
                worker_cycle_started={
                    UUID(worker_id): max(0, int(started))
                    for worker_id, started in data.get("worker_cycle_started", {}).items()
                },
                cycle_durations=[
                    max(1, int(duration))
                    for duration in data.get("cycle_durations", [])
                ][-ADAPTIVE_HISTORY_LIMIT:],
                adaptive_radius_delta=int(data.get("adaptive_radius_delta", 0)),
                adaptive_scout_bonus=max(0, int(data.get("adaptive_scout_bonus", 0))),
                adaptive_worker_target=data.get("adaptive_worker_target"),
                adaptive_worker_base_target=data.get("adaptive_worker_base_target"),
                adaptive_last_adjust_tick=data.get("adaptive_last_adjust_tick"),
                adaptive_action=str(data.get("adaptive_action", "WARMUP")),
                adaptive_reason=str(data.get("adaptive_reason", "collecting_samples")),
                adaptive_throughput=float(data.get("adaptive_throughput", 0.0)),
                adaptive_utilization=float(data.get("adaptive_utilization", 0.0)),
                adaptive_failure_rate=float(data.get("adaptive_failure_rate", 0.0)),
                adaptive_average_cycle_ticks=float(
                    data.get("adaptive_average_cycle_ticks", 0.0)
                ),
                adaptive_storage_full_ratio=float(
                    data.get("adaptive_storage_full_ratio", 0.0)
                ),
                adaptive_new_cells_per_scout=float(
                    data.get("adaptive_new_cells_per_scout", 0.0)
                ),
                adaptive_sample_count=max(0, int(data.get("adaptive_sample_count", 0))),
                adaptive_scarcity_streak=max(
                    0, int(data.get("adaptive_scarcity_streak", 0))
                ),
                economy_experiment_block_id=data.get(
                    "economy_experiment_block_id"
                ),
            )
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            return cls()

    def save(self, path: Path) -> None:
        data = {
            "version": 11,
            "owner_username": self.owner_username,
            "resource_hints": sorted(self.resource_hints),
            "obstacle_cells": sorted(self.obstacle_cells),
            "worker_targets": {
                str(worker_id): target
                for worker_id, target in sorted(
                    self.worker_targets.items(), key=lambda item: item[0].bytes
                )
            },
            "scout_targets": {
                str(worker_id): target
                for worker_id, target in sorted(
                    self.scout_targets.items(), key=lambda item: item[0].bytes
                )
            },
            "scout_target_started": {
                str(worker_id): started
                for worker_id, started in sorted(
                    self.scout_target_started.items(), key=lambda item: item[0].bytes
                )
            },
            "worker_sectors": {
                str(worker_id): sector
                for worker_id, sector in sorted(
                    self.worker_sectors.items(), key=lambda item: item[0].bytes
                )
            },
            "combat_targets": {
                str(unit_id): target
                for unit_id, target in sorted(
                    self.combat_targets.items(), key=lambda item: item[0].bytes
                )
            },
            "combat_target_started": {
                str(unit_id): started
                for unit_id, started in sorted(
                    self.combat_target_started.items(), key=lambda item: item[0].bytes
                )
            },
            "combat_sectors": {
                str(unit_id): sector
                for unit_id, sector in sorted(
                    self.combat_sectors.items(), key=lambda item: item[0].bytes
                )
            },
            "guard_targets": {
                str(ranger_id): target
                for ranger_id, target in sorted(
                    self.guard_targets.items(), key=lambda item: item[0].bytes
                )
            },
            "guard_sectors": {
                str(ranger_id): sector
                for ranger_id, sector in sorted(
                    self.guard_sectors.items(), key=lambda item: item[0].bytes
                )
            },
            "known_cells": sorted(self.known_cells),
            "visited_cells": [
                [cell, count]
                for cell, count in sorted(self.visited_cells.items())
                if count > 0
            ],
            "cell_last_seen": [
                [cell[0], cell[1], tick]
                for cell, tick in sorted(self.cell_last_seen.items())
            ],
            "resource_chunks": sorted(self.resource_chunks),
            "bounds": self.bounds,
            "planned_deposited": self.planned_deposited,
            "scouting_worker_ticks": self.scouting_worker_ticks,
            "worker_ticks": self.worker_ticks,
            "turns_seen": self.turns_seen,
            "first_tick": self.first_tick,
            "last_tick": self.last_tick,
            "enemy_sightings": [
                [cell[0], cell[1], tick]
                for cell, tick in sorted(self.enemy_sightings.items())
            ],
            "enemy_tracks": {
                str(enemy_id): {
                    "position": track.position,
                    "previous_position": track.previous_position,
                    "first_seen_tick": track.first_seen_tick,
                    "last_seen_tick": track.last_seen_tick,
                    "missing_since_tick": track.missing_since_tick,
                    "kind": track.kind,
                    "unit_type": (
                        track.unit_type.value if track.unit_type is not None else None
                    ),
                    "hp": track.hp,
                }
                for enemy_id, track in sorted(
                    self.enemy_tracks.items(), key=lambda item: item[0].bytes
                )
            },
            "tracker_assignments": {
                str(unit_id): str(enemy_id)
                for unit_id, enemy_id in sorted(
                    self.tracker_assignments.items(), key=lambda item: item[0].bytes
                )
            },
            "peak_hp": {
                str(unit_id): hp
                for unit_id, hp in sorted(
                    self.peak_hp.items(), key=lambda item: item[0].bytes
                )
            },
            "peak_hp_by_type": {
                unit_type.value: hp
                for unit_type, hp in sorted(
                    self.peak_hp_by_type.items(), key=lambda item: item[0].value
                )
            },
            "living_worker_ids": sorted(
                str(worker_id) for worker_id in self.living_worker_ids
            ),
            "last_worker_loss_tick": self.last_worker_loss_tick,
            "worker_losses": self.worker_losses,
            "fleeing_worker_ticks": self.fleeing_worker_ticks,
            "last_core_damage_tick": self.last_core_damage_tick,
            "last_core_move_tick": self.last_core_move_tick,
            "economy_history": self.economy_history[-ADAPTIVE_HISTORY_LIMIT:],
            "worker_cycle_started": {
                str(worker_id): started
                for worker_id, started in self.worker_cycle_started.items()
            },
            "cycle_durations": self.cycle_durations[-ADAPTIVE_HISTORY_LIMIT:],
            "adaptive_radius_delta": self.adaptive_radius_delta,
            "adaptive_scout_bonus": self.adaptive_scout_bonus,
            "adaptive_worker_target": self.adaptive_worker_target,
            "adaptive_worker_base_target": self.adaptive_worker_base_target,
            "adaptive_last_adjust_tick": self.adaptive_last_adjust_tick,
            "adaptive_action": self.adaptive_action,
            "adaptive_reason": self.adaptive_reason,
            "adaptive_throughput": self.adaptive_throughput,
            "adaptive_utilization": self.adaptive_utilization,
            "adaptive_failure_rate": self.adaptive_failure_rate,
            "adaptive_average_cycle_ticks": self.adaptive_average_cycle_ticks,
            "adaptive_storage_full_ratio": self.adaptive_storage_full_ratio,
            "adaptive_new_cells_per_scout": self.adaptive_new_cells_per_scout,
            "adaptive_sample_count": self.adaptive_sample_count,
            "adaptive_scarcity_streak": self.adaptive_scarcity_streak,
            "economy_experiment_block_id": self.economy_experiment_block_id,
        }
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(data, ensure_ascii=True, separators=(",", ":")),
            encoding="utf-8",
        )
        temporary.replace(path)

    def _compute_bounds(self, turn: Turn) -> tuple[int, int, int, int]:
        width = getattr(turn, "width", None) or getattr(turn, "map_width", None)
        height = getattr(turn, "height", None) or getattr(turn, "map_height", None)
        if isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0:
            return (0, 0, width - 1, height - 1)

        cells = set(self.known_cells)
        if turn.core is not None:
            cells.add(turn.core.position)
        cells.update(unit.position for unit in turn.units)
        if not cells:
            return (-MAP_MARGIN, -MAP_MARGIN, MAP_MARGIN, MAP_MARGIN)
        xs = [cell[0] for cell in cells]
        ys = [cell[1] for cell in cells]
        return (
            min(xs) - MAP_MARGIN,
            min(ys) - MAP_MARGIN,
            max(xs) + MAP_MARGIN,
            max(ys) + MAP_MARGIN,
        )


# --------------------------------------------------------------------------
# Pathfinding
# --------------------------------------------------------------------------
class Pathfinder:
    """BFS over confirmed walkable cells, with per-turn distance caching.

    Unknown cells can be exploration goals, but are never used as intermediate
    shortcuts. This prevents remembered walls from being bypassed through fog.
    """

    def __init__(
        self,
        obstacles: set[Position],
        blocked: set[Position],
        bounds: tuple[int, int, int, int] | None,
        known_cells: set[Position] | None = None,
    ) -> None:
        self.obstacles = obstacles
        self.blocked = blocked
        self.bounds = bounds
        self.known_cells = known_cells
        self._cache: dict[Position, dict[Position, int]] = {}

    def in_bounds(self, position: Position) -> bool:
        if self.bounds is None:
            return True
        min_x, min_y, max_x, max_y = self.bounds
        return min_x <= position[0] <= max_x and min_y <= position[1] <= max_y

    def passable(self, position: Position) -> bool:
        return position not in self.blocked and self.in_bounds(position)

    def walkable(self, position: Position) -> bool:
        return self.passable(position) and (
            self.known_cells is None or position in self.known_cells
        )

    def distances(self, start: Position) -> dict[Position, int]:
        cached = self._cache.get(start)
        if cached is not None:
            return cached

        distances: dict[Position, int] = {start: 0}
        queue: deque[Position] = deque((start,))
        while queue:
            current = queue.popleft()
            step = distances[current] + 1
            if step > PATH_MAX_DISTANCE or len(distances) > PATH_NODE_LIMIT:
                break
            for neighbor in _neighbors(current):
                if neighbor in distances or not self.walkable(neighbor):
                    continue
                distances[neighbor] = step
                queue.append(neighbor)

        self._cache[start] = distances
        return distances

    def distance_to(self, start: Position, goal: Position) -> int | None:
        distances = self.distances(start)
        if goal in distances:
            return distances[goal]
        # Goal itself blocked (enemy or unit standing on it): use its approach cell.
        approach = [distances[cell] for cell in _neighbors(goal) if cell in distances]
        return min(approach) + 1 if approach else None

    def first_step(self, start: Position, goal: Position) -> Direction | None:
        if start == goal:
            return None
        distances = self.distances(start)

        target = goal
        if target not in distances:
            approach = [cell for cell in _neighbors(goal) if cell in distances]
            if not approach:
                return None
            target = min(approach, key=lambda cell: (distances[cell], cell))
            if target == start:
                try:
                    return _direction_between(start, goal)
                except ValueError:  # pragma: no cover - cardinal frontier only
                    return None

        current = target
        while distances[current] > 1:
            for neighbor in _neighbors(current):
                if distances.get(neighbor) == distances[current] - 1:
                    current = neighbor
                    break
            else:  # pragma: no cover - BFS always leaves a descending gradient
                return None
        try:
            return _direction_between(start, current)
        except ValueError:  # pragma: no cover - defensive
            return None


class DangerMap:
    """Per-cell threat score from visible enemies plus decaying sightings.

    Score is ~2.0 on top of an enemy and fades to 0 at the edge of its danger
    radius. Cells scoring at least ``UNSAFE_SCORE`` are treated as no-go zones
    for workers (mining, scouting and hauling).
    """

    def __init__(self, turn: Turn, memory: TacticMemory | None = None) -> None:
        self.enabled = SAFETY_ENABLED
        self.scores: dict[Position, float] = {}
        self.enemy_cells = {enemy.position for enemy in turn.visible_enemies}
        if not self.enabled:
            return

        for enemy in turn.visible_enemies:
            radius = _enemy_danger_radius(enemy)
            if radius is None:
                continue
            self._paint(enemy.position, radius, 1.0)

        if memory is None:
            return
        for cell, tick in memory.enemy_sightings.items():
            if cell in self.enemy_cells:
                continue
            age = max(0, turn.tick - tick)
            decay = 1.0 - age / REMEMBERED_THREAT_TICKS
            if decay <= 0.0:
                continue
            self._paint(
                cell,
                DEFAULT_ENEMY_DANGER_RADIUS,
                REMEMBERED_THREAT_WEIGHT * decay,
            )

    def _paint(self, origin: Position, radius: int, weight: float) -> None:
        for dx in range(-radius, radius + 1):
            span = radius - abs(dx)
            for dy in range(-span, span + 1):
                cell = (origin[0] + dx, origin[1] + dy)
                falloff = (radius - (abs(dx) + abs(dy)) + 1) / (radius + 1)
                intensity = 2.0 * weight * falloff
                if intensity > self.scores.get(cell, 0.0):
                    self.scores[cell] = intensity

    def score(self, position: Position) -> float:
        return self.scores.get(position, 0.0)

    def is_unsafe(self, position: Position) -> bool:
        return self.enabled and self.score(position) >= UNSAFE_SCORE

    @property
    def active(self) -> bool:
        return self.enabled and bool(self.scores)


@dataclass(frozen=True)
class ThreatAssessment:
    """One shared economy-versus-safety decision for the whole Turn."""

    score: float
    posture: str
    unsafe_workers: int
    core_pressure: int
    worker_pressure: int
    combat_enemies: int
    defenders: int
    recent_worker_loss: bool
    recent_core_damage: bool

    @property
    def safety_first(self) -> bool:
        return self.posture != POSTURE_ECONOMY

    @property
    def survival(self) -> bool:
        return self.posture == POSTURE_SURVIVAL

    def scout_budget(
        self,
        total_workers: int,
        idle_workers: int,
        resource_candidates: int,
        config: StrategyConfig,
    ) -> int:
        if idle_workers <= 0 or self.survival:
            return 0
        if self.posture == POSTURE_GUARDED:
            return min(
                idle_workers,
                config.workers.max_scouts_under_threat,
            )

        # In a quiet economy an unassigned Worker has no productive reason to
        # stage at the Core. Every idle Worker searches or patrols a resource
        # chunk; the configured limit is retained only for old config files.
        return idle_workers


def _assess_threat(
    turn: Turn,
    memory: TacticMemory,
    danger: DangerMap,
    config: StrategyConfig,
) -> ThreatAssessment:
    combat_enemies = [
        enemy
        for enemy in turn.visible_enemies
        if _enemy_danger_radius(enemy) is not None
    ]
    defenders = len(turn.vanguards) + len(turn.rangers)
    unsafe_workers = sum(
        danger.is_unsafe(worker.position) for worker in turn.workers
    )
    core_pressure = 0
    worker_pressure = 0
    score = 0.25 * len(combat_enemies)

    for enemy in combat_enemies:
        if turn.core is not None:
            core_distance = _distance(enemy.position, turn.core.position)
            if core_distance <= 1:
                score += 4.0
                core_pressure += 2
            elif core_distance <= 3:
                score += 2.5
                core_pressure += 1
            elif core_distance <= DEFENSE_RADIUS:
                score += 1.0
                core_pressure += 1

        if turn.workers:
            worker_distance = min(
                _distance(enemy.position, worker.position) for worker in turn.workers
            )
            danger_radius = _enemy_danger_radius(enemy) or 0
            if worker_distance <= danger_radius:
                score += 1.25
                worker_pressure += 1

    score += 2.5 * unsafe_workers
    recent_worker_loss = memory.recent_worker_loss(turn.tick)
    if recent_worker_loss:
        score += 2.0
    recent_core_damage = (
        memory.last_core_damage_tick is not None
        and 0 <= turn.tick - memory.last_core_damage_tick <= 5
    )
    if recent_core_damage:
        score += 3.0
        core_pressure = max(core_pressure, 1)

    if danger.active:
        score += 0.5 * sum(_is_hurt(worker, memory) for worker in turn.workers)

    # Existing defenders reduce pressure but never erase current danger.
    score = max(0.0, score - 0.6 * min(defenders, len(combat_enemies)))
    if not SAFETY_ENABLED:
        posture = POSTURE_ECONOMY
        score = 0.0
    elif score >= config.threat.survival_score:
        posture = POSTURE_SURVIVAL
    elif score >= config.threat.guarded_score:
        posture = POSTURE_GUARDED
    else:
        posture = POSTURE_ECONOMY

    return ThreatAssessment(
        score=score,
        posture=posture,
        unsafe_workers=unsafe_workers,
        core_pressure=core_pressure,
        worker_pressure=worker_pressure,
        combat_enemies=len(combat_enemies),
        defenders=defenders,
        recent_worker_loss=recent_worker_loss,
        recent_core_damage=recent_core_damage,
    )


class MovementPlanner:
    def __init__(
        self,
        turn: Turn,
        memory: TacticMemory | None = None,
        pathfinder: Pathfinder | None = None,
        danger: DangerMap | None = None,
    ) -> None:
        self.memory = memory
        self.danger = danger if danger is not None else DangerMap(turn, memory)
        self.obstacles = set(turn.obstacle_cells)
        if memory is not None:
            self.obstacles |= memory.obstacle_cells
        self.enemy_cells = {enemy.position for enemy in turn.visible_enemies}
        self.occupancy: Counter[Position] = Counter(unit.position for unit in turn.units)
        if turn.core is not None:
            self.occupancy[turn.core.position] += 1
        self.entries: Counter[Position] = Counter()
        self.departures: Counter[Position] = Counter()
        self.pathfinder = pathfinder or Pathfinder(
            self.obstacles,
            self.obstacles | self.enemy_cells,
            memory.bounds if memory is not None else None,
            memory.known_cells if memory is not None else None,
        )

    def predicted_occupancy(self, position: Position) -> int:
        return self.occupancy[position] - self.departures[position] + self.entries[position]

    def move_toward(
        self,
        unit: object,
        target: Position,
        avoid_danger: bool = False,
    ) -> bool:
        if unit.position == target:
            return False

        preferred: Direction | None = None
        if ECONOMY_MODE:
            if self.pathfinder.distance_to(unit.position, target) is None:
                return False
            preferred = self.pathfinder.first_step(unit.position, target)

        trail = ()
        if self.memory is not None:
            trail = tuple(self.memory.recent_positions.get(unit.id, ()))[:-1]

        danger = self.danger if (avoid_danger and self.danger.enabled) else None
        current_risk = danger.score(unit.position) if danger is not None else 0.0

        candidates: list[tuple] = []
        for order, direction in enumerate(DIRECTION_ORDER):
            destination = _step(unit.position, direction)
            if destination in self.obstacles or destination in self.enemy_cells:
                continue
            if not self.pathfinder.in_bounds(destination):
                continue
            if self.predicted_occupancy(destination) >= 2:
                continue
            risk = danger.score(destination) if danger is not None else 0.0
            # Stepping into a threatened cell is only acceptable when it is not
            # worse than where the unit already stands (e.g. while escaping).
            unsafe = (
                1
                if danger is not None
                and danger.is_unsafe(destination)
                and risk >= current_risk
                else 0
            )
            risk_bucket = 1 if risk >= UNSAFE_SCORE / 2 and risk > current_risk else 0
            off_path = 0 if (preferred is not None and direction is preferred) else 1
            oscillating = 1 if destination in trail else 0
            candidates.append(
                (
                    unsafe,
                    risk_bucket,
                    off_path,
                    oscillating,
                    _distance(destination, target),
                    order,
                    direction,
                    destination,
                )
            )

        if not candidates:
            return False

        best = min(candidates)
        direction, destination = best[-2], best[-1]
        unit.move(direction)
        self.departures[unit.position] += 1
        self.entries[destination] += 1
        return True


# --------------------------------------------------------------------------
# Targeting helpers
# --------------------------------------------------------------------------
def _enemy_priority(enemy: object, core_position: Position) -> tuple[int, int, int, bytes]:
    kind_priority = 0 if str(getattr(enemy, "kind", "")).upper() == "CORE" else 1
    return (
        kind_priority,
        _distance(enemy.position, core_position),
        int(getattr(enemy, "hp", 1)),
        _uuid_key(enemy.id),
    )


def _track_priority(
    item: tuple[UUID, EnemyTrack],
    core_position: Position,
) -> tuple[int, int, int, int, bytes]:
    enemy_id, track = item
    return (
        0 if track.kind == "CORE" else 1,
        _distance(track.position, core_position),
        1 if track.missing_since_tick is not None else 0,
        track.hp,
        _uuid_key(enemy_id),
    )


def _track_is_combat_threat(track: EnemyTrack) -> bool:
    return track.kind != "CORE" and track.unit_type is not UnitType.WORKER


def _line_is_clear(source: Position, target: Position, obstacles: set[Position]) -> bool:
    delta_x = target[0] - source[0]
    delta_y = target[1] - source[1]
    distance_x = abs(delta_x)
    distance_y = abs(delta_y)
    if not (
        delta_x == 0
        or delta_y == 0
        or distance_x == distance_y
    ):
        return False
    distance = max(distance_x, distance_y)
    if distance not in range(1, 4):
        return False

    step_x = 0 if delta_x == 0 else (1 if delta_x > 0 else -1)
    step_y = 0 if delta_y == 0 else (1 if delta_y > 0 else -1)
    position = source
    for _ in range(1, distance):
        position = position[0] + step_x, position[1] + step_y
        if position in obstacles:
            return False
    return True


def _missing_hp(unit: object) -> int:
    hp = getattr(unit, "hp", None)
    if not isinstance(hp, int) or hp <= 0:
        return 0
    unit_type = _unit_type_of(unit)
    maximum = getattr(unit, "max_hp", None)
    if not isinstance(maximum, int) or maximum <= 0:
        maximum = UNIT_MAX_HP.get(unit_type, hp)
    return max(0, maximum - hp)


def _ring_cells(core_position: Position, radius: int) -> tuple[Position, ...]:
    if radius <= 0:
        return (core_position,)
    core_x, core_y = core_position
    cells: list[Position] = []
    for offset in range(radius):
        cells.append((core_x + offset, core_y - radius + offset))
    for offset in range(radius):
        cells.append((core_x + radius - offset, core_y + offset))
    for offset in range(radius):
        cells.append((core_x - offset, core_y + radius - offset))
    for offset in range(radius):
        cells.append((core_x - radius + offset, core_y - offset))
    return tuple(cells)


def _select_guard_rangers(turn: Turn, memory: TacticMemory) -> set[UUID]:
    if turn.core is None:
        return set()
    rangers = list(turn.rangers)
    retained = sorted(
        (ranger for ranger in rangers if ranger.id in memory.guard_sectors),
        key=lambda ranger: (
            memory.guard_sectors[ranger.id],
            _distance(ranger.position, turn.core.position),
            _uuid_key(ranger.id),
        ),
    )
    selected = retained[:CORE_RING_GUARD_COUNT]
    selected_ids = {ranger.id for ranger in selected}
    for ranger in sorted(
        rangers,
        key=lambda item: (
            _distance(item.position, turn.core.position),
            _uuid_key(item.id),
        ),
    ):
        if len(selected) >= CORE_RING_GUARD_COUNT:
            break
        if ranger.id not in selected_ids:
            selected.append(ranger)
            selected_ids.add(ranger.id)

    used_sectors = {
        memory.guard_sectors[ranger.id]
        for ranger in selected
        if ranger.id in memory.guard_sectors
    }
    for ranger in selected:
        if ranger.id not in memory.guard_sectors:
            sector = next(
                (
                    candidate
                    for candidate in range(CORE_RING_GUARD_COUNT)
                    if candidate not in used_sectors
                ),
                0,
            )
            memory.guard_sectors[ranger.id] = sector
            used_sectors.add(sector)

    for ranger_id in tuple(memory.guard_targets):
        if ranger_id not in selected_ids:
            memory.guard_targets.pop(ranger_id, None)
            memory.guard_sectors.pop(ranger_id, None)
    memory.guard_ranger_ids = selected_ids
    return selected_ids


def _ring_guard_target(
    ranger: object,
    core_position: Position,
    memory: TacticMemory,
    pathfinder: Pathfinder,
) -> Position | None:
    ring = _ring_cells(core_position, CORE_RING_RADIUS)
    if not ring:
        return None
    existing = memory.guard_targets.get(ranger.id)
    if (
        existing in ring
        and existing != ranger.position
        and pathfinder.distance_to(ranger.position, existing) is not None
    ):
        return existing

    sector = memory.guard_sectors.get(ranger.id, 0)
    if existing in ring:
        start_index = (ring.index(existing) + 1) % len(ring)
    else:
        start_index = sector * (len(ring) // max(1, CORE_RING_GUARD_COUNT))

    candidates: list[tuple[int, int, Position]] = []
    for step_count in range(len(ring)):
        index = (start_index + step_count) % len(ring)
        cell = ring[index]
        if cell in memory.obstacle_cells:
            continue
        distance = pathfinder.distance_to(ranger.position, cell)
        if distance is None:
            continue
        candidates.append((step_count, distance, cell))
    if not candidates:
        memory.guard_targets.pop(ranger.id, None)
        return None
    target = min(candidates)[2]
    memory.guard_targets[ranger.id] = target
    return target


def _track_shot_cells(
    track: EnemyTrack,
    obstacles: set[Position],
    memory: TacticMemory,
    tick: int,
) -> tuple[Position, ...]:
    if track.missing_since_tick is not None:
        age = max(1, tick - track.last_seen_tick)
        search_radius = min(ENEMY_SEARCH_RADIUS, age)
        predicted = track.position
        if track.previous_position is not None:
            delta = (
                track.position[0] - track.previous_position[0],
                track.position[1] - track.previous_position[1],
            )
            if abs(delta[0]) + abs(delta[1]) == 1:
                predicted = (
                    track.position[0] + delta[0] * search_radius,
                    track.position[1] + delta[1] * search_radius,
                )

        possible: list[Position] = []
        for dx in range(-search_radius, search_radius + 1):
            span = search_radius - abs(dx)
            for dy in range(-span, span + 1):
                cell = (track.position[0] + dx, track.position[1] + dy)
                if (
                    cell in memory.known_cells
                    and cell not in obstacles
                    and memory.cell_last_seen.get(cell, -1) < tick
                ):
                    possible.append(cell)
        return tuple(
            sorted(
                possible,
                key=lambda cell: (
                    _distance(cell, predicted),
                    _distance(cell, track.position),
                    cell,
                ),
            )
        )

    cells: list[Position] = []
    if track.previous_position is not None:
        delta_x = track.position[0] - track.previous_position[0]
        delta_y = track.position[1] - track.previous_position[1]
        if abs(delta_x) + abs(delta_y) == 1:
            cells.append((track.position[0] + delta_x, track.position[1] + delta_y))
    cells.append(track.position)
    cells.extend(_neighbors(track.position))
    unique: list[Position] = []
    for cell in cells:
        if cell in obstacles or cell in unique:
            continue
        unique.append(cell)
    return tuple(unique)


def _choose_ranger_shot(
    ranger: object,
    tracks: list[tuple[UUID, EnemyTrack]],
    core_position: Position,
    obstacles: set[Position],
    claimed_cells: set[Position],
    memory: TacticMemory,
    tick: int,
) -> Position | None:
    candidates: list[tuple] = []
    for track_order, item in enumerate(tracks):
        _, track = item
        for cell_order, cell in enumerate(
            _track_shot_cells(track, obstacles, memory, tick)
        ):
            if not _line_is_clear(ranger.position, cell, obstacles):
                continue
            candidates.append(
                (
                    1 if cell in claimed_cells else 0,
                    _track_priority(item, core_position),
                    cell_order,
                    track_order,
                    cell,
                )
            )
    if not candidates:
        return None
    target = min(candidates)[-1]
    claimed_cells.add(target)
    return target


def _active_tracks(
    memory: TacticMemory,
    core_position: Position,
) -> list[tuple[UUID, EnemyTrack]]:
    return sorted(
        memory.enemy_tracks.items(),
        key=lambda item: _track_priority(item, core_position),
    )


def _track_destination(
    unit: object,
    track: EnemyTrack,
    memory: TacticMemory,
    pathfinder: Pathfinder,
    tick: int,
) -> Position | None:
    """Choose the live target or a waypoint that re-covers a lost track."""
    if track.missing_since_tick is None:
        return track.position

    age = max(1, tick - track.last_seen_tick)
    search_radius = min(ENEMY_SEARCH_RADIUS, age)
    search_cells: list[Position] = []
    for dx in range(-search_radius, search_radius + 1):
        span = search_radius - abs(dx)
        for dy in range(-span, span + 1):
            cell = (track.position[0] + dx, track.position[1] + dy)
            if cell in memory.known_cells and pathfinder.walkable(cell):
                search_cells.append(cell)

    uncovered = [
        cell
        for cell in search_cells
        if memory.cell_last_seen.get(cell, -1) < tick
    ]
    if not uncovered:
        return None

    predicted = track.position
    if track.previous_position is not None:
        delta = (
            track.position[0] - track.previous_position[0],
            track.position[1] - track.previous_position[1],
        )
        if abs(delta[0]) + abs(delta[1]) == 1:
            predicted = (
                track.position[0] + delta[0] * search_radius,
                track.position[1] + delta[1] * search_radius,
            )

    view_radius = (
        VIEW_RADIUS_VANGUARD
        if _unit_type_of(unit) is UnitType.VANGUARD
        else VIEW_RADIUS_RANGER
    )
    candidates: list[tuple[int, int, int, int, Position]] = []
    for cell in search_cells:
        route = pathfinder.distance_to(unit.position, cell)
        if route is None:
            continue
        coverage = sum(
            _distance(cell, possible) <= view_radius
            and _has_line_of_sight(cell, possible, pathfinder.obstacles)
            for possible in uncovered
        )
        if coverage <= 0:
            continue
        candidates.append(
            (
                -coverage,
                _distance(cell, predicted),
                route,
                memory.visited_cells[cell],
                cell,
            )
        )
    return min(candidates)[-1] if candidates else None


def _assign_trackers(
    turn: Turn,
    memory: TacticMemory,
    guard_ids: set[UUID],
) -> None:
    if turn.core is None:
        return
    combat_units = [*turn.vanguards, *turn.rangers]
    living_ids = {unit.id for unit in combat_units}
    assigned_units = set(memory.tracker_assignments)
    for enemy_id, track in _active_tracks(memory, turn.core.position):
        if enemy_id in memory.tracker_assignments.values():
            continue
        remote = _distance(track.position, turn.core.position) > DEFENSE_RADIUS + 2
        candidates = [
            unit
            for unit in combat_units
            if unit.id not in assigned_units
            and (not remote or unit.id not in guard_ids)
        ]
        if not candidates:
            continue
        tracker = min(
            candidates,
            key=lambda unit: (
                _distance(unit.position, track.position),
                _uuid_key(unit.id),
            ),
        )
        memory.tracker_assignments[tracker.id] = enemy_id
        assigned_units.add(tracker.id)
    memory.tracker_assignments = {
        unit_id: enemy_id
        for unit_id, enemy_id in memory.tracker_assignments.items()
        if unit_id in living_ids and enemy_id in memory.enemy_tracks
    }


def _track_for_unit(
    unit: object,
    tracks: list[tuple[UUID, EnemyTrack]],
    memory: TacticMemory,
) -> tuple[UUID, EnemyTrack] | None:
    assigned_id = memory.tracker_assignments.get(unit.id)
    if assigned_id is not None:
        assigned = next((item for item in tracks if item[0] == assigned_id), None)
        if assigned is not None:
            return assigned
    if not tracks:
        return None
    return min(
        tracks,
        key=lambda item: (
            0 if item[1].kind == "CORE" else 1,
            _distance(unit.position, item[1].position),
            item[1].missing_since_tick is not None,
            _uuid_key(item[0]),
        ),
    )


def _emergency_ranger_target(turn: Turn, memory: TacticMemory) -> int:
    if turn.core is None:
        return 0
    combat_threats = sum(
        1
        for track in memory.enemy_tracks.values()
        if _track_is_combat_threat(track)
        and _distance(track.position, turn.core.position) <= DEFENSE_RADIUS + 2
    )
    if combat_threats <= 0:
        return 0
    return min(
        EMERGENCY_RANGER_CAP,
        max(CORE_RING_GUARD_COUNT, combat_threats + 1),
    )


def _assign_worker_blockers(
    turn: Turn,
    movement: MovementPlanner,
    memory: TacticMemory,
) -> None:
    if turn.core is None:
        return
    visible_ids = {enemy.id for enemy in turn.visible_enemies}
    remote_tracks = [
        item
        for item in _active_tracks(memory, turn.core.position)
        if item[0] in visible_ids
        and _track_is_combat_threat(item[1])
        and _distance(item[1].position, turn.core.position) > DEFENSE_RADIUS + 2
    ]
    if not remote_tracks:
        return

    _, track = remote_tracks[0]
    escape_cells = list(_neighbors(track.position))
    escape_cells.sort(
        key=lambda cell: (
            -_distance(cell, turn.core.position),
            cell,
        )
    )
    if track.previous_position is not None:
        delta = (
            track.position[0] - track.previous_position[0],
            track.position[1] - track.previous_position[1],
        )
        predicted = (track.position[0] + delta[0], track.position[1] + delta[1])
        if abs(delta[0]) + abs(delta[1]) == 1 and predicted in escape_cells:
            escape_cells.remove(predicted)
            escape_cells.insert(0, predicted)

    available_workers = [
        worker
        for worker in turn.workers
        if worker.cargo == 0
        and worker.id not in memory.population_relief_worker_ids
        and not _is_hurt(worker, memory)
        and _distance(worker.position, track.position) <= WORKER_BLOCK_RADIUS
    ]
    used_workers: set[UUID] = set()
    for cell in escape_cells:
        if len(used_workers) >= MAX_WORKER_BLOCKERS:
            break
        if (
            cell in movement.obstacles
            or cell in movement.enemy_cells
            or movement.predicted_occupancy(cell) >= 2
        ):
            continue
        candidates = [
            worker
            for worker in available_workers
            if worker.id not in used_workers
            and movement.pathfinder.distance_to(worker.position, cell) is not None
        ]
        if not candidates:
            continue
        worker = min(
            candidates,
            key=lambda item: (
                movement.pathfinder.distance_to(item.position, cell),
                _uuid_key(item.id),
            ),
        )
        memory.worker_block_targets[worker.id] = cell
        used_workers.add(worker.id)


def _plan_emergency_population_relief(
    turn: Turn,
    movement: MovementPlanner,
    memory: TacticMemory,
    config: StrategyConfig,
) -> None:
    core = turn.core
    target = _emergency_ranger_target(turn, memory)
    if (
        core is None
        or core.view.state is not CoreState.NORMAL
        or target <= len(turn.rangers)
        or len(turn.units) < config.production.max_population
        or movement.predicted_occupancy(core.position) != 1
        or turn.resources + memory.planned_deposit_this_turn
        < _unit_cost(turn, UnitType.RANGER)
    ):
        return

    beacon_carrier = (
        turn.beacon.carrier_id
        if turn.beacon.status is BeaconStatus.CARRIED
        else None
    )
    candidates = [
        worker
        for worker in turn.workers
        if worker.id != beacon_carrier
    ]
    if not candidates:
        return
    worker = min(
        candidates,
        key=lambda item: (
            item.cargo > 0,
            -_distance(item.position, core.position),
            _uuid_key(item.id),
        ),
    )
    worker.self_destruct()
    memory.population_relief_worker_ids.add(worker.id)
    memory.planned_population_relief = 1
    memory.worker_targets.pop(worker.id, None)
    _clear_scout_target(memory, worker.id)
    memory.worker_block_targets.pop(worker.id, None)
    movement.departures[worker.position] += 1


def _ground_beacon_at(turn: Turn, position: Position) -> bool:
    return turn.beacon.status is BeaconStatus.GROUND and turn.beacon.position == position



def _is_hurt(unit: object, memory: TacticMemory) -> bool:
    hp = getattr(unit, "hp", None)
    if not isinstance(hp, int) or hp <= 0:
        return False
    peak = memory.peak_hp.get(unit.id, hp)
    unit_type = _unit_type_of(unit)
    if unit_type is not None:
        peak = max(peak, memory.peak_hp_by_type.get(unit_type, 0))
        peak = max(peak, UNIT_MAX_HP[unit_type])
    maximum = getattr(unit, "max_hp", None)
    if isinstance(maximum, int) and maximum > 0:
        peak = max(peak, maximum)
    return hp <= peak * WORKER_RETREAT_HP_RATIO


def _retreat_target(
    worker: object,
    danger: DangerMap,
    pathfinder: Pathfinder,
    core_position: Position | None,
) -> Position | None:
    """Nearest low-danger tile, preferring cells closer to the core."""
    best_key: tuple | None = None
    best_cell: Position | None = None
    for cell, travel in pathfinder.distances(worker.position).items():
        if travel > WORKER_FLEE_SEARCH_RADIUS:
            continue
        key = (
            round(danger.score(cell), 3),
            _distance(cell, core_position) if core_position is not None else 0,
            travel,
            cell,
        )
        if best_key is None or key < best_key:
            best_key = key
            best_cell = cell
    return best_cell


def _worker_evacuation_target(
    worker: object,
    core_position: Position,
    movement: MovementPlanner,
    radius: int,
) -> Position | None:
    """Pick a low-danger staging cell away from a Core that is relocating."""
    best_key: tuple | None = None
    best_cell: Position | None = None
    for cell, travel in movement.pathfinder.distances(worker.position).items():
        if travel <= 0 or travel > radius:
            continue
        if cell in movement.enemy_cells or movement.predicted_occupancy(cell) >= 2:
            continue
        distance_from_core = _distance(cell, core_position)
        if distance_from_core < 2:
            continue
        key = (
            round(movement.danger.score(cell), 3),
            -min(distance_from_core, radius),
            travel,
            cell,
        )
        if best_key is None or key < best_key:
            best_key = key
            best_cell = cell
    return best_cell


def _evacuate_workers_during_core_move(
    turn: Turn,
    movement: MovementPlanner,
    memory: TacticMemory,
    config: StrategyConfig,
) -> None:
    core = turn.core
    if core is None:
        return
    for worker in sorted(turn.workers, key=lambda item: _uuid_key(item.id)):
        memory.worker_targets.pop(worker.id, None)
        _clear_scout_target(memory, worker.id)
        target = _worker_evacuation_target(
            worker,
            core.position,
            movement,
            config.core.worker_evacuation_radius,
        )
        if target is not None:
            movement.move_toward(worker, target, avoid_danger=True)


def _choose_resource_target(
    position: Position,
    resources: Iterable[Position],
    claimed: set[Position],
    current_resources: set[Position],
) -> Position | None:
    """Legacy greedy pick, kept for the ``balanced`` profile and as a fallback."""
    candidates = [cell for cell in resources if cell not in claimed]
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda cell: (
            cell not in current_resources,
            _distance(position, cell),
            cell[0],
            cell[1],
        ),
    )


def _exploration_target(turn: Turn, worker_index: int, core_position: Position) -> Position:
    waypoint_phase = turn.tick // EXPLORATION_TICKS_PER_WAYPOINT
    offset_index = (waypoint_phase + worker_index * 3) % len(EXPLORATION_OFFSETS)
    offset_x, offset_y = EXPLORATION_OFFSETS[offset_index]
    return (
        core_position[0] + offset_x * EXPLORATION_RADIUS,
        core_position[1] + offset_y * EXPLORATION_RADIUS,
    )


def _frontier_targets(memory: TacticMemory, pathfinder: Pathfinder) -> list[Position]:
    """Unknown cells immediately beyond the explored walkable boundary."""
    frontier: set[Position] = set()
    known = memory.known_cells
    for cell in known:
        if cell in memory.obstacle_cells or not pathfinder.walkable(cell):
            continue
        for neighbor in _neighbors(cell):
            if neighbor not in known and pathfinder.passable(neighbor):
                frontier.add(neighbor)
    return sorted(frontier)


def _resource_chunk_patrol_targets(
    memory: TacticMemory,
    pathfinder: Pathfinder,
    core_position: Position,
    max_radius: int,
) -> list[Position]:
    """Return stale-vision waypoints in chunks that have produced resources."""
    targets: set[Position] = set()
    lattice = (4, 12, 20, 28)
    for chunk in sorted(memory.resource_chunks):
        center = _chunk_center(chunk)
        if _distance(center, core_position) > max_radius + 32:
            continue
        cells = [
            cell
            for cell in memory.known_cells
            if _chunk_position(cell) == chunk and pathfinder.walkable(cell)
        ]
        if not cells:
            continue
        for local_x in lattice:
            for local_y in lattice:
                ideal = chunk[0] * 32 + local_x, chunk[1] * 32 + local_y
                nearby = [cell for cell in cells if _distance(cell, ideal) <= 5]
                pool = nearby or cells
                targets.add(
                    min(
                        pool,
                        key=lambda cell: (
                            memory.cell_last_seen.get(cell, -1),
                            memory.visited_cells[cell],
                            _distance(cell, ideal),
                            cell,
                        ),
                    )
                )
    return sorted(targets)


def _stale_visibility_patrol_targets(
    memory: TacticMemory,
    pathfinder: Pathfinder,
    core_position: Position,
    current_tick: int,
    max_radius: int,
    limit: int = STALE_PATROL_TARGET_LIMIT,
) -> list[Position]:
    """Select old, reachable cells for low-frequency fog revalidation.

    Resource-chunk patrols cover places that have already yielded cargo. This
    companion pass deliberately includes ordinary explored cells too, so an
    enemy or a newly spawned resource in an old pocket is eventually observed.
    Core-distance filtering uses one BFS from the Core; unreachable candidates
    never become destinations and therefore cannot strand a scout.
    """
    if limit <= 0 or max_radius <= 0:
        return []
    core_distances = pathfinder.distances(core_position)
    candidates: list[tuple[int, int, int, Position]] = []
    for cell, last_seen in memory.cell_last_seen.items():
        if last_seen < 0 or cell in memory.obstacle_cells:
            continue
        distance = core_distances.get(cell)
        if distance is None or distance <= 0 or distance > max_radius:
            continue
        age = current_tick - last_seen
        if age < STALE_VISIBILITY_TICKS:
            continue
        candidates.append(
            (
                -age,
                memory.visited_cells[cell],
                distance,
                cell,
            )
        )
    candidates.sort()
    return [cell for _, _, _, cell in candidates[:limit]]


def _scout_information_gain(
    position: Position,
    memory: TacticMemory,
    radius: int = VIEW_RADIUS_WORKER,
) -> int:
    """Estimate how many new cells a waypoint can reveal."""
    gain = 0
    for dx in range(-radius, radius + 1):
        span = radius - abs(dx)
        for dy in range(-span, span + 1):
            cell = position[0] + dx, position[1] + dy
            if cell not in memory.known_cells and cell not in memory.obstacle_cells:
                gain += 1
    return gain


def _clear_scout_target(memory: TacticMemory, worker_id: UUID) -> None:
    memory.scout_targets.pop(worker_id, None)
    memory.scout_target_started.pop(worker_id, None)


def _sector_penalty(
    core_position: Position,
    position: Position,
    sector: int,
) -> float:
    dx = position[0] - core_position[0]
    dy = position[1] - core_position[1]
    distance = abs(dx) + abs(dy)
    if distance == 0:
        return 4.0
    sector_x, sector_y = EXPLORATION_OFFSETS[sector]
    dot = dx * sector_x + dy * sector_y
    cross = abs(dx * sector_y - dy * sector_x)
    return (4.0 if dot <= 0 else 0.0) + cross / distance


def _sector_waypoint(
    core_position: Position,
    sector: int,
    radius: int = EXPLORATION_RADIUS,
) -> Position:
    offset_x, offset_y = EXPLORATION_OFFSETS[sector]
    # Keep diagonal waypoints on the same Manhattan ring as cardinal ones.
    scale = radius if offset_x == 0 or offset_y == 0 else max(1, radius // 2)
    return (
        core_position[0] + offset_x * scale,
        core_position[1] + offset_y * scale,
    )


def _staging_waypoint(
    core_position: Position,
    object_index: int,
    radius: int = STAGING_RADIUS,
) -> Position:
    sector = object_index % len(EXPLORATION_OFFSETS)
    ring = radius + object_index // len(EXPLORATION_OFFSETS)
    offset_x, offset_y = EXPLORATION_OFFSETS[sector]
    return core_position[0] + offset_x * ring, core_position[1] + offset_y * ring


def _claim_sector(
    unit: object,
    assignments: dict[UUID, int],
    claimed_sectors: set[int],
) -> int:
    existing = assignments.get(unit.id)
    if existing is not None and existing not in claimed_sectors:
        claimed_sectors.add(existing)
        return existing

    sector_count = len(EXPLORATION_OFFSETS)
    preferred = int.from_bytes(_uuid_key(unit.id), "big") % sector_count
    loads = Counter(assignments.values())

    def circular_distance(sector: int) -> int:
        difference = abs(sector - preferred)
        return min(difference, sector_count - difference)

    sector = min(
        range(sector_count),
        key=lambda candidate: (
            candidate in claimed_sectors,
            loads[candidate],
            circular_distance(candidate),
            candidate,
        ),
    )
    assignments[unit.id] = sector
    claimed_sectors.add(sector)
    return sector


def _claim_worker_sector(
    worker: object,
    memory: TacticMemory,
    claimed_sectors: set[int],
) -> int:
    return _claim_sector(worker, memory.worker_sectors, claimed_sectors)


def _choose_scout_target(
    worker: object,
    frontier: list[Position],
    claimed: set[Position],
    pathfinder: Pathfinder,
    danger: DangerMap,
    memory: TacticMemory,
    tick: int,
    core_position: Position,
    sector: int,
    max_radius: int = EXPLORATION_RADIUS,
    priority_targets: set[Position] | None = None,
    prefer_outer_frontier: bool = False,
) -> Position | None:
    """Keep one safe, sector-aligned waypoint until reached or invalidated."""
    priority = priority_targets or set()
    existing = memory.scout_targets.get(worker.id)
    started = memory.scout_target_started.get(worker.id, tick)
    if (
        existing is not None
        and (
            not prefer_outer_frontier
            or not priority
            or existing in priority
        )
        and existing not in claimed
        and existing not in memory.obstacle_cells
        and not danger.is_unsafe(existing)
        and _distance(existing, core_position) <= max_radius
        and _sector_penalty(core_position, existing, sector) < 2.0
        and worker.position != existing
        and tick - started < SCOUT_TARGET_MAX_TICKS
        and pathfinder.distance_to(worker.position, existing) is not None
    ):
        claimed.add(existing)
        return existing

    _clear_scout_target(memory, worker.id)
    scored = []
    for cell in frontier:
        distance = pathfinder.distance_to(worker.position, cell)
        if (
            cell in claimed
            or distance is None
            or danger.is_unsafe(cell)
            or _distance(cell, core_position) > max_radius
        ):
            continue
        if prefer_outer_frontier:
            scored.append(
                (
                    round(danger.score(cell), 3),
                    0 if cell in priority else 1,
                    -_distance(cell, core_position),
                    round(_sector_penalty(core_position, cell, sector), 3),
                    memory.visited_cells[cell],
                    -_scout_information_gain(cell, memory),
                    distance,
                    cell,
                )
            )
        else:
            scored.append(
                (
                    round(danger.score(cell), 3),
                    0 if cell in priority else 1,
                    round(_sector_penalty(core_position, cell, sector), 3),
                    memory.visited_cells[cell],
                    -_scout_information_gain(cell, memory),
                    distance,
                    cell,
                )
            )
    target = min(scored)[-1] if scored else None
    fallback = _sector_waypoint(core_position, sector, max_radius)
    if (
        target is None
        and fallback != worker.position
        and fallback not in claimed
        and fallback not in memory.obstacle_cells
        and not danger.is_unsafe(fallback)
        and _distance(fallback, core_position) <= max_radius
        and pathfinder.distance_to(worker.position, fallback) is not None
    ):
        target = fallback

    if target is not None:
        memory.scout_targets[worker.id] = target
        memory.scout_target_started[worker.id] = tick
        claimed.add(target)
    return target


def _clear_combat_target(memory: TacticMemory, unit_id: UUID) -> None:
    memory.combat_targets.pop(unit_id, None)
    memory.combat_target_started.pop(unit_id, None)


def _choose_combat_patrol_target(
    unit: object,
    frontier: list[Position],
    claimed: set[Position],
    pathfinder: Pathfinder,
    memory: TacticMemory,
    tick: int,
    core_position: Position,
    sector: int,
    max_radius: int,
) -> Position | None:
    existing = memory.combat_targets.get(unit.id)
    started = memory.combat_target_started.get(unit.id, tick)
    if (
        existing is not None
        and existing not in claimed
        and existing not in memory.obstacle_cells
        and _distance(existing, core_position) <= max_radius
        and _sector_penalty(core_position, existing, sector) < 2.0
        and unit.position != existing
        and tick - started < SCOUT_TARGET_MAX_TICKS
        and pathfinder.distance_to(unit.position, existing) is not None
    ):
        claimed.add(existing)
        return existing

    _clear_combat_target(memory, unit.id)
    radius = (
        VIEW_RADIUS_VANGUARD
        if _unit_type_of(unit) is UnitType.VANGUARD
        else VIEW_RADIUS_RANGER
    )
    scored = []
    for cell in frontier:
        distance = pathfinder.distance_to(unit.position, cell)
        if (
            cell in claimed
            or distance is None
            or _distance(cell, core_position) > max_radius
        ):
            continue
        scored.append(
            (
                round(_sector_penalty(core_position, cell, sector), 3),
                memory.visited_cells[cell],
                -_scout_information_gain(cell, memory, radius),
                distance,
                cell,
            )
        )
    target = min(scored)[4] if scored else None
    fallback_radius = min(COMBAT_PATROL_RADIUS, max_radius)
    offset_x, offset_y = EXPLORATION_OFFSETS[sector]
    fallback = (
        core_position[0] + offset_x * fallback_radius,
        core_position[1] + offset_y * fallback_radius,
    )
    if (
        target is None
        and fallback not in claimed
        and fallback not in memory.obstacle_cells
        and pathfinder.distance_to(unit.position, fallback) is not None
    ):
        target = fallback

    if target is not None:
        memory.combat_targets[unit.id] = target
        memory.combat_target_started[unit.id] = tick
        claimed.add(target)
    return target


def _assign_resources(
    seekers: list[object],
    candidates: set[Position],
    claimed: set[Position],
    visible_resources: set[Position],
    core_position: Position | None,
    pathfinder: Pathfinder,
    memory: TacticMemory,
    danger: DangerMap | None = None,
    resource_radius: int | None = None,
) -> tuple[dict[UUID, Position], set[Position]]:
    """Assign distinct nodes by whole-cycle cost and worker opportunity regret.

    The cost includes travel to the node, the expected return trip to the Core,
    danger, stale-memory uncertainty and target stickiness. Workers with only
    one good option are assigned before flexible workers, avoiding the common
    greedy failure where a flexible Worker steals another's only nearby node.

    ``resource_radius`` is a route-efficiency ceiling, not a coordinate circle:
    a node must have a known return path no longer than the configured radius,
    and the Worker's outbound plus return path may not exceed two radii. This
    keeps a Worker on the wrong side of the Core from accepting a technically
    nearby but unproductive cross-map trip.
    """
    open_cells = sorted(cell for cell in candidates if cell not in claimed)
    if not seekers or not open_cells:
        return {}, set()

    return_distances: dict[Position, int] = {}
    if core_position is not None:
        for cell in open_cells:
            return_trip = pathfinder.distance_to(core_position, cell)
            if return_trip is None:
                continue
            if resource_radius is not None and return_trip > resource_radius:
                continue
            return_distances[cell] = return_trip

    ranked: dict[UUID, list[tuple[float, Position]]] = {}
    feasible_cells: set[Position] = set()
    for worker in seekers:
        distances = pathfinder.distances(worker.position)
        options: list[tuple[float, Position]] = []
        for cell in open_cells:
            travel = distances.get(cell)
            if travel is None:
                travel = pathfinder.distance_to(worker.position, cell)
            if travel is None:
                continue
            cost = float(travel)
            if core_position is not None:
                return_trip = return_distances.get(cell)
                if return_trip is None:
                    continue
                if (
                    resource_radius is not None
                    and travel + return_trip > resource_radius * 2
                ):
                    continue
                cost += RETURN_TRIP_WEIGHT * return_trip
            if cell not in visible_resources:
                cost += REMEMBERED_NODE_PENALTY
            if danger is not None:
                cost += danger.score(cell)
                if danger.is_unsafe(cell):
                    cost += DANGER_NODE_PENALTY
            if memory.worker_targets.get(worker.id) == cell:
                cost -= STICKY_TARGET_BONUS
            options.append((cost, cell))
            feasible_cells.add(cell)
        ranked[worker.id] = sorted(options)

    assignment: dict[UUID, Position] = {}
    available_cells = set(open_cells)
    remaining_workers = {worker.id for worker in seekers}
    while available_cells and remaining_workers:
        proposals: list[tuple[float, float, bytes, UUID, Position]] = []
        for worker_id in sorted(remaining_workers, key=_uuid_key):
            options = [
                option for option in ranked.get(worker_id, ())
                if option[1] in available_cells
            ]
            if not options:
                continue
            best_cost, best_cell = options[0]
            regret = (
                options[1][0] - best_cost
                if len(options) > 1
                else float("inf")
            )
            proposals.append(
                (-regret, best_cost, _uuid_key(worker_id), worker_id, best_cell)
            )
        if not proposals:
            break
        _, _, _, worker_id, cell = min(proposals)
        assignment[worker_id] = cell
        remaining_workers.remove(worker_id)
        available_cells.remove(cell)
    return assignment, feasible_cells


# --------------------------------------------------------------------------
# Worker control
# --------------------------------------------------------------------------
def _control_workers_legacy(
    turn: Turn,
    movement: MovementPlanner,
    memory: TacticMemory,
) -> None:
    claimed_resources: set[Position] = set()
    core = turn.core
    core_is_receptive = core is not None and core.view.state is CoreState.NORMAL
    remaining_deposit_space = turn.resource_space

    workers = sorted(turn.workers, key=lambda item: _uuid_key(item.id))
    for worker_index, worker in enumerate(workers):
        if worker.cargo:
            memory.worker_targets.pop(worker.id, None)
            if (
                core_is_receptive
                and worker.position == core.position
                and remaining_deposit_space > 0
            ):
                worker.deposit()
                delivered = min(worker.cargo, remaining_deposit_space)
                remaining_deposit_space -= delivered
                memory.planned_deposit_this_turn += delivered
                memory.planned_deposited += delivered
            elif core is not None and worker.position != core.position:
                movement.move_toward(worker, core.position)
            continue

        if worker.position in turn.resource_cells and worker.position not in claimed_resources:
            worker.harvest()
            claimed_resources.add(worker.position)
            memory.worker_targets[worker.id] = worker.position
            continue

        current_resources = set(turn.resource_cells)
        existing_target = memory.worker_targets.get(worker.id)
        target = _choose_resource_target(
            worker.position,
            current_resources,
            claimed_resources,
            current_resources,
        )
        if (
            target is None
            and existing_target in memory.resource_hints
            and existing_target not in claimed_resources
        ):
            target = existing_target
        if target is None:
            target = _choose_resource_target(
                worker.position,
                memory.resource_hints,
                claimed_resources,
                current_resources,
            )
        if target is not None:
            claimed_resources.add(target)
            memory.worker_targets[worker.id] = target
            movement.move_toward(worker, target)
        elif core is not None:
            memory.worker_targets.pop(worker.id, None)
            movement.move_toward(
                worker,
                _exploration_target(turn, worker_index, core.position),
            )


def _control_workers(
    turn: Turn,
    movement: MovementPlanner,
    memory: TacticMemory,
    assessment: ThreatAssessment,
    config: StrategyConfig,
) -> None:
    if turn.core is not None and turn.core.view.state is CoreState.MOVING:
        _evacuate_workers_during_core_move(turn, movement, memory, config)
        return

    if not ECONOMY_MODE:
        memory.scout_targets.clear()
        memory.scout_target_started.clear()
        _control_workers_legacy(turn, movement, memory)
        return

    core = turn.core
    core_position = core.position if core is not None else None
    core_is_receptive = core is not None and core.view.state is CoreState.NORMAL
    remaining_deposit_space = turn.resource_space
    storage_full = remaining_deposit_space <= 0
    pathfinder = movement.pathfinder
    danger = movement.danger

    visible_resources = set(turn.resource_cells)
    claimed: set[Position] = set()
    seekers: list[object] = []
    returning: list[object] = []
    overflow_scouts: list[object] = []
    fleeing: list[object] = []

    workers = sorted(turn.workers, key=lambda item: _uuid_key(item.id))
    memory.worker_ticks += len(workers)

    # ---- phase 1: act in place (deposit / flee / keep mining) ------------
    for worker in workers:
        if worker.id in memory.population_relief_worker_ids:
            continue
        carrying = worker.cargo > 0
        if carrying:
            memory.begin_worker_cycle(worker.id, turn.tick)
        at_core = core_position is not None and worker.position == core_position

        if (
            carrying
            and core_is_receptive
            and at_core
            and remaining_deposit_space > 0
        ):
            delivered = min(worker.cargo, remaining_deposit_space)
            worker.deposit()
            remaining_deposit_space -= delivered
            storage_full = remaining_deposit_space <= 0
            memory.planned_deposit_this_turn += delivered
            memory.planned_deposited += delivered
            memory.worker_targets.pop(worker.id, None)
            _clear_scout_target(memory, worker.id)
            continue

        if (
            at_core
            and core_is_receptive
            and _missing_hp(worker) > 0
            and turn.resources + memory.planned_deposit_this_turn > 0
        ):
            worker.heal()
            memory.worker_targets.pop(worker.id, None)
            _clear_scout_target(memory, worker.id)
            continue

        # Safety first: never mine or scout while standing in a threatened cell.
        if danger.is_unsafe(worker.position) and not at_core:
            memory.worker_targets.pop(worker.id, None)
            _clear_scout_target(memory, worker.id)
            memory.fleeing_worker_ticks += 1
            fleeing.append(worker)
            continue

        # Wounded workers return only when the shared posture says safety matters.
        if assessment.safety_first and not at_core and _is_hurt(worker, memory):
            memory.worker_targets.pop(worker.id, None)
            _clear_scout_target(memory, worker.id)
            returning.append(worker)
            continue

        block_target = memory.worker_block_targets.get(worker.id)
        if block_target is not None:
            memory.worker_targets.pop(worker.id, None)
            _clear_scout_target(memory, worker.id)
            movement.move_toward(worker, block_target, avoid_danger=True)
            continue

        on_node = worker.position in visible_resources and worker.position not in claimed
        if on_node and not carrying and not storage_full:
            worker.harvest()
            memory.begin_worker_cycle(worker.id, turn.tick)
            claimed.add(worker.position)
            memory.worker_targets[worker.id] = worker.position
            _clear_scout_target(memory, worker.id)
            continue

        if carrying:
            memory.worker_targets.pop(worker.id, None)
            if storage_full:
                overflow_scouts.append(worker)
            else:
                _clear_scout_target(memory, worker.id)
                returning.append(worker)
            continue

        seekers.append(worker)

    # ---- phase 2: global assignment of idle workers ----------------------
    reachable_nodes = (visible_resources | memory.resource_hints) - movement.enemy_cells
    resource_radius = _resource_radius(turn, memory, config)
    assignment_radius = resource_radius
    candidates = {cell for cell in reachable_nodes if not danger.is_unsafe(cell)}
    if not candidates and assessment.posture == POSTURE_ECONOMY:
        # In economy posture, mildly contested nodes remain candidates; the
        # whole-cycle danger cost still steers workers toward the safest option.
        candidates = reachable_nodes

    if storage_full:
        assignment: dict[UUID, Position] = {}
        feasible_cells: set[Position] = set()
    else:
        assignment, feasible_cells = _assign_resources(
            seekers,
            candidates,
            claimed,
            visible_resources,
            core_position,
            pathfinder,
            memory,
            danger,
            assignment_radius,
        )
        if assessment.posture == POSTURE_ECONOMY and len(assignment) < len(seekers):
            expanded_radius = max(
                assignment_radius or 0,
                ECONOMY_MIN_RECOVERY_RADIUS,
                config.adaptive_economy.max_resource_radius,
            )
            if expanded_radius > (assignment_radius or 0):
                expanded_assignment, expanded_feasible = _assign_resources(
                    seekers,
                    candidates,
                    claimed,
                    visible_resources,
                    core_position,
                    pathfinder,
                    memory,
                    danger,
                    expanded_radius,
                )
                if len(expanded_assignment) > len(assignment):
                    assignment = expanded_assignment
                feasible_cells |= expanded_feasible
                assignment_radius = expanded_radius

    memory.resource_radius_limit = assignment_radius

    active_resource_cells = claimed | set(assignment.values())
    memory.resource_candidate_count = len(feasible_cells | claimed)
    memory.resource_assignment_count = len(active_resource_cells)
    if core_position is not None and active_resource_cells:
        active_distances = [
            pathfinder.distance_to(core_position, cell)
            for cell in active_resource_cells
        ]
        known_distances = [
            distance for distance in active_distances if distance is not None
        ]
        if known_distances:
            memory.effective_resource_radius = max(known_distances)

    # ---- phase 3: miners first, then sector scouts and full-storage patrols -
    for worker in seekers:
        target = assignment.get(worker.id)
        if target is None:
            continue
        claimed.add(target)
        memory.worker_targets[worker.id] = target
        memory.begin_worker_cycle(worker.id, turn.tick)
        _clear_scout_target(memory, worker.id)
        movement.move_toward(worker, target, avoid_danger=True)

    exploration_workers = [
        worker for worker in seekers if worker.id not in assignment
    ]
    exploration_workers.extend(overflow_scouts)
    idle_workers = len(exploration_workers)
    scout_budget = assessment.scout_budget(
        len(workers),
        idle_workers,
        len(candidates),
        config,
    )
    if assessment.posture != POSTURE_ECONOMY:
        scout_budget = min(
            scout_budget,
            _worker_scout_limit(turn, memory, config),
        )
    exploration_radius = _exploration_radius(turn, memory, config)
    resource_shortage = len(assignment) < len(seekers) and not storage_full
    scarcity_expedition = (
        resource_shortage
        and assessment.posture == POSTURE_ECONOMY
        and config.adaptive_economy.enabled
        and memory.adaptive_scarcity_streak
        >= config.adaptive_economy.scarcity_ticks
    )
    if (resource_shortage or storage_full) and assessment.posture == POSTURE_ECONOMY:
        scout_budget = idle_workers
        exploration_radius = max(
            exploration_radius,
            ECONOMY_MIN_RECOVERY_RADIUS,
            config.adaptive_economy.max_resource_radius,
        )
    frontier: list[Position] = []
    frontier_targets: list[Position] = []
    patrol_targets: set[Position] = set()
    if idle_workers > 0 and scout_budget > 0:
        frontier_targets = [
            cell
            for cell in _frontier_targets(memory, pathfinder)
            if not danger.is_unsafe(cell)
            and (
                core_position is None
                or _distance(cell, core_position) <= exploration_radius
            )
        ]
        if (resource_shortage or storage_full) and core_position is not None:
            patrol_targets.update(
                _resource_chunk_patrol_targets(
                    memory,
                    pathfinder,
                    core_position,
                    exploration_radius,
                )
            )
        if core_position is not None:
            patrol_targets.update(
                _stale_visibility_patrol_targets(
                    memory,
                    pathfinder,
                    core_position,
                    turn.tick,
                    exploration_radius,
                )
            )
        frontier = sorted(set(frontier_targets) | patrol_targets)
        if assessment.safety_first and core_position is not None:
            frontier = [
                cell
                for cell in frontier
                if _distance(cell, core_position)
                <= config.workers.safe_scout_radius
            ]
            patrol_targets = {
                cell
                for cell in patrol_targets
                if _distance(cell, core_position)
                <= config.workers.safe_scout_radius
            }
    outer_frontier = set(frontier_targets) if scarcity_expedition else set()
    preferred_targets = outer_frontier or patrol_targets
    claimed_frontier: set[Position] = set(assignment.values()) | claimed
    claimed_sectors: set[int] = set()
    scouts_sent = 0

    for worker_index, worker in enumerate(exploration_workers):
        memory.worker_targets.pop(worker.id, None)

        if scouts_sent >= scout_budget or core_position is None:
            _clear_scout_target(memory, worker.id)
            if core_position is not None:
                movement.move_toward(
                    worker,
                    _staging_waypoint(core_position, worker_index),
                    avoid_danger=True,
                )
            continue

        existing_scout = memory.scout_targets.get(worker.id)
        if (
            assessment.safety_first
            and existing_scout is not None
            and _distance(existing_scout, core_position)
            > config.workers.safe_scout_radius
        ):
            _clear_scout_target(memory, worker.id)
        if (
            existing_scout is not None
            and _distance(existing_scout, core_position) > exploration_radius
        ):
            _clear_scout_target(memory, worker.id)

        sector = _claim_worker_sector(worker, memory, claimed_sectors)
        scout_target = _choose_scout_target(
            worker,
            frontier,
            claimed_frontier,
            pathfinder,
            danger,
            memory,
            turn.tick,
            core_position,
            sector,
            exploration_radius,
            preferred_targets,
            bool(outer_frontier),
        )

        if scout_target is not None:
            scouts_sent += 1
            memory.scouting_worker_ticks += 1
            movement.move_toward(worker, scout_target, avoid_danger=True)
        else:
            _clear_scout_target(memory, worker.id)
            movement.move_toward(
                worker,
                _staging_waypoint(core_position, worker_index),
                avoid_danger=True,
            )

    # ---- phase 4: haulers head home --------------------------------------
    if core_position is not None:
        for worker in returning:
            memory.worker_targets.pop(worker.id, None)
            if worker.position != core_position:
                movement.move_toward(worker, core_position, avoid_danger=True)

    # ---- phase 5: threatened workers run for safety ----------------------
    for worker in fleeing:
        retreat = _retreat_target(worker, danger, pathfinder, core_position)
        if retreat is not None and retreat != worker.position:
            movement.move_toward(worker, retreat, avoid_danger=True)


# --------------------------------------------------------------------------
# Combat control
# --------------------------------------------------------------------------
def _elapsed_ticks(turn: Turn, memory: TacticMemory) -> int:
    first_tick = turn.tick if memory.first_tick is None else memory.first_tick
    return max(0, turn.tick - first_tick)


def _strategy_phase(turn: Turn, memory: TacticMemory, config: StrategyConfig) -> str:
    """Choose a monotonic economy phase from time and population readiness.

    The early phase ends when either enough time has passed or enough population
    has been built. The late phase requires both the time and population gates,
    so an economy cannot launch a broad offensive just because the clock is old.
    """
    if not config.pacing.enabled:
        return PHASE_LATE
    elapsed = _elapsed_ticks(turn, memory)
    population = len(turn.units)
    if (
        elapsed < config.pacing.early_ticks
        and population < config.pacing.early_population
    ):
        return PHASE_EARLY
    if (
        elapsed < config.pacing.mid_ticks
        or population < config.pacing.mid_population
    ):
        return PHASE_MID
    return PHASE_LATE


def _phase_value(phase: str, early: int, mid: int, late: int) -> int:
    if phase == PHASE_EARLY:
        return early
    if phase == PHASE_MID:
        return mid
    return late

def _configured_worker_target(config: StrategyConfig) -> int:
    for step in config.production.order:
        if step.unit_type == UnitType.WORKER.value:
            return step.target
    return EARLY_WORKER_TARGET


def _effective_worker_target(
    memory: TacticMemory | None,
    config: StrategyConfig,
) -> int:
    base_target = _configured_worker_target(config)
    if (
        memory is None
        or not config.adaptive_economy.enabled
        or config.production.after_plan == "hold"
        or memory.adaptive_worker_target is None
    ):
        return base_target
    adaptive = config.adaptive_economy
    return max(
        adaptive.worker_target_min,
        min(adaptive.worker_target_max, memory.adaptive_worker_target),
    )


def _base_resource_radius(
    turn: Turn,
    memory: TacticMemory,
    config: StrategyConfig,
) -> int | None:
    if not config.pacing.enabled:
        if not config.adaptive_economy.enabled:
            return None
        # With phase pacing disabled, use the operator's full configured range.
        # Safety posture still applies ``safe_scout_radius`` below.
        return config.adaptive_economy.max_resource_radius
    phase = _strategy_phase(turn, memory, config)
    return _phase_value(
        phase,
        config.pacing.early_resource_radius,
        config.pacing.mid_resource_radius,
        config.pacing.late_resource_radius,
    )


def _adjust_resource_radius(
    turn: Turn,
    memory: TacticMemory,
    config: StrategyConfig,
    change: int,
) -> bool:
    base_radius = _base_resource_radius(turn, memory, config)
    if base_radius is None:
        memory.adaptive_radius_delta = 0
        return False
    adaptive = config.adaptive_economy
    current = max(
        adaptive.min_resource_radius,
        min(adaptive.max_resource_radius, base_radius + memory.adaptive_radius_delta),
    )
    updated = max(
        adaptive.min_resource_radius,
        min(adaptive.max_resource_radius, current + change),
    )
    memory.adaptive_radius_delta = updated - base_radius
    return updated != current


def _update_adaptive_economy(
    turn: Turn,
    memory: TacticMemory,
    config: StrategyConfig,
    assessment: ThreatAssessment,
) -> None:
    adaptive = config.adaptive_economy
    base_worker_target = _configured_worker_target(config)
    if (
        memory.adaptive_worker_target is None
        or memory.adaptive_worker_base_target != base_worker_target
    ):
        memory.adaptive_worker_base_target = base_worker_target
        memory.adaptive_worker_target = max(
            adaptive.worker_target_min,
            min(adaptive.worker_target_max, base_worker_target),
        )

    samples = memory.economy_history[-adaptive.window_ticks:]
    memory.adaptive_sample_count = len(samples)
    worker_ticks = sum(sample.get("workers", 0) for sample in samples)
    deposited = sum(sample.get("deposited", 0) for sample in samples)
    busy_ticks = sum(sample.get("busy", 0) for sample in samples)
    harvest_attempts = sum(
        sample.get("harvest_successes", 0) + sample.get("harvest_failures", 0)
        for sample in samples
    )
    harvest_failures = sum(sample.get("harvest_failures", 0) for sample in samples)
    full_samples = sum(
        int(
            sample.get("storage_full", 0) > 0
            or sample.get("deposit_full", 0) > 0
        )
        for sample in samples
    )
    scout_ticks = sum(sample.get("scouts", 0) for sample in samples)
    new_cells = sum(sample.get("new_cells", 0) for sample in samples)

    memory.adaptive_throughput = deposited / worker_ticks if worker_ticks else 0.0
    memory.adaptive_utilization = busy_ticks / worker_ticks if worker_ticks else 0.0
    memory.adaptive_failure_rate = (
        harvest_failures / harvest_attempts if harvest_attempts else 0.0
    )
    recent_cycles = memory.cycle_durations[-adaptive.window_ticks:]
    memory.adaptive_average_cycle_ticks = (
        sum(recent_cycles) / len(recent_cycles) if recent_cycles else 0.0
    )
    memory.adaptive_storage_full_ratio = (
        full_samples / len(samples) if samples else 0.0
    )
    memory.adaptive_new_cells_per_scout = (
        new_cells / scout_ticks if scout_ticks else 0.0
    )

    scarcity_streak = 0
    for sample in reversed(samples):
        workers = max(0, sample.get("workers", 0))
        required_candidates = max(1, (workers + 1) // 2)
        if (
            workers <= 0
            or sample.get("storage_full", 0)
            or sample.get("candidates", 0) >= required_candidates
        ):
            break
        scarcity_streak += 1
    memory.adaptive_scarcity_streak = scarcity_streak

    if not adaptive.enabled:
        memory.adaptive_radius_delta = 0
        memory.adaptive_scout_bonus = 0
        memory.adaptive_worker_target = base_worker_target
        memory.adaptive_action = "DISABLED"
        memory.adaptive_reason = "disabled_by_config"
        return

    if len(samples) < adaptive.warmup_ticks:
        memory.adaptive_action = "WARMUP"
        memory.adaptive_reason = "collecting_samples"
        return

    if (
        memory.adaptive_last_adjust_tick is not None
        and turn.tick - memory.adaptive_last_adjust_tick
        < adaptive.adjustment_cooldown_ticks
    ):
        memory.adaptive_action = "COOLDOWN"
        memory.adaptive_reason = "recent_adjustment"
        return

    changed = False
    action = "HOLD"
    reason = "metrics_stable"
    candidates = sum(sample.get("candidates", 0) for sample in samples)
    average_workers = worker_ticks / len(samples) if samples else 0.0
    average_candidates = candidates / len(samples) if samples else 0.0

    if assessment.safety_first or memory.recent_worker_loss(turn.tick):
        changed = _adjust_resource_radius(
            turn, memory, config, -adaptive.radius_step
        )
        previous_bonus = memory.adaptive_scout_bonus
        memory.adaptive_scout_bonus = max(0, previous_bonus - 1)
        changed = changed or memory.adaptive_scout_bonus != previous_bonus
        action = "CONSERVE"
        reason = "safety_pressure"
    elif memory.adaptive_storage_full_ratio >= adaptive.storage_full_ratio:
        changed = _adjust_resource_radius(
            turn, memory, config, -adaptive.radius_step
        )
        previous_bonus = memory.adaptive_scout_bonus
        memory.adaptive_scout_bonus = max(0, previous_bonus - 1)
        previous_target = memory.adaptive_worker_target or base_worker_target
        memory.adaptive_worker_target = max(
            adaptive.worker_target_min, previous_target - 1
        )
        changed = changed or memory.adaptive_scout_bonus != previous_bonus
        changed = changed or memory.adaptive_worker_target != previous_target
        action = "CONSERVE"
        reason = "storage_often_full"
    elif scarcity_streak >= adaptive.scarcity_ticks:
        changed = _adjust_resource_radius(
            turn, memory, config, adaptive.radius_step
        )
        previous_bonus = memory.adaptive_scout_bonus
        memory.adaptive_scout_bonus = min(
            adaptive.max_scout_bonus, previous_bonus + 1
        )
        changed = changed or memory.adaptive_scout_bonus != previous_bonus
        action = "EXPAND_SEARCH"
        reason = "resource_scarcity"
    elif (
        memory.adaptive_failure_rate >= adaptive.max_harvest_failure_rate
        or (
            memory.adaptive_average_cycle_ticks > adaptive.long_cycle_ticks
            and candidates > 0
        )
    ):
        changed = _adjust_resource_radius(
            turn, memory, config, -adaptive.radius_step
        )
        previous_bonus = memory.adaptive_scout_bonus
        memory.adaptive_scout_bonus = min(
            adaptive.max_scout_bonus, previous_bonus + 1
        )
        changed = changed or memory.adaptive_scout_bonus != previous_bonus
        action = "TIGHTEN_ROUTES"
        reason = "failures_or_long_cycles"
    elif (
        memory.adaptive_throughput >= adaptive.healthy_throughput_per_worker
        and memory.adaptive_utilization >= 0.55
        and average_candidates >= max(1.0, average_workers * 0.5)
        and getattr(turn, "resource_space", 0) > 0
    ):
        previous_target = memory.adaptive_worker_target or base_worker_target
        memory.adaptive_worker_target = min(
            adaptive.worker_target_max, previous_target + 1
        )
        changed = memory.adaptive_worker_target != previous_target
        action = "GROW_WORKERS"
        reason = "healthy_throughput"
    elif (
        memory.adaptive_throughput <= adaptive.low_throughput_per_worker
        and candidates > 0
    ):
        changed = _adjust_resource_radius(
            turn, memory, config, -adaptive.radius_step
        )
        if memory.adaptive_utilization < 0.4:
            previous_target = memory.adaptive_worker_target or base_worker_target
            memory.adaptive_worker_target = max(
                adaptive.worker_target_min, previous_target - 1
            )
            changed = changed or memory.adaptive_worker_target != previous_target
        action = "TIGHTEN_ROUTES"
        reason = "low_throughput"

    if changed:
        memory.adaptive_last_adjust_tick = turn.tick
        memory.adaptive_action = action
        memory.adaptive_reason = reason
    else:
        memory.adaptive_action = "HOLD"
        memory.adaptive_reason = "stable_or_at_limit"



def _resource_radius(
    turn: Turn,
    memory: TacticMemory,
    config: StrategyConfig,
) -> int | None:
    base_radius = _base_resource_radius(turn, memory, config)
    if base_radius is None:
        return None
    if not config.adaptive_economy.enabled:
        return base_radius
    adaptive = config.adaptive_economy
    return max(
        adaptive.min_resource_radius,
        min(adaptive.max_resource_radius, base_radius + memory.adaptive_radius_delta),
    )


def _exploration_radius(
    turn: Turn,
    memory: TacticMemory,
    config: StrategyConfig,
) -> int:
    if not config.pacing.enabled:
        base_radius = _base_resource_radius(turn, memory, config)
        if base_radius is None:
            base_radius = EXPLORATION_RADIUS
    else:
        phase = _strategy_phase(turn, memory, config)
        base_radius = _phase_value(
            phase,
            config.pacing.early_exploration_radius,
            config.pacing.mid_exploration_radius,
            config.pacing.late_exploration_radius,
        )
    if config.adaptive_economy.enabled:
        base_radius += max(0, memory.adaptive_radius_delta)
        adaptive = config.adaptive_economy
        expedition_level = max(
            0,
            memory.adaptive_scarcity_streak - adaptive.scarcity_ticks + 1,
        )
        if expedition_level:
            expedition_step = max(
                SCARCITY_EXPEDITION_MIN_STEP,
                adaptive.radius_step,
            )
            if memory.adaptive_new_cells_per_scout < SCARCITY_EXPEDITION_LOW_GAIN:
                expedition_step += VIEW_RADIUS_WORKER
            expanded_radius = min(
                PATH_MAX_DISTANCE,
                base_radius + expedition_level * expedition_step,
            )
            base_radius = max(base_radius, expanded_radius)
    return min(500, base_radius)


def _worker_scout_limit(
    turn: Turn,
    memory: TacticMemory,
    config: StrategyConfig,
) -> int:
    if not config.pacing.enabled:
        base_limit = config.workers.max_economy_scouts
    else:
        phase = _strategy_phase(turn, memory, config)
        base_limit = _phase_value(
            phase,
            config.pacing.early_worker_scouts,
            config.pacing.mid_worker_scouts,
            config.pacing.late_worker_scouts,
        )
    bonus = (
        memory.adaptive_scout_bonus if config.adaptive_economy.enabled else 0
    )
    return min(100, base_limit + bonus)


def _offense_economy_ready(
    turn: Turn,
    memory: TacticMemory,
    config: StrategyConfig,
) -> bool:
    pacing = config.pacing
    return (
        pacing.enabled
        and pacing.offense_enabled
        and _strategy_phase(turn, memory, config) == PHASE_LATE
        and _elapsed_ticks(turn, memory) >= pacing.offense_after_ticks
        and turn.resources >= pacing.offense_min_resources
        and len(turn.units) >= pacing.offense_min_population
    )


def _offense_ready(
    turn: Turn,
    memory: TacticMemory,
    config: StrategyConfig,
) -> bool:
    if not _offense_economy_ready(turn, memory, config):
        return False
    pacing = config.pacing
    return (
        len(turn.vanguards) >= pacing.offense_min_vanguards
        and len(turn.rangers) >= pacing.offense_min_rangers
        and len(turn.vanguards) + len(turn.rangers)
        >= pacing.offense_min_defenders
    )


def _combat_scout_radius(
    turn: Turn,
    memory: TacticMemory,
    config: StrategyConfig,
) -> int:
    if config.pacing.enabled:
        return min(
            _exploration_radius(turn, memory, config),
            config.vanguards.late_scout_radius
            if _strategy_phase(turn, memory, config) == PHASE_LATE
            else config.vanguards.early_scout_radius,
        )
    return (
        config.vanguards.early_scout_radius
        if _elapsed_ticks(turn, memory) < config.vanguards.beacon_after_ticks
        else config.vanguards.late_scout_radius
    )


def _beacon_runner_id(
    turn: Turn,
    memory: TacticMemory,
    assessment: ThreatAssessment,
    config: StrategyConfig,
) -> UUID | None:
    """Delay the public Beacon objective until the fleet can realistically hold it."""
    if (
        turn.beacon.status is not BeaconStatus.GROUND
        or assessment.posture != POSTURE_ECONOMY
        or assessment.defenders < config.vanguards.beacon_min_defenders
        or _elapsed_ticks(turn, memory) < config.vanguards.beacon_after_ticks
        or not turn.vanguards
    ):
        return None
    return min(
        turn.vanguards,
        key=lambda unit: (
            _distance(unit.position, turn.beacon.position),
            _uuid_key(unit.id),
        ),
    ).id


def _control_vanguards(
    turn: Turn,
    movement: MovementPlanner,
    memory: TacticMemory,
    assessment: ThreatAssessment,
    config: StrategyConfig,
) -> None:
    if turn.core is None:
        return

    core = turn.core
    core_moving = core.view.state is CoreState.MOVING
    visible_enemies = sorted(
        turn.visible_enemies,
        key=lambda enemy: _enemy_priority(enemy, core.position),
    )
    tracks = _active_tracks(memory, core.position)
    defense_tracks = [
        item
        for item in tracks
        if _distance(item[1].position, core.position) <= DEFENSE_RADIUS + 2
        and (_track_is_combat_threat(item[1]) or item[1].kind == "CORE")
    ]
    core_under_threat = any(
        _track_is_combat_threat(track) for _, track in defense_tracks
    ) or assessment.recent_core_damage
    mission_tracks = defense_tracks if core_under_threat else tracks

    scout_radius = _combat_scout_radius(turn, memory, config)
    frontier = [
        cell
        for cell in _frontier_targets(memory, movement.pathfinder)
        if _distance(cell, core.position) <= scout_radius
    ]
    stale_targets = _stale_visibility_patrol_targets(
        memory,
        movement.pathfinder,
        core.position,
        turn.tick,
        scout_radius,
    )
    frontier = sorted(set(frontier) | set(stale_targets))
    claimed_targets: set[Position] = set()
    claimed_sectors: set[int] = set()
    beacon_runner = _beacon_runner_id(turn, memory, assessment, config)

    for index, vanguard in enumerate(
        sorted(turn.vanguards, key=lambda item: _uuid_key(item.id))
    ):
        if _missing_hp(vanguard) > 0:
            _clear_combat_target(memory, vanguard.id)
            if vanguard.position == core.position and not core_moving:
                vanguard.heal()
            else:
                movement.move_toward(
                    vanguard,
                    core.position,
                    avoid_danger=core_moving,
                )
            continue

        adjacent = [
            enemy
            for enemy in visible_enemies
            if _distance(vanguard.position, enemy.position) == 1
        ]
        if adjacent:
            _clear_combat_target(memory, vanguard.id)
            target = min(
                adjacent,
                key=lambda enemy: _enemy_priority(enemy, core.position),
            )
            vanguard.sweep(_direction_between(vanguard.position, target.position))
            memory.pursuit_unit_ids.add(vanguard.id)
            continue

        tracked = _track_for_unit(vanguard, mission_tracks, memory)
        if tracked is not None:
            destination = _track_destination(
                vanguard,
                tracked[1],
                memory,
                movement.pathfinder,
                turn.tick,
            )
            if destination is not None:
                _clear_combat_target(memory, vanguard.id)
                memory.pursuit_unit_ids.add(vanguard.id)
                movement.move_toward(
                    vanguard,
                    destination,
                    avoid_danger=core_moving,
                )
                continue

        if core_moving or assessment.safety_first:
            _clear_combat_target(memory, vanguard.id)
            movement.move_toward(
                vanguard,
                _staging_waypoint(core.position, index),
                avoid_danger=core_moving,
            )
        elif vanguard.id == beacon_runner:
            _clear_combat_target(memory, vanguard.id)
            if _ground_beacon_at(turn, vanguard.position):
                vanguard.pickup_beacon()
            else:
                movement.move_toward(vanguard, turn.beacon.position)
        else:
            sector = _claim_sector(
                vanguard, memory.combat_sectors, claimed_sectors
            )
            target = _choose_combat_patrol_target(
                vanguard,
                frontier,
                claimed_targets,
                movement.pathfinder,
                memory,
                turn.tick,
                core.position,
                sector,
                scout_radius,
            )
            if target is not None:
                movement.move_toward(vanguard, target)


def _control_rangers(
    turn: Turn,
    movement: MovementPlanner,
    memory: TacticMemory,
    assessment: ThreatAssessment,
    config: StrategyConfig,
) -> None:
    if turn.core is None:
        return

    core = turn.core
    core_moving = core.view.state is CoreState.MOVING
    guard_ids = set(memory.guard_ranger_ids)
    tracks = _active_tracks(memory, core.position)
    defense_tracks = [
        item
        for item in tracks
        if _distance(item[1].position, core.position) <= DEFENSE_RADIUS + 2
        and (_track_is_combat_threat(item[1]) or item[1].kind == "CORE")
    ]
    core_under_threat = any(
        _track_is_combat_threat(track) for _, track in defense_tracks
    ) or assessment.recent_core_damage

    rangers = sorted(
        turn.rangers,
        key=lambda ranger: (
            0 if ranger.id in guard_ids else 1,
            memory.guard_sectors.get(ranger.id, 0),
            _uuid_key(ranger.id),
        ),
    )
    scout_radius = _combat_scout_radius(turn, memory, config)
    frontier = [
        cell
        for cell in _frontier_targets(memory, movement.pathfinder)
        if _distance(cell, core.position)
        <= _combat_scout_radius(turn, memory, config)
    ]
    stale_targets = _stale_visibility_patrol_targets(
        memory,
        movement.pathfinder,
        core.position,
        turn.tick,
        scout_radius,
    )
    frontier = sorted(set(frontier) | set(stale_targets))
    claimed_targets: set[Position] = set()
    claimed_sectors: set[int] = set()
    claimed_shot_cells: set[Position] = set()

    for index, ranger in enumerate(rangers):
        guarding = ranger.id in guard_ids
        if _missing_hp(ranger) > 0:
            _clear_combat_target(memory, ranger.id)
            memory.guard_targets.pop(ranger.id, None)
            if ranger.position == core.position and not core_moving:
                ranger.heal()
            else:
                movement.move_toward(
                    ranger,
                    core.position,
                    avoid_danger=core_moving,
                )
            continue

        shot_cell = _choose_ranger_shot(
            ranger,
            tracks,
            core.position,
            movement.obstacles,
            claimed_shot_cells,
            memory,
            turn.tick,
        )
        if shot_cell is not None:
            _clear_combat_target(memory, ranger.id)
            ranger.shoot_cell(shot_cell)
            if not guarding or core_under_threat:
                memory.pursuit_unit_ids.add(ranger.id)
            continue

        if core_under_threat:
            tracked = _track_for_unit(ranger, defense_tracks, memory)
            if tracked is not None:
                destination = _track_destination(
                    ranger,
                    tracked[1],
                    memory,
                    movement.pathfinder,
                    turn.tick,
                )
                if destination is not None:
                    _clear_combat_target(memory, ranger.id)
                    memory.pursuit_unit_ids.add(ranger.id)
                    movement.move_toward(
                        ranger,
                        destination,
                        avoid_danger=core_moving,
                    )
                    continue
        elif not guarding:
            tracked = _track_for_unit(ranger, tracks, memory)
            if tracked is not None:
                destination = _track_destination(
                    ranger,
                    tracked[1],
                    memory,
                    movement.pathfinder,
                    turn.tick,
                )
                if destination is not None:
                    _clear_combat_target(memory, ranger.id)
                    memory.pursuit_unit_ids.add(ranger.id)
                    movement.move_toward(
                        ranger,
                        destination,
                        avoid_danger=core_moving,
                    )
                    continue

        if core_moving:
            _clear_combat_target(memory, ranger.id)
            movement.move_toward(
                ranger,
                _staging_waypoint(core.position, index),
                avoid_danger=True,
            )
        elif guarding:
            _clear_combat_target(memory, ranger.id)
            target = _ring_guard_target(
                ranger,
                core.position,
                memory,
                movement.pathfinder,
            )
            if target is not None:
                movement.move_toward(ranger, target)
        elif assessment.safety_first:
            _clear_combat_target(memory, ranger.id)
            movement.move_toward(
                ranger,
                _staging_waypoint(core.position, index),
            )
        else:
            sector = _claim_sector(ranger, memory.combat_sectors, claimed_sectors)
            target = _choose_combat_patrol_target(
                ranger,
                frontier,
                claimed_targets,
                movement.pathfinder,
                memory,
                turn.tick,
                core.position,
                sector,
                _combat_scout_radius(turn, memory, config),
            )
            if target is not None:
                movement.move_toward(ranger, target)

def _friendly_holds_beacon(turn: Turn) -> bool:
    if turn.beacon.status is not BeaconStatus.CARRIED or turn.beacon.carrier_id is None:
        return False
    friendly_ids = {unit.id for unit in turn.units}
    if turn.core is not None:
        friendly_ids.add(turn.core.id)
    return turn.beacon.carrier_id in friendly_ids


# --------------------------------------------------------------------------
# Core control
# --------------------------------------------------------------------------
def _quiet_development(
    turn: Turn,
    assessment: ThreatAssessment,
    memory: TacticMemory | None,
) -> bool:
    core = turn.core
    return bool(
        assessment.posture == POSTURE_ECONOMY
        and not (memory is not None and memory.recent_worker_loss(turn.tick))
        and core is not None
        and getattr(core, "hp", 5) >= 4
        and getattr(core, "shield", 5) >= 1
        and len(turn.units) < 20
    )


def _economy_phase(turn: Turn, memory: TacticMemory | None = None) -> bool:
    if not ECONOMY_MODE:
        return False
    first_tick = turn.tick if memory is None or memory.first_tick is None else memory.first_tick
    if not 0 <= turn.tick - first_tick < ECONOMY_RUSH_TICKS:
        return False
    # A worker just died: stop buying economy and stabilise first.
    if memory is not None and memory.recent_worker_loss(turn.tick):
        return False
    return True


def _choose_spawn(
    turn: Turn,
    assessment: ThreatAssessment,
    available_resources: int,
    config: StrategyConfig,
    memory: TacticMemory | None = None,
) -> UnitType | None:
    population = len(turn.units)
    if population >= config.production.max_population:
        return None

    counts = {
        UnitType.WORKER: len(turn.workers),
        UnitType.VANGUARD: len(turn.vanguards),
        UnitType.RANGER: len(turn.rangers),
    }
    if assessment.survival:
        reserve = 0
    elif assessment.safety_first:
        reserve = THREAT_RESOURCE_RESERVE
    else:
        reserve = BASE_RESOURCE_RESERVE
    worker_cost = _unit_cost(turn, UnitType.WORKER)
    defenders = counts[UnitType.VANGUARD] + counts[UnitType.RANGER]
    defender_target = (
        SURVIVAL_DEFENDER_TARGET
        if assessment.survival
        else MIN_DEFENDERS_UNDER_THREAT
    )

    # Keep the economy alive, but once one Worker exists, safety posture takes
    # priority over restoring the normal three-Worker floor.
    if counts[UnitType.WORKER] == 0 and available_resources >= worker_cost:
        return UnitType.WORKER
    if assessment.safety_first and defenders < defender_target:
        for unit_type in (UnitType.VANGUARD, UnitType.RANGER):
            if available_resources >= _unit_cost(turn, unit_type):
                return unit_type

    # A safety posture can otherwise deadlock at one Worker: the first
    # defender costs more than the current bank, while the normal Worker
    # recovery branch waits for a reserve that can never be reached. Use the
    # authoritative dynamic cost to restore a small economy floor only when
    # no defender is affordable yet.
    recovery_worker_floor = max(1, config.workers.recovery_worker_floor)
    cheapest_defender_cost = min(
        _unit_cost(turn, UnitType.VANGUARD),
        _unit_cost(turn, UnitType.RANGER),
    )
    if (
        assessment.safety_first
        and defenders == 0
        and counts[UnitType.WORKER] < recovery_worker_floor
        and available_resources >= worker_cost
        and available_resources < cheapest_defender_cost
    ):
        return UnitType.WORKER

    quiet_development = _quiet_development(turn, assessment, memory)
    worker_first = (
        not config.production.enabled
        or config.production.order[0].unit_type == UnitType.WORKER.value
    )
    early_worker_target = max(
        1, min(_effective_worker_target(memory, config), EARLY_WORKER_TARGET)
    )

    # During a quiet opening, resources should compound immediately:
    # every 5 resources buys another Worker instead of sitting behind a generic
    # reserve. Insert a minimal defensive spine at population milestones, then
    # resume the Worker ramp.
    if (
        quiet_development
        and worker_first
        and counts[UnitType.WORKER] < early_worker_target
        and available_resources >= worker_cost
    ):
        return UnitType.WORKER
    if (
        quiet_development
        and worker_first
        and counts[UnitType.WORKER] >= early_worker_target
        and counts[UnitType.VANGUARD] == 0
    ):
        return (
            UnitType.VANGUARD
            if available_resources >= _unit_cost(turn, UnitType.VANGUARD)
            else None
        )
    if (
        quiet_development
        and worker_first
        and counts[UnitType.WORKER] >= max(10, early_worker_target)
        and counts[UnitType.RANGER] == 0
    ):
        return (
            UnitType.RANGER
            if available_resources >= _unit_cost(turn, UnitType.RANGER)
            else None
        )

    # The dashboard plan is an ordered set of maintained minimums. The first
    # unmet step blocks later steps, so dragging the cards changes real spawn
    # order. Emergency Worker recovery and defender production above still win.
    if config.production.enabled:
        plan_reserve = (
            0
            if quiet_development and worker_first
            else max(reserve, config.production.reserve_resources)
        )
        for step in config.production.order:
            unit_type = UnitType(step.unit_type)
            target = (
                _effective_worker_target(memory, config)
                if unit_type is UnitType.WORKER else step.target
            )
            if counts[unit_type] >= target:
                continue
            if available_resources >= _unit_cost(turn, unit_type) + plan_reserve:
                return unit_type
            return None
        if config.production.after_plan == "hold":
            return None

    # Once the economy is mature, top up the offensive composition even when
    # the normal production card targets have already been reached.
    if _offense_economy_ready(turn, memory or TacticMemory(), config):
        offense_reserve = max(reserve, config.production.reserve_resources)
        offense_targets = (
            (UnitType.VANGUARD, config.pacing.offense_min_vanguards),
            (UnitType.RANGER, config.pacing.offense_min_rangers),
        )
        for unit_type, target in offense_targets:
            if counts[unit_type] >= target:
                continue
            if available_resources >= _unit_cost(turn, unit_type) + offense_reserve:
                return unit_type
            return None

    # Recovery floor in quiet or resource-constrained turns.
    if counts[UnitType.WORKER] < 3 and available_resources >= worker_cost + reserve:
        return UnitType.WORKER

    # Economy rush: buy workers first while the opening window is open.
    if (
        _economy_phase(turn, memory)
        and assessment.posture == POSTURE_ECONOMY
        and counts[UnitType.WORKER] < _effective_worker_target(memory, config)
        and available_resources >= worker_cost
    ):
        return UnitType.WORKER

    spawn_targets = dict(UNIT_TARGETS)
    spawn_targets[UnitType.WORKER] = _effective_worker_target(memory, config)
    candidates = [
        unit_type
        for unit_type in (UnitType.VANGUARD, UnitType.RANGER, UnitType.WORKER)
        if counts[unit_type] < spawn_targets[unit_type]
        and available_resources >= _unit_cost(turn, unit_type) + reserve
    ]
    if not candidates:
        return None

    return min(
        candidates,
        key=lambda unit_type: (
            counts[unit_type] / UNIT_TARGETS[unit_type],
            _unit_cost(turn, unit_type),
        ),
    )


def _core_cover_score(
    position: Position,
    obstacles: set[Position],
    danger: DangerMap,
    resource_hints: set[Position],
) -> float:
    adjacent_obstacles = sum(
        neighbor in obstacles for neighbor in _neighbors(position)
    )
    nearby_obstacles = 0
    for dx in range(-2, 3):
        span = 2 - abs(dx)
        for dy in range(-span, span + 1):
            if (position[0] + dx, position[1] + dy) in obstacles:
                nearby_obstacles += 1
    core_walkable_neighbors = sum(
        neighbor not in obstacles and neighbor not in resource_hints
        for neighbor in _neighbors(position)
    )
    nearest_resource = (
        min(_distance(position, cell) for cell in resource_hints)
        if resource_hints
        else 20
    )
    return (
        -3.5 * adjacent_obstacles
        - 0.9 * nearby_obstacles
        + 0.75 * core_walkable_neighbors
        - 4.0 * danger.score(position)
        - 0.03 * min(nearest_resource, 20)
    )


def _choose_core_migration_direction(
    turn: Turn,
    movement: MovementPlanner,
    memory: TacticMemory,
    assessment: ThreatAssessment,
    config: StrategyConfig,
) -> Direction | None:
    core = turn.core
    if (
        not CORE_MIGRATION_ENABLED
        or not config.core.migration_enabled
        or core is None
        or assessment.score < config.core.migration_danger_score
        or assessment.recent_core_damage
        or len(turn.vanguards) < config.core.migration_min_vanguards
        or len(turn.rangers) < config.core.migration_min_rangers
        or (
            memory.last_core_move_tick is not None
            and turn.tick - memory.last_core_move_tick
            < config.core.migration_cooldown_ticks
        )
    ):
        return None

    obstacles = movement.obstacles
    resource_cells = set(turn.resource_cells)
    resource_hints = set(memory.resource_hints) | resource_cells
    current_score = _core_cover_score(
        core.position, obstacles, movement.danger, resource_hints
    )
    candidates: list[tuple[float, int, Direction]] = []
    for order, direction in enumerate(DIRECTION_ORDER):
        destination = _step(core.position, direction)
        if (
            destination in obstacles
            or destination in resource_cells
            or destination in movement.enemy_cells
            or movement.predicted_occupancy(destination) > 0
        ):
            continue
        legal_exits = sum(
            neighbor not in obstacles and neighbor not in resource_cells
            for neighbor in _neighbors(destination)
        )
        if legal_exits < 2:
            continue
        score = _core_cover_score(
            destination, obstacles, movement.danger, resource_hints
        )
        candidates.append((-score, order, direction))

    if not candidates:
        return None
    negative_score, _, direction = min(candidates)
    best_score = -negative_score
    return (
        direction
        if best_score >= current_score + config.core.cover_gain_required
        else None
    )


def _control_core(
    turn: Turn,
    movement: MovementPlanner,
    memory: TacticMemory,
    assessment: ThreatAssessment,
    config: StrategyConfig,
) -> None:
    core = turn.core
    if core is None:
        return
    if core.view.state is CoreState.MOVING:
        if assessment.recent_core_damage:
            core.cancel_move()
        return
    if core.view.state is not CoreState.NORMAL:
        return

    shield_cap = 10 if _friendly_holds_beacon(turn) else 5
    available_resources = turn.resources + memory.planned_deposit_this_turn
    emergency_ranger_target = _emergency_ranger_target(turn, memory)

    if available_resources > 0 and getattr(core, "hp", 5) < 5:
        core.heal()
        return

    if emergency_ranger_target > len(turn.rangers):
        if available_resources > 0 and core.shield <= 0:
            core.repair_shield()
            return
        effective_population = len(turn.units) - memory.planned_population_relief
        if (
            movement.predicted_occupancy(core.position) == 1
            and effective_population < config.production.max_population
            and available_resources >= _unit_cost(turn, UnitType.RANGER)
        ):
            core.spawn(UnitType.RANGER)
            return

    if assessment.survival and assessment.core_pressure > 0:
        shield_floor = shield_cap
    elif assessment.safety_first:
        shield_floor = 3
    elif _economy_phase(turn, memory):
        shield_floor = 1
    else:
        shield_floor = 3

    if available_resources > 0 and core.shield < shield_floor:
        core.repair_shield()
        return

    if (
        _ground_beacon_at(turn, core.position)
        and assessment.posture == POSTURE_ECONOMY
        and assessment.defenders >= config.vanguards.beacon_min_defenders
        and _elapsed_ticks(turn, memory) >= config.vanguards.beacon_after_ticks
    ):
        core.pickup_beacon()
        return

    # Relocation is a danger response, not a population-timed expansion.
    # Start it before normal production so the escort and worker evacuation
    # plan can take effect on the same Turn.
    migration_direction = _choose_core_migration_direction(
        turn, movement, memory, assessment, config
    )
    if migration_direction is not None:
        core.start_move(migration_direction)
        return

    if movement.predicted_occupancy(core.position) == 1:
        unit_type = _choose_spawn(turn, assessment, available_resources, config, memory)
        if unit_type is not None:
            core.spawn(unit_type)
            return

    if assessment.survival:
        reserve = 0
    elif assessment.safety_first:
        reserve = THREAT_RESOURCE_RESERVE
    else:
        reserve = BASE_RESOURCE_RESERVE
    if _economy_phase(turn, memory) and assessment.posture == POSTURE_ECONOMY:
        return
    if core.shield < shield_cap and available_resources > reserve:
        core.repair_shield()


# --------------------------------------------------------------------------
# Entry points
# --------------------------------------------------------------------------
def choose_actions(
    turn: Turn,
    memory: TacticMemory | None = None,
    config: StrategyConfig | None = None,
) -> None:
    """Queue one complete plan from the current authoritative Turn."""
    if memory is None:
        memory = TacticMemory()
    if config is None:
        # The loader caches by file timestamp, so this is a cheap hot-reload
        # check that makes dashboard saves effective on the next Turn.
        config = load_strategy_config()
    memory.sync_economy_experiment(active_block_id())
    memory.observe(turn)
    if turn.core is None:
        memory.last_posture = "RESPAWNING"
        memory.last_threat_score = 0.0
        return

    obstacles = set(turn.obstacle_cells) | memory.obstacle_cells
    enemy_cells = {enemy.position for enemy in turn.visible_enemies}
    pathfinder = Pathfinder(
        obstacles,
        obstacles | enemy_cells,
        memory.bounds,
        memory.known_cells,
    )
    danger = DangerMap(turn, memory)
    assessment = _assess_threat(turn, memory, danger, config)
    memory.last_posture = assessment.posture
    _update_adaptive_economy(turn, memory, config, assessment)
    memory.last_threat_score = assessment.score
    movement = MovementPlanner(turn, memory, pathfinder, danger)
    guard_ids = _select_guard_rangers(turn, memory)
    _assign_trackers(turn, memory, guard_ids)
    _plan_emergency_population_relief(turn, movement, memory, config)
    _assign_worker_blockers(turn, movement, memory)

    _control_workers(turn, movement, memory, assessment, config)
    _control_vanguards(turn, movement, memory, assessment, config)
    _control_rangers(turn, movement, memory, assessment, config)
    _control_core(turn, movement, memory, assessment, config)


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


def _is_tick_mismatch(error: APIError) -> bool:
    return error.status_code == 409 and error.error == "TICK_MISMATCH"


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
            decision_ms = (time.perf_counter() - decision_started) * 1000.0
            _print_turn_debug(turn, memory, config)
            try:
                accepted = turn.submit()
            except APIError as error:
                if _is_tick_mismatch(error):
                    if DEBUG_TURNS:
                        print(
                            f"tick={turn.tick} skipped=TICK_MISMATCH",
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

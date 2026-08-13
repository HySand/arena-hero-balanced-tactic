"""Canonical SDK-independent state and command-recording models."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from types import SimpleNamespace
from typing import Any, Iterable, Mapping
from uuid import UUID

Position = tuple[int, int]


class Direction(StrEnum):
    UP = "UP"
    DOWN = "DOWN"
    LEFT = "LEFT"
    RIGHT = "RIGHT"

    @property
    def delta(self) -> Position:
        return {
            Direction.UP: (0, -1),
            Direction.DOWN: (0, 1),
            Direction.LEFT: (-1, 0),
            Direction.RIGHT: (1, 0),
        }[self]


class UnitType(StrEnum):
    WORKER = "WORKER"
    VANGUARD = "VANGUARD"
    RANGER = "RANGER"


class CoreState(StrEnum):
    NORMAL = "NORMAL"
    MOVING = "MOVING"


class BeaconStatus(StrEnum):
    GROUND = "GROUND"
    CARRIED = "CARRIED"


class HarvestSource(StrEnum):
    RESOURCE_NODE = "RESOURCE_NODE"
    DROPPED_CARGO = "DROPPED_CARGO"


@dataclass(frozen=True)
class PlannerOptions:
    profile: str = "economy"
    safety_enabled: bool = True
    core_migration_enabled: bool = True

    def __post_init__(self) -> None:
        if self.profile not in {"economy", "balanced"}:
            raise ValueError("profile must be economy or balanced")

    @property
    def economy_mode(self) -> bool:
        return self.profile != "balanced"


def unit_cost(unit_type: UnitType | str, population: int) -> int:
    """Return the Arena production price without importing the SDK."""

    if population < 0:
        raise ValueError("population must not be negative")
    normalized = UnitType(str(unit_type))
    base = {
        UnitType.WORKER: 5,
        UnitType.VANGUARD: 10,
        UnitType.RANGER: 12,
    }[normalized]
    exponent = 0 if population < 20 else (population - 20) // 5 + 1
    numerator = base * 13**exponent
    denominator = 10**exponent
    return (2 * numerator + denominator) // (2 * denominator)


@dataclass(frozen=True)
class RecordedAction:
    type: str
    direction: Direction | None = None
    unit_type: UnitType | None = None
    target_id: UUID | None = None
    expected_cell: Position | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"type": self.type}
        if self.direction is not None:
            result["direction"] = self.direction.value
        if self.unit_type is not None:
            result["unit_type"] = self.unit_type.value
        if self.target_id is not None:
            result["target_id"] = str(self.target_id)
        if self.expected_cell is not None:
            result["expected_cell"] = list(self.expected_cell)
        return result


@dataclass
class Unit:
    id: UUID
    position: Position
    unit_type: UnitType
    hp: int
    cargo: int = 0
    max_hp: int | None = None
    action: RecordedAction | None = field(default=None, init=False)

    def move(self, direction: Direction | str) -> None:
        self.action = RecordedAction("MOVE", direction=Direction(str(direction)))

    def harvest(self) -> None:
        self.action = RecordedAction("HARVEST")

    def deposit(self) -> None:
        self.action = RecordedAction("DEPOSIT")

    def sweep(self, direction: Direction | str) -> None:
        self.action = RecordedAction("SWEEP", direction=Direction(str(direction)))

    def shoot(self, target: object, *, expected_cell: Position | None = None) -> None:
        resolved_cell = expected_cell or getattr(target, "position", None)
        if resolved_cell is None:
            raise ValueError("expected_cell is required when target has no position")
        self.action = RecordedAction(
            "SHOOT",
            target_id=UUID(str(getattr(target, "id", target))),
            expected_cell=resolved_cell,
        )

    def shoot_cell(self, expected_cell: Position) -> None:
        self.action = RecordedAction("SHOOT", expected_cell=expected_cell)

    def heal(self) -> None:
        self.action = RecordedAction("HEAL")

    def pickup_beacon(self) -> None:
        self.action = RecordedAction("PICKUP_BEACON")

    def drop_beacon(self) -> None:
        self.action = RecordedAction("DROP_BEACON")

    def self_destruct(self) -> None:
        self.action = RecordedAction("SELF_DESTRUCT")


@dataclass
class Core:
    id: UUID
    position: Position
    hp: int
    shield: int
    state: CoreState = CoreState.NORMAL
    owner_username: str = ""
    move_direction: Direction | None = None
    move_progress: int | None = None
    move_required_ticks: int | None = None
    destination: Position | None = None
    action: RecordedAction | None = field(default=None, init=False)

    @property
    def view(self) -> SimpleNamespace:
        return SimpleNamespace(state=self.state)

    def spawn(self, unit_type: UnitType | str) -> None:
        self.action = RecordedAction("SPAWN", unit_type=UnitType(str(unit_type)))

    def repair_shield(self) -> None:
        self.action = RecordedAction("REPAIR_SHIELD")

    def heal(self) -> None:
        self.action = RecordedAction("HEAL")

    def pickup_beacon(self) -> None:
        self.action = RecordedAction("PICKUP_BEACON")

    def drop_beacon(self) -> None:
        self.action = RecordedAction("DROP_BEACON")

    def self_destruct(self) -> None:
        self.action = RecordedAction("SELF_DESTRUCT")

    def start_move(self, direction: Direction | str) -> None:
        self.action = RecordedAction("START_MOVE", direction=Direction(str(direction)))

    def cancel_move(self) -> None:
        self.action = RecordedAction("CANCEL_MOVE")


@dataclass(frozen=True)
class Enemy:
    id: UUID
    kind: str
    position: Position
    hp: int
    shield: int = 0
    unit_type: UnitType | None = None


@dataclass(frozen=True)
class Beacon:
    position: Position
    status: BeaconStatus | None = None
    carrier_id: UUID | None = None


@dataclass(frozen=True)
class ResolutionEvent:
    event_type: str
    tick: int | None = None
    reason_code: str | None = None
    position: Position | None = None
    actor_id: UUID | None = None
    target_id: UUID | None = None
    resource_amount: int | None = None
    harvest_source: HarvestSource | None = None
    values: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class CommandPlan:
    tick: int
    unit_actions: Mapping[UUID, RecordedAction]
    core_action: RecordedAction | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"tick": self.tick}
        if self.unit_actions:
            result["unit_actions"] = {
                str(unit_id): action.to_dict()
                for unit_id, action in sorted(
                    self.unit_actions.items(), key=lambda item: item[0].bytes
                )
            }
        if self.core_action is not None:
            result["core_action"] = self.core_action.to_dict()
        return result


@dataclass
class Turn:
    tick: int
    core: Core | None
    units: tuple[Unit, ...]
    resources: int
    resource_space: int
    resource_cells: frozenset[Position]
    obstacle_cells: frozenset[Position]
    visible_enemies: tuple[Enemy, ...]
    events: tuple[ResolutionEvent, ...]
    beacon: Beacon
    population: int
    unit_costs: Mapping[UnitType, int] = field(default_factory=dict)
    options: PlannerOptions = field(default_factory=PlannerOptions)
    width: int | None = None
    height: int | None = None
    workers: tuple[Unit, ...] = field(init=False)
    vanguards: tuple[Unit, ...] = field(init=False)
    rangers: tuple[Unit, ...] = field(init=False)

    def __post_init__(self) -> None:
        self.workers = tuple(
            unit for unit in self.units if unit.unit_type == UnitType.WORKER
        )
        self.vanguards = tuple(
            unit for unit in self.units if unit.unit_type == UnitType.VANGUARD
        )
        self.rangers = tuple(
            unit for unit in self.units if unit.unit_type == UnitType.RANGER
        )

    @property
    def state(self) -> SimpleNamespace:
        return SimpleNamespace(population=self.population)

    @property
    def plan(self) -> CommandPlan:
        return CommandPlan(
            tick=self.tick,
            unit_actions={
                unit.id: unit.action for unit in self.units if unit.action is not None
            },
            core_action=self.core.action if self.core is not None else None,
        )

    def clear(self) -> None:
        for unit in self.units:
            unit.action = None
        if self.core is not None:
            self.core.action = None


def positions(value: Iterable[Iterable[int]]) -> frozenset[Position]:
    return frozenset((int(cell[0]), int(cell[1])) for cell in value)

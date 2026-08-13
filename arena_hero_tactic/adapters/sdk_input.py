"""Convert Arena Hero SDK Turns into canonical strategy state."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from arena_hero import UnitType as SDKUnitType
from arena_hero import unit_cost as sdk_unit_cost

from ..strategy_core.model import (
    Beacon,
    BeaconStatus,
    Core,
    CoreState,
    Direction,
    Enemy,
    HarvestSource,
    PlannerOptions,
    Position,
    ResolutionEvent,
    Turn,
    Unit,
    UnitType,
)


def _uuid(value: object | None) -> UUID | None:
    if value is None:
        return None
    return value if isinstance(value, UUID) else UUID(str(value))


def _position(value: object | None) -> Position | None:
    if not isinstance(value, (tuple, list)) or len(value) != 2:
        return None
    return int(value[0]), int(value[1])


def _unit_type(value: object | None) -> UnitType | None:
    if value is None:
        return None
    return UnitType(str(value))


def _event(event: object) -> ResolutionEvent:
    harvest_source = getattr(event, "harvest_source", None)
    values = getattr(event, "values", None)
    return ResolutionEvent(
        event_type=str(getattr(event, "event_type", "")),
        tick=_optional_int(getattr(event, "tick", None)),
        reason_code=_optional_str(getattr(event, "reason_code", None)),
        position=_position(getattr(event, "position", None)),
        actor_id=_uuid(getattr(event, "actor_id", None)),
        target_id=_uuid(getattr(event, "target_id", None)),
        resource_amount=_optional_int(getattr(event, "resource_amount", None)),
        harvest_source=(
            HarvestSource(str(harvest_source)) if harvest_source is not None else None
        ),
        values=values if isinstance(values, dict) else None,
    )


def _optional_int(value: object | None) -> int | None:
    return int(value) if isinstance(value, int) else None


def _optional_str(value: object | None) -> str | None:
    return str(value) if value is not None else None


def sdk_turn_to_canonical(
    turn: object,
    options: PlannerOptions,
) -> Turn:
    """Build an isolated canonical snapshot from an SDK or SDK-like Turn."""

    units = tuple(
        Unit(
            id=_uuid(unit.id),
            position=_position(unit.position),
            unit_type=_unit_type(getattr(unit, "unit_type", None)),
            hp=int(getattr(unit, "hp", 1)),
            cargo=max(0, int(getattr(unit, "cargo", 0))),
            max_hp=_optional_int(getattr(unit, "max_hp", None)),
        )
        for unit in getattr(turn, "units", ())
    )
    raw_core = getattr(turn, "core", None)
    core = None
    if raw_core is not None:
        raw_view = getattr(raw_core, "view", raw_core)
        raw_state = getattr(raw_view, "state", CoreState.NORMAL)
        core = Core(
            id=_uuid(raw_core.id),
            position=_position(raw_core.position),
            hp=int(getattr(raw_core, "hp", 5)),
            shield=max(0, int(getattr(raw_core, "shield", 0))),
            state=CoreState(str(raw_state)),
            owner_username=str(getattr(raw_core, "owner_username", "") or ""),
            move_direction=(
                Direction(str(getattr(raw_view, "move_direction")))
                if getattr(raw_view, "move_direction", None) is not None
                else None
            ),
            move_progress=_optional_int(getattr(raw_view, "move_progress", None)),
            move_required_ticks=_optional_int(
                getattr(raw_view, "move_required_ticks", None)
            ),
            destination=_position(getattr(raw_view, "destination", None)),
        )
    enemies = tuple(
        Enemy(
            id=_uuid(enemy.id),
            kind=str(getattr(enemy, "kind", "UNIT")).upper(),
            position=_position(enemy.position),
            hp=max(1, int(getattr(enemy, "hp", 1))),
            shield=max(0, int(getattr(enemy, "shield", 0))),
            unit_type=_unit_type(getattr(enemy, "unit_type", None)),
        )
        for enemy in getattr(turn, "visible_enemies", ())
    )
    raw_beacon = getattr(turn, "beacon")
    raw_status = getattr(raw_beacon, "status", None)
    state = getattr(turn, "state", None)
    population = getattr(state, "population", None)
    if not isinstance(population, int):
        population = len(units)
    return Turn(
        tick=int(getattr(turn, "tick")),
        core=core,
        units=units,
        resources=max(0, int(getattr(turn, "resources", 0))),
        resource_space=max(0, int(getattr(turn, "resource_space", 0))),
        resource_cells=frozenset(
            _position(cell) for cell in getattr(turn, "resource_cells", ())
        ),
        obstacle_cells=frozenset(
            _position(cell) for cell in getattr(turn, "obstacle_cells", ())
        ),
        visible_enemies=enemies,
        events=tuple(_event(event) for event in getattr(turn, "events", ())),
        beacon=Beacon(
            position=_position(getattr(raw_beacon, "position")),
            status=BeaconStatus(str(raw_status)) if raw_status is not None else None,
            carrier_id=_uuid(getattr(raw_beacon, "carrier_id", None)),
        ),
        population=max(0, population),
        unit_costs={
            unit_type: sdk_unit_cost(SDKUnitType(unit_type.value), max(0, population))
            for unit_type in UnitType
        },
        options=options,
        width=_optional_int(
            getattr(turn, "width", None) or getattr(turn, "map_width", None)
        ),
        height=_optional_int(
            getattr(turn, "height", None) or getattr(turn, "map_height", None)
        ),
    )

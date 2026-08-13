"""Apply canonical command plans to Arena Hero SDK Turns."""

from __future__ import annotations

from arena_hero import Direction as SDKDirection
from arena_hero import UnitType as SDKUnitType

from ..strategy_core.model import CommandPlan, RecordedAction


def _apply_unit_action(unit: object, action: RecordedAction) -> None:
    if action.type == "MOVE":
        unit.move(SDKDirection(action.direction.value))
    elif action.type == "HARVEST":
        unit.harvest()
    elif action.type == "DEPOSIT":
        unit.deposit()
    elif action.type == "SWEEP":
        unit.sweep(SDKDirection(action.direction.value))
    elif action.type == "SHOOT":
        if action.target_id is None:
            unit.shoot_cell(action.expected_cell)
        else:
            try:
                unit.shoot(action.target_id, expected_cell=action.expected_cell)
            except TypeError:
                unit.shoot(action.target_id)
    elif action.type == "HEAL":
        unit.heal()
    elif action.type == "PICKUP_BEACON":
        unit.pickup_beacon()
    elif action.type == "DROP_BEACON":
        unit.drop_beacon()
    elif action.type == "SELF_DESTRUCT":
        unit.self_destruct()
    elif action.type != "WAIT":
        raise ValueError(f"unsupported unit action: {action.type}")


def _apply_core_action(core: object, action: RecordedAction) -> None:
    if action.type == "SPAWN":
        core.spawn(SDKUnitType(action.unit_type.value))
    elif action.type == "REPAIR_SHIELD":
        core.repair_shield()
    elif action.type == "HEAL":
        core.heal()
    elif action.type == "START_MOVE":
        core.start_move(SDKDirection(action.direction.value))
    elif action.type == "CANCEL_MOVE":
        core.cancel_move()
    elif action.type == "PICKUP_BEACON":
        core.pickup_beacon()
    elif action.type == "DROP_BEACON":
        core.drop_beacon()
    elif action.type == "SELF_DESTRUCT":
        core.self_destruct()
    elif action.type != "WAIT":
        raise ValueError(f"unsupported core action: {action.type}")


def apply_command_plan(turn: object, plan: CommandPlan) -> None:
    """Queue a canonical plan on the original SDK or SDK-like Turn."""

    if int(getattr(turn, "tick")) != plan.tick:
        raise ValueError("plan tick does not match Turn tick")
    units = {str(unit.id): unit for unit in getattr(turn, "units", ())}
    for unit_id, action in plan.unit_actions.items():
        unit = units.get(str(unit_id))
        if unit is None:
            raise ValueError(f"plan references unknown unit: {unit_id}")
        _apply_unit_action(unit, action)
    core = getattr(turn, "core", None)
    if plan.core_action is not None:
        if core is None:
            raise ValueError("plan contains a Core action without a Core")
        _apply_core_action(core, plan.core_action)

"""Local one-shot controls shared by the dashboard and tactic process."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from arena_hero import Direction, InvalidActionError, UnitType


CONTROL_VERSION = 1
COMMAND_TTL_TICKS = 2
CONTROL_TARGET_TYPES = frozenset({"UNIT", "CORE"})
CONTROL_ACTIONS = frozenset(
    {
        "MOVE",
        "WAIT",
        "HARVEST",
        "DEPOSIT",
        "SWEEP",
        "SHOOT",
        "PICKUP_BEACON",
        "DROP_BEACON",
        "SPAWN",
        "REPAIR_SHIELD",
        "START_MOVE",
        "CANCEL_MOVE",
    }
)
CONTROL_DIRECTIONS = frozenset(item.value for item in Direction)
CONTROL_UNIT_TYPES = frozenset(item.value for item in UnitType)


class ControlCommandError(ValueError):
    """Raised when a local control command cannot be queued safely."""


def _atomic_write(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    temporary.replace(path)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    return document if isinstance(document, dict) else None


def _uuid_text(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ControlCommandError(f"{field} must be a UUID string")
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError) as error:
        raise ControlCommandError(f"{field} must be a valid UUID") from error
    return str(parsed)


def _position(value: Any, field: str) -> list[int]:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise ControlCommandError(f"{field} must contain two coordinates")
    if any(type(item) is not int for item in value):
        raise ControlCommandError(f"{field} coordinates must be integers")
    if any(item < -(2**63) or item > 2**63 - 1 for item in value):
        raise ControlCommandError(f"{field} coordinates are out of range")
    return [int(value[0]), int(value[1])]


def validate_control_document(document: Any) -> dict[str, Any]:
    """Validate and normalize the browser-facing command shape."""

    if not isinstance(document, dict):
        raise ControlCommandError("command must be a JSON object")
    allowed = {
        "target_type",
        "target_id",
        "action",
        "direction",
        "unit_type",
        "enemy_id",
        "expected_cell",
        "observed_tick",
    }
    unknown = set(document) - allowed
    if unknown:
        raise ControlCommandError("unknown command fields")

    target_type = document.get("target_type")
    if target_type not in CONTROL_TARGET_TYPES:
        raise ControlCommandError("target_type must be UNIT or CORE")
    action = document.get("action")
    if action not in CONTROL_ACTIONS:
        raise ControlCommandError("unknown control action")
    target_id = _uuid_text(document.get("target_id"), "target_id")
    observed_tick = document.get("observed_tick")
    if type(observed_tick) is not int or observed_tick < 1:
        raise ControlCommandError("observed_tick must be a positive integer")

    normalized: dict[str, Any] = {
        "version": CONTROL_VERSION,
        "target_type": target_type,
        "target_id": target_id,
        "action": action,
        "observed_tick": observed_tick,
    }

    direction = document.get("direction")
    if action in {"MOVE", "SWEEP", "START_MOVE"}:
        if direction not in CONTROL_DIRECTIONS:
            raise ControlCommandError("direction is required for this action")
        normalized["direction"] = direction
    elif direction is not None:
        raise ControlCommandError("direction is not valid for this action")

    unit_type = document.get("unit_type")
    if action == "SPAWN":
        if target_type != "CORE" or unit_type not in CONTROL_UNIT_TYPES:
            raise ControlCommandError("SPAWN requires a Core and valid unit_type")
        normalized["unit_type"] = unit_type
    elif unit_type is not None:
        raise ControlCommandError("unit_type is only valid for SPAWN")

    enemy_id = document.get("enemy_id")
    expected_cell = document.get("expected_cell")
    if action == "SHOOT":
        if target_type != "UNIT":
            raise ControlCommandError("SHOOT requires a Unit target")
        normalized["enemy_id"] = _uuid_text(enemy_id, "enemy_id")
        normalized["expected_cell"] = _position(expected_cell, "expected_cell")
    elif enemy_id is not None or expected_cell is not None:
        raise ControlCommandError("shoot fields are only valid for SHOOT")

    return normalized


def queue_control_command(document: Any, queue_dir: Path) -> dict[str, Any]:
    normalized = validate_control_document(document)
    command_id = str(uuid4())
    created_at = time.time()
    record = {
        **normalized,
        "command_id": command_id,
        "created_at": created_at,
        "expires_tick": normalized["observed_tick"] + COMMAND_TTL_TICKS,
    }
    filename = f"{time.time_ns():020d}-{command_id}.json"
    _atomic_write(queue_dir / filename, record)
    return record


def _command_files(queue_dir: Path) -> list[Path]:
    try:
        return sorted(queue_dir.glob("*.json"))
    except OSError:
        return []


def pending_control_commands(queue_dir: Path) -> list[dict[str, Any]]:
    pending: list[dict[str, Any]] = []
    for path in _command_files(queue_dir):
        document = _read_json(path)
        if document is None:
            continue
        pending.append(document)
    pending.sort(key=lambda item: (float(item.get("created_at", 0)), item.get("command_id", "")))
    return pending


def clear_control_commands(queue_dir: Path) -> int:
    removed = 0
    for path in _command_files(queue_dir):
        try:
            path.unlink()
        except FileNotFoundError:
            continue
        except OSError:
            continue
        removed += 1
    return removed


def _remove(path: Path) -> None:
    try:
        path.unlink()
    except (FileNotFoundError, OSError):
        pass


def _value(value: Any) -> Any:
    return getattr(value, "value", value)


def _find_unit(turn: Any, target_id: str) -> Any | None:
    for unit in getattr(turn, "units", ()):
        if str(getattr(unit, "id", "")) == target_id:
            return unit
    return None


def _execute(turn: Any, command: dict[str, Any]) -> None:
    action = command["action"]
    target_type = command["target_type"]
    if target_type == "CORE":
        core = getattr(turn, "core", None)
        if core is None or str(core.id) != command["target_id"]:
            raise ControlCommandError("Core is no longer available")
        if action == "WAIT":
            core.wait()
        elif action == "SPAWN":
            core.spawn(UnitType(command["unit_type"]))
        elif action == "REPAIR_SHIELD":
            core.repair_shield()
        elif action == "START_MOVE":
            core.start_move(Direction(command["direction"]))
        elif action == "CANCEL_MOVE":
            core.cancel_move()
        elif action == "PICKUP_BEACON":
            core.pickup_beacon()
        elif action == "DROP_BEACON":
            core.drop_beacon()
        else:
            raise ControlCommandError("action is not valid for Core")
        return

    unit = _find_unit(turn, command["target_id"])
    if unit is None:
        raise ControlCommandError("Unit is no longer available")
    unit_type = _value(getattr(unit, "unit_type", None))
    if action == "WAIT":
        unit.wait()
    elif action == "MOVE":
        unit.move(Direction(command["direction"]))
    elif action == "PICKUP_BEACON":
        unit.pickup_beacon()
    elif action == "DROP_BEACON":
        unit.drop_beacon()
    elif action == "HARVEST" and unit_type == UnitType.WORKER.value:
        unit.harvest()
    elif action == "DEPOSIT" and unit_type == UnitType.WORKER.value:
        unit.deposit()
    elif action == "SWEEP" and unit_type == UnitType.VANGUARD.value:
        unit.sweep(Direction(command["direction"]))
    elif action == "SHOOT" and unit_type == UnitType.RANGER.value:
        unit.shoot(
            UUID(command["enemy_id"]),
            expected_cell=tuple(command["expected_cell"]),
        )
    else:
        raise ControlCommandError("action is not valid for this Unit")


def _receipt(command: dict[str, Any], tick: int, status: str, message: str) -> dict[str, Any]:
    return {
        "command_id": command.get("command_id"),
        "target_type": command.get("target_type"),
        "target_id": command.get("target_id"),
        "action": command.get("action"),
        "observed_tick": command.get("observed_tick"),
        "applied_tick": tick,
        "status": status,
        "message": message,
        "updated_at": time.time(),
    }


def _write_receipt(receipt_path: Path, receipt: dict[str, Any]) -> None:
    _atomic_write(receipt_path, receipt)


def apply_control_commands(
    turn: Any,
    queue_dir: Path,
    receipt_path: Path,
) -> list[dict[str, Any]]:
    """Apply at most the newest eligible command for each controlled object."""

    current_tick = int(turn.tick)
    eligible: dict[tuple[str, str], tuple[Path, dict[str, Any]]] = {}
    receipts: list[dict[str, Any]] = []
    for path in _command_files(queue_dir):
        command = _read_json(path)
        if command is None:
            _remove(path)
            continue
        observed_tick = command.get("observed_tick")
        expires_tick = command.get("expires_tick")
        if not isinstance(observed_tick, int) or not isinstance(expires_tick, int):
            _remove(path)
            continue
        if current_tick > expires_tick:
            receipt = _receipt(command, current_tick, "expired", "指令已过期")
            receipts.append(receipt)
            _remove(path)
            continue
        if current_tick < observed_tick:
            continue
        key = (str(command.get("target_type")), str(command.get("target_id")))
        previous = eligible.get(key)
        if previous is not None:
            _remove(previous[0])
            receipts.append(_receipt(previous[1], current_tick, "superseded", "同一目标有更新指令"))
        eligible[key] = (path, command)

    for path, command in eligible.values():
        try:
            _execute(turn, command)
        except (ControlCommandError, InvalidActionError, KeyError, TypeError, ValueError, AttributeError) as error:
            receipt = _receipt(command, current_tick, "rejected", str(error))
        else:
            receipt = _receipt(command, current_tick, "applied", "已覆盖本 Tick 自动动作")
        receipts.append(receipt)
        _remove(path)

    if receipts:
        _write_receipt(receipt_path, receipts[-1])
    return receipts


def load_control_receipt(receipt_path: Path) -> dict[str, Any] | None:
    return _read_json(receipt_path)

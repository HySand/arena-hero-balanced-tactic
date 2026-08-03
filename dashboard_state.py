"""Small, credential-free runtime snapshot consumed by the local dashboard."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from strategy_config import StrategyConfig


STATUS_VERSION = 1
STATUS_FILE = Path(__file__).with_name(".arena_hero_dashboard_state.json")


def _enum_value(value: Any) -> Any:
    return getattr(value, "value", value)


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_json_safe(item) for item in value]
    if hasattr(value, "value"):
        return _json_safe(value.value)
    return str(value)


def _position(value: Any) -> list[int] | None:
    if value is None:
        return None
    try:
        return [int(value[0]), int(value[1])]
    except (IndexError, TypeError, ValueError):
        return None


def _format_action(action: Any) -> str:
    if action is None:
        return "WAIT"
    name = type(action).__name__.removesuffix("Action").upper()
    direction = getattr(action, "direction", None)
    if direction is not None:
        return f"{name}:{_enum_value(direction)}"
    expected_cell = getattr(action, "expected_cell", None)
    if expected_cell is not None:
        return f"{name}:{tuple(expected_cell)}"
    unit_type = getattr(action, "unit_type", None)
    if unit_type is not None:
        return f"{name}:{_enum_value(unit_type)}"
    return name


def _unit_role(unit: Any, memory: Any) -> str:
    unit_type = str(_enum_value(getattr(unit, "unit_type", "UNKNOWN"))).upper()
    if unit_type == "WORKER":
        if getattr(unit, "cargo", 0):
            return "返航交付"
        if unit.id in memory.worker_targets:
            return "资源采集"
        if unit.id in memory.scout_targets:
            return "分区寻矿"
        return "Core 集结"
    if unit_type == "VANGUARD":
        if unit.id in memory.combat_targets:
            return "先锋开图"
        return "冲锋支援"
    if unit_type == "RANGER":
        if unit.id in memory.combat_targets:
            return "外围游侠"
        return "Core 守卫"
    return "待命"


def build_dashboard_state(
    turn: Any,
    memory: Any,
    config: StrategyConfig,
    *,
    profile: str,
    accepted: bool,
    strategy_phase: str = "UNKNOWN",
    resource_radius: int | None = None,
    exploration_radius: int | None = None,
    offense_ready: bool = False,
) -> dict[str, Any]:
    plan = getattr(turn, "plan", None)
    unit_actions = getattr(plan, "unit_actions", {}) if plan is not None else {}
    core_action = getattr(plan, "core_action", None) if plan is not None else None
    core = getattr(turn, "core", None)
    core_view = getattr(core, "view", None) if core is not None else None

    units: list[dict[str, Any]] = []
    for unit in getattr(turn, "units", ()):
        units.append(
            {
                "id": str(unit.id),
                "short_id": str(unit.id)[:8],
                "unit_type": str(_enum_value(unit.unit_type)).upper(),
                "position": _position(unit.position),
                "hp": getattr(unit, "hp", None),
                "cargo": getattr(unit, "cargo", None),
                "role": _unit_role(unit, memory),
                "action": _format_action(unit_actions.get(unit.id)),
                "resource_target": _position(memory.worker_targets.get(unit.id)),
                "scout_target": _position(
                    memory.scout_targets.get(unit.id)
                    or memory.combat_targets.get(unit.id)
                ),
            }
        )

    events = []
    for event in list(getattr(turn, "events", ()))[-20:]:
        events.append(
            {
                "event_type": getattr(event, "event_type", "UNKNOWN"),
                "reason_code": getattr(event, "reason_code", None),
                "position": _position(getattr(event, "position", None)),
                "values": _json_safe(getattr(event, "values", None)),
            }
        )

    counts = {
        "WORKER": len(getattr(turn, "workers", ())),
        "VANGUARD": len(getattr(turn, "vanguards", ())),
        "RANGER": len(getattr(turn, "rangers", ())),
    }
    resources = int(getattr(turn, "resources", 0))
    resource_space = int(getattr(turn, "resource_space", 0))
    return {
        "version": STATUS_VERSION,
        "updated_at": time.time(),
        "accepted": accepted,
        "tick": int(getattr(turn, "tick", 0)),
        "profile": profile,
        "strategy_phase": strategy_phase,
        "resource_radius": resource_radius,
        "resource_radius_limit": memory.resource_radius_limit,
        "effective_resource_radius": memory.effective_resource_radius,
        "resource_candidate_count": memory.resource_candidate_count,
        "resource_assignment_count": memory.resource_assignment_count,
        "exploration_radius": exploration_radius,
        "offense_ready": offense_ready,
        "posture": memory.last_posture,
        "threat_score": round(float(memory.last_threat_score), 3),
        "resources": resources,
        "resource_capacity": int(
            getattr(turn, "resource_capacity", resources + resource_space)
        ),
        "resource_space": resource_space,
        "population": len(units),
        "population_tier": int(getattr(turn, "population_tier", 0)),
        "upkeep_next_tick": int(getattr(turn, "upkeep_next_tick", 0)),
        "counts": counts,
        "production_order": [
            {"unit_type": item.unit_type, "target": item.target}
            for item in config.production.order
        ],
        "core": None
        if core is None
        else {
            "id": str(core.id),
            "position": _position(core.position),
            "hp": getattr(core, "hp", None),
            "shield": getattr(core, "shield", None),
            "state": str(_enum_value(getattr(core_view, "state", "UNKNOWN"))),
            "destination": _position(getattr(core_view, "destination", None)),
            "move_progress": getattr(core_view, "move_progress", None),
            "move_required_ticks": getattr(core_view, "move_required_ticks", None),
            "action": _format_action(core_action),
        },
        "visible_enemy_count": len(getattr(turn, "visible_enemies", ())),
        "visible_resources": [
            list(cell) for cell in sorted(getattr(turn, "resource_cells", ()))
        ],
        "remembered_resources": [
            list(cell) for cell in sorted(memory.resource_hints)
        ],
        "map_memory": {
            "known_cells": len(memory.known_cells),
            "obstacles": len(memory.obstacle_cells),
            "visited_cells": len(memory.visited_cells),
            "bounds": list(memory.bounds) if memory.bounds is not None else None,
        },
        "worker_losses": memory.worker_losses,
        "planned_deposited": memory.planned_deposited,
        "units": units,
        "events": events,
        "adaptive_economy": {
            "enabled": config.adaptive_economy.enabled,
            "action": getattr(memory, "adaptive_action", "WARMUP"),
            "reason": getattr(memory, "adaptive_reason", "collecting_samples"),
            "throughput_per_worker": round(
                float(getattr(memory, "adaptive_throughput", 0.0)), 4
            ),
            "utilization": round(
                float(getattr(memory, "adaptive_utilization", 0.0)), 4
            ),
            "harvest_failure_rate": round(
                float(getattr(memory, "adaptive_failure_rate", 0.0)), 4
            ),
            "average_cycle_ticks": round(
                float(getattr(memory, "adaptive_average_cycle_ticks", 0.0)), 2
            ),
            "storage_full_ratio": round(
                float(getattr(memory, "adaptive_storage_full_ratio", 0.0)), 4
            ),
            "new_cells_per_scout": round(
                float(getattr(memory, "adaptive_new_cells_per_scout", 0.0)), 3
            ),
            "sample_count": int(getattr(memory, "adaptive_sample_count", 0)),
            "scarcity_streak": int(
                getattr(memory, "adaptive_scarcity_streak", 0)
            ),
            "radius_delta": int(getattr(memory, "adaptive_radius_delta", 0)),
            "scout_bonus": int(getattr(memory, "adaptive_scout_bonus", 0)),
            "worker_target": getattr(memory, "adaptive_worker_target", None),
        },
    }


def write_dashboard_state(
    turn: Any,
    memory: Any,
    config: StrategyConfig,
    *,
    profile: str,
    accepted: bool,
    strategy_phase: str = "UNKNOWN",
    resource_radius: int | None = None,
    exploration_radius: int | None = None,
    offense_ready: bool = False,
    path: Path = STATUS_FILE,
) -> dict[str, Any]:
    document = build_dashboard_state(
        turn,
        memory,
        config,
        profile=profile,
        accepted=accepted,
        strategy_phase=strategy_phase,
        resource_radius=resource_radius,
        exploration_radius=exploration_radius,
        offense_ready=offense_ready,
    )
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    temporary.replace(path)
    return document

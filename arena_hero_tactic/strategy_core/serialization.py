"""Strict deterministic JSON contract for strategy service calls."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping
from uuid import UUID

from .config import StrategyConfig, strategy_config_from_dict
from .contracts import CONTRACT_VERSION, STRATEGY_VERSION, ContractError, PlanResult
from .model import (
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
    unit_cost,
)

CONFIG_VERSION = 1
MEMORY_VERSION = 12


@dataclass(frozen=True)
class TickRequest:
    agent_id: str
    tick: int
    state: Turn
    memory: Mapping[str, Any]
    config: StrategyConfig
    config_version: int


class InvalidJsonError(ContractError):
    """Raised when a strategy request body is not valid JSON."""


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def _record(value: object, name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractError(f"{name} must be an object")
    return value


def _integer(value: object, name: str, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        raise ContractError(f"{name} must be an integer >= {minimum}")
    return value


def _number(value: object, name: str, minimum: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ContractError(f"{name} must be a number")
    result = float(value)
    if result < minimum:
        raise ContractError(f"{name} must be >= {minimum}")
    return result


def _string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ContractError(f"{name} must be a non-empty string")
    return value


def _uuid(value: object, name: str) -> UUID:
    raw = _string(value, name)
    try:
        parsed = UUID(raw)
    except ValueError as error:
        raise ContractError(f"{name} must be a UUID") from error
    if str(parsed) != raw:
        raise ContractError(f"{name} must be a lowercase canonical UUID")
    return parsed


def _position(value: object, name: str) -> Position:
    if not isinstance(value, list) or len(value) != 2:
        raise ContractError(f"{name} must be a two-item array")
    return _integer(value[0], f"{name}[0]", -(2**31)), _integer(
        value[1], f"{name}[1]", -(2**31)
    )


def _optional_position(value: object, name: str) -> Position | None:
    return None if value is None else _position(value, name)


def _optional_uuid(value: object, name: str) -> UUID | None:
    return None if value is None else _uuid(value, name)


def _optional_integer(value: object, name: str) -> int | None:
    return None if value is None else _integer(value, name)


def _exact_keys(value: Mapping[str, Any], expected: set[str], name: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        unknown = sorted(actual - expected)
        raise ContractError(f"{name} keys mismatch missing={missing} unknown={unknown}")


def _event(value: object, index: int) -> ResolutionEvent:
    data = _record(value, f"state.events[{index}]")
    harvest_source = data.get("harvest_source")
    return ResolutionEvent(
        event_type=str(data.get("event_type", "")),
        tick=_optional_integer(data.get("tick"), f"state.events[{index}].tick"),
        reason_code=(
            str(data["reason_code"]) if data.get("reason_code") is not None else None
        ),
        position=_optional_position(
            data.get("position"), f"state.events[{index}].position"
        ),
        actor_id=_optional_uuid(
            data.get("actor_id"), f"state.events[{index}].actor_id"
        ),
        target_id=_optional_uuid(
            data.get("target_id"), f"state.events[{index}].target_id"
        ),
        resource_amount=_optional_integer(
            data.get("resource_amount"),
            f"state.events[{index}].resource_amount",
        ),
        harvest_source=(
            HarvestSource(str(harvest_source)) if harvest_source is not None else None
        ),
        values=data.get("values") if isinstance(data.get("values"), Mapping) else None,
    )


def _state(data: Mapping[str, Any], tick: int, options: PlannerOptions) -> Turn:
    status = data.get("status")
    if status not in {"ACTIVE", "RESPAWNING"}:
        raise ContractError("state.status must be ACTIVE or RESPAWNING")
    objects = data.get("objects")
    events = data.get("events")
    if not isinstance(objects, list) or not isinstance(events, list):
        raise ContractError("state.objects and state.events must be arrays")
    core: Core | None = None
    units: list[Unit] = []
    enemies: list[Enemy] = []
    obstacles: set[Position] = set()
    resources: set[Position] = set()
    for index, raw_object in enumerate(objects):
        item = _record(raw_object, f"state.objects[{index}]")
        kind = item.get("kind")
        if kind in {"OBSTACLE", "RESOURCE"}:
            positions = item.get("positions")
            if not isinstance(positions, list):
                raise ContractError(f"state.objects[{index}].positions must be an array")
            target = obstacles if kind == "OBSTACLE" else resources
            target.update(
                _position(position, f"state.objects[{index}].positions[{offset}]")
                for offset, position in enumerate(positions)
            )
            continue
        position = _position(item.get("position"), f"state.objects[{index}].position")
        identifier = _uuid(item.get("id"), f"state.objects[{index}].id")
        controlled = item.get("controlled")
        if not isinstance(controlled, bool):
            raise ContractError(f"state.objects[{index}].controlled must be boolean")
        hp = _integer(item.get("hp"), f"state.objects[{index}].hp")
        if kind == "CORE":
            shield = _integer(item.get("shield"), f"state.objects[{index}].shield")
            if controlled:
                if core is not None:
                    raise ContractError("state contains multiple controlled Cores")
                raw_state = item.get("state")
                try:
                    core_state = CoreState(str(raw_state))
                except ValueError as error:
                    raise ContractError("Core state is invalid") from error
                core = Core(
                    id=identifier,
                    position=position,
                    hp=hp,
                    shield=shield,
                    state=core_state,
                    owner_username=str(item.get("owner_username", "")),
                    move_direction=(
                        Direction(str(item["move_direction"]))
                        if item.get("move_direction") is not None
                        else None
                    ),
                    move_progress=_optional_integer(
                        item.get("move_progress"),
                        f"state.objects[{index}].move_progress",
                    ),
                    move_required_ticks=_optional_integer(
                        item.get("move_required_ticks"),
                        f"state.objects[{index}].move_required_ticks",
                    ),
                    destination=_optional_position(
                        item.get("destination"),
                        f"state.objects[{index}].destination",
                    ),
                )
            else:
                enemies.append(
                    Enemy(identifier, "CORE", position, hp, shield=shield)
                )
            continue
        if kind != "UNIT":
            raise ContractError(f"state.objects[{index}].kind is invalid")
        try:
            unit_type = UnitType(str(item.get("unit_type")))
        except ValueError as error:
            raise ContractError("Unit type is invalid") from error
        if controlled:
            units.append(
                Unit(
                    id=identifier,
                    position=position,
                    unit_type=unit_type,
                    hp=hp,
                    cargo=_integer(
                        item.get("cargo", 0), f"state.objects[{index}].cargo"
                    ),
                )
            )
        else:
            enemies.append(Enemy(identifier, "UNIT", position, hp, unit_type=unit_type))
    beacon_data = _record(data.get("champion_beacon"), "state.champion_beacon")
    raw_beacon_status = beacon_data.get("status")
    population = _integer(data.get("population"), "state.population")
    stored_resources = _integer(data.get("resources"), "state.resources")
    raw_respawn_at_tick = data.get("respawn_at_tick")
    respawn_at_tick: int | None = None
    if status == "RESPAWNING":
        respawn_at_tick = _integer(
            raw_respawn_at_tick,
            "state.respawn_at_tick",
            1,
        )
    elif raw_respawn_at_tick is not None:
        raise ContractError(
            "state.respawn_at_tick is only valid while respawning"
        )
    resource_capacity = max(10, population * 5)
    return Turn(
        tick=tick,
        core=core,
        units=tuple(units),
        resources=stored_resources,
        resource_space=max(0, resource_capacity - stored_resources),
        resource_cells=frozenset(resources),
        obstacle_cells=frozenset(obstacles),
        visible_enemies=tuple(enemies),
        events=tuple(_event(event, index) for index, event in enumerate(events)),
        beacon=Beacon(
            position=_position(beacon_data.get("position"), "state.champion_beacon.position"),
            status=(
                BeaconStatus(str(raw_beacon_status))
                if raw_beacon_status is not None
                else None
            ),
            carrier_id=_optional_uuid(
                beacon_data.get("carrier_id"), "state.champion_beacon.carrier_id"
            ),
        ),
        population=population,
        unit_costs={
            unit_type: unit_cost(unit_type, population)
            for unit_type in UnitType
        },
        options=options,
        status=status,
        respawn_at_tick=respawn_at_tick,
    )


def decode_tick_request(value: object) -> TickRequest:
    data = _record(value, "request")
    _exact_keys(
        data,
        {
            "contract_version",
            "strategy_version",
            "config_version",
            "agent_id",
            "tick",
            "state",
            "memory",
            "config",
            "options",
        },
        "request",
    )
    if data.get("contract_version") != CONTRACT_VERSION:
        raise ContractError("unsupported contract_version")
    if data.get("strategy_version") != STRATEGY_VERSION:
        raise ContractError("unsupported strategy_version")
    config_version = _integer(data.get("config_version"), "config_version", 1)
    if config_version != CONFIG_VERSION:
        raise ContractError("unsupported config_version")
    agent_id = _string(data.get("agent_id"), "agent_id")
    if len(agent_id) > 128:
        raise ContractError("agent_id is too long")
    tick = _integer(data.get("tick"), "tick", 1)
    options_data = _record(data.get("options"), "options")
    _exact_keys(
        options_data,
        {"profile", "safety_enabled", "core_migration_enabled"},
        "options",
    )
    if not isinstance(options_data.get("safety_enabled"), bool) or not isinstance(
        options_data.get("core_migration_enabled"), bool
    ):
        raise ContractError("strategy options must be boolean")
    options = PlannerOptions(
        profile=_string(options_data.get("profile"), "options.profile"),
        safety_enabled=options_data["safety_enabled"],
        core_migration_enabled=options_data["core_migration_enabled"],
    )
    memory = _record(data.get("memory"), "memory")
    if memory.get("version") != MEMORY_VERSION:
        raise ContractError("unsupported memory version")
    raw_config = _record(data.get("config"), "config")
    try:
        config = strategy_config_from_dict(raw_config)
    except (TypeError, ValueError) as error:
        raise ContractError(f"invalid strategy config: {error}") from error
    if config.version != config_version:
        raise ContractError("config version mismatch")
    return TickRequest(
        agent_id=agent_id,
        tick=tick,
        state=_state(_record(data.get("state"), "state"), tick, options),
        memory=memory,
        config=config,
        config_version=config_version,
    )


def decode_tick_request_json(raw: str) -> TickRequest:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise InvalidJsonError("request body must contain valid JSON") from error
    return decode_tick_request(value)


def encode_tick_response(
    request: TickRequest,
    result: PlanResult,
    planning_ms: float,
) -> dict[str, Any]:
    memory = dict(result.memory)
    if memory.get("version") != MEMORY_VERSION:
        raise ContractError("planner returned unsupported memory version")
    return {
        "contract_version": CONTRACT_VERSION,
        "strategy_version": STRATEGY_VERSION,
        "config_version": request.config_version,
        "agent_id": request.agent_id,
        "tick": request.tick,
        "plan": result.plan.to_dict(),
        "memory": memory,
        "summary": dict(result.summary),
        "planning_ms": _number(planning_ms, "planning_ms"),
    }


def error_response(
    error_code: str,
    detail: str,
    *,
    retryable: bool,
) -> dict[str, Any]:
    return {
        "contract_version": CONTRACT_VERSION,
        "strategy_version": STRATEGY_VERSION,
        "error_code": error_code,
        "retryable": retryable,
        "detail": detail[:240],
    }

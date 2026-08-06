"""Portable, anonymous Arena Hero turn dataset collection and exchange."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import zipfile
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
from io import TextIOWrapper
from pathlib import Path
from typing import Any, Iterable, Mapping
from uuid import uuid4

import arena_hero

from ..configuration.strategy import StrategyConfig


from ..runtime.paths import (
    TRAINING_ARCHIVE_FILE as ARCHIVE_FILE,
    TRAINING_SOURCE_FILE as SOURCE_FILE,
)
FORMAT_NAME = "arena-hero-portable-training-dataset"
FORMAT_VERSION = 1
RECORD_SCHEMA = "io.arenahero.tactic-turn"
RECORD_SCHEMA_VERSION = 1
API_VERSION = "v0.1"
RULES_VERSION = "v0.14"
SESSION_ID = uuid4().hex
SENSITIVE_KEY_PARTS = (
    "api_key",
    "authorization",
    "credential",
    "email",
    "owner_username",
    "password",
    "secret",
    "token",
    "username",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _enum_value(value: Any) -> Any:
    return getattr(value, "value", value)


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Mapping):
        return {
            str(key): _json_safe(item)
            for key, item in value.items()
            if not any(part in str(key).lower() for part in SENSITIVE_KEY_PARTS)
        }
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_json_safe(item) for item in value]
    if hasattr(value, "value"):
        return _json_safe(value.value)
    return str(value)


def _hash_payload(value: Any, length: int = 16) -> str:
    payload = json.dumps(
        _json_safe(value),
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:length]


def _entity_token(source_id: str, entity_id: Any) -> str:
    return hashlib.sha256(
        f"{source_id}:{entity_id}".encode("utf-8")
    ).hexdigest()[:16]


def _position(value: Any) -> tuple[int, int] | None:
    try:
        return int(value[0]), int(value[1])
    except (IndexError, TypeError, ValueError):
        return None


def _relative(value: Any, origin: tuple[int, int] | None) -> list[int] | None:
    position = _position(value)
    if position is None or origin is None:
        return None
    return [position[0] - origin[0], position[1] - origin[1]]


def _distance(left: Any, right: Any) -> int | None:
    a = _position(left)
    b = _position(right)
    if a is None or b is None:
        return None
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def _action_type(action: Any) -> str:
    if action is None:
        return "WAIT"
    return type(action).__name__.removesuffix("Action").upper()


def _action_record(
    action: Any,
    *,
    actor_position: Any,
    core_position: tuple[int, int] | None,
) -> dict[str, Any]:
    record: dict[str, Any] = {"type": _action_type(action)}
    if action is None:
        return record
    direction = getattr(action, "direction", None)
    if direction is not None:
        record["direction"] = str(_enum_value(direction))
    unit_type = getattr(action, "unit_type", None)
    if unit_type is not None:
        record["unit_type"] = str(_enum_value(unit_type))
    expected_cell = getattr(action, "expected_cell", None)
    if expected_cell is not None:
        record["target_from_actor"] = _relative(
            expected_cell, _position(actor_position)
        )
        record["target_from_core"] = _relative(expected_cell, core_position)
    return record


@contextmanager
def _exclusive_lock(path: Path, timeout_seconds: float = 2.0):
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
                raise TimeoutError(f"timed out waiting for dataset lock: {path}")
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


def _source_id(path: Path = SOURCE_FILE) -> str:
    if path.is_file():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            value = str(raw.get("source_id", "")).strip()
            if value:
                return value
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    source_id = uuid4().hex
    document = {
        "version": 1,
        "source_id": source_id,
        "created_at": _now(),
        "privacy": "pseudonymous installation id; no Arena Hero account identity",
    }
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(document, ensure_ascii=True, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)
    return source_id


def _portable_event_value(
    key: str,
    value: Any,
    source_id: str,
    core_position: tuple[int, int] | None,
) -> Any:
    lowered = key.lower()
    if lowered.endswith("_id") or lowered in {"destroyed_by", "carrier_id"}:
        return None if value is None else _entity_token(source_id, value)
    if lowered in {"position", "cell", "expected_cell"}:
        return _relative(value, core_position)
    if lowered.endswith("positions") and isinstance(value, (list, tuple)):
        return [_relative(item, core_position) for item in value]
    if isinstance(value, Mapping):
        return {
            str(child_key): _portable_event_value(
                str(child_key), child_value, source_id, core_position
            )
            for child_key, child_value in value.items()
            if not any(
                part in str(child_key).lower() for part in SENSITIVE_KEY_PARTS
            )
        }
    if isinstance(value, (list, tuple, set, frozenset)):
        return [
            _portable_event_value(key, item, source_id, core_position)
            for item in value
        ]
    return _json_safe(value)


def _event_summary(
    events: Iterable[Any],
    source_id: str,
    core_position: tuple[int, int] | None,
) -> dict[str, Any]:
    event_types: Counter[str] = Counter()
    reasons: Counter[str] = Counter()
    totals: Counter[str] = Counter()
    event_ticks: set[int] = set()
    event_rows: list[dict[str, Any]] = []
    for event in events:
        event_type = str(getattr(event, "event_type", "UNKNOWN"))
        event_types[event_type] += 1
        reason = getattr(event, "reason_code", None)
        if reason:
            reasons[f"{event_type}:{reason}"] += 1
        tick = getattr(event, "tick", None)
        if isinstance(tick, int):
            event_ticks.add(tick)
        values = getattr(event, "values", None) or {}
        event_rows.append(
            {
                "tick": tick,
                "event_type": event_type,
                "reason_code": None if reason is None else str(reason),
                "actor_id": (
                    None
                    if getattr(event, "actor_id", None) is None
                    else _entity_token(source_id, getattr(event, "actor_id"))
                ),
                "target_id": (
                    None
                    if getattr(event, "target_id", None) is None
                    else _entity_token(source_id, getattr(event, "target_id"))
                ),
                "position_from_core": _relative(
                    getattr(event, "position", None), core_position
                ),
                "values": _portable_event_value(
                    "values", values, source_id, core_position
                ),
            }
        )
        amount = getattr(event, "resource_amount", None)
        if callable(amount):
            amount = amount()
        if not isinstance(amount, int):
            amount = int(values.get("amount", 0) or 0)
        if event_type == "HARVEST_SUCCEEDED":
            totals["harvested"] += amount
        elif event_type == "DEPOSIT_SUCCEEDED":
            totals["deposited"] += amount
        elif event_type == "WORKER_CARGO_DROPPED":
            totals["cargo_dropped"] += amount
        elif event_type == "CORE_RESOURCES_CAPTURED":
            totals["resources_captured"] += amount
        elif event_type == "CORE_DAMAGED":
            totals["core_damage"] += int(values.get("damage", 0) or 0)
        elif event_type == "UNIT_DAMAGED":
            damage = int(values.get("damage", 0) or 0)
            totals["unit_damage"] += damage
            if int(values.get("hp", 1) or 0) == 0:
                totals["units_destroyed"] += 1
        elif event_type == "UNIT_HEAL_SUCCEEDED":
            totals["unit_hp_recovered"] += int(values.get("amount", 0) or 0)
        elif event_type == "CORE_HEAL_SUCCEEDED":
            totals["core_hp_recovered"] += int(values.get("amount", 0) or 0)
    return {
        "event_ticks": sorted(event_ticks),
        "event_counts": dict(sorted(event_types.items())),
        "reason_counts": dict(sorted(reasons.items())),
        "totals": dict(sorted(totals.items())),
        "events": event_rows,
    }


def _observation(turn: Any, memory: Any, source_id: str) -> dict[str, Any]:
    core = getattr(turn, "core", None)
    core_position = _position(getattr(core, "position", None))
    state = getattr(turn, "state", None)
    units = list(getattr(turn, "units", ()))
    enemies = list(getattr(turn, "visible_enemies", ()))
    unit_rows = []
    for unit in units:
        unit_rows.append(
            {
                "unit_id": _entity_token(source_id, getattr(unit, "id", "")),
                "unit_type": str(_enum_value(getattr(unit, "unit_type", "UNKNOWN"))),
                "hp": int(getattr(unit, "hp", 0) or 0),
                "cargo": int(getattr(unit, "cargo", 0) or 0),
                "position_from_core": _relative(
                    getattr(unit, "position", None), core_position
                ),
            }
        )
    unit_rows.sort(key=lambda item: item["unit_id"])
    enemy_rows = []
    for enemy in enemies:
        enemy_rows.append(
            {
                "kind": str(getattr(enemy, "kind", "UNKNOWN")),
                "unit_type": str(
                    _enum_value(getattr(enemy, "unit_type", "UNKNOWN"))
                ),
                "hp": int(getattr(enemy, "hp", 0) or 0),
                "position_from_core": _relative(
                    getattr(enemy, "position", None), core_position
                ),
            }
        )
    enemy_rows.sort(
        key=lambda item: (
            item["kind"],
            item["unit_type"],
            item["position_from_core"] or [],
            item["hp"],
        )
    )
    resource_cells = sorted(getattr(turn, "resource_cells", ()))
    obstacle_cells = sorted(getattr(turn, "obstacle_cells", ()))
    return {
        "player_status": str(_enum_value(getattr(state, "status", "ACTIVE"))),
        "respawn_at_tick": getattr(state, "respawn_at_tick", None),
        "resources": int(getattr(turn, "resources", 0) or 0),
        "resource_capacity": int(getattr(turn, "resource_capacity", 0) or 0),
        "resource_space": int(getattr(turn, "resource_space", 0) or 0),
        "population": len(units),
        "core": None
        if core is None
        else {
            "core_id": _entity_token(source_id, getattr(core, "id", "")),
            "hp": int(getattr(core, "hp", 0) or 0),
            "shield": int(getattr(core, "shield", 0) or 0),
            "state": str(
                _enum_value(getattr(getattr(core, "view", None), "state", "UNKNOWN"))
            ),
        },
        "friendly_units": unit_rows,
        "visible_enemies": enemy_rows,
        "visible_resource_cells_from_core": [
            _relative(cell, core_position) for cell in resource_cells
        ],
        "visible_obstacles_from_core": [
            _relative(cell, core_position)
            for cell in obstacle_cells
            if core_position is None or (_distance(cell, core_position) or 0) <= 12
        ],
        "beacon": {
            "status": str(
                _enum_value(getattr(getattr(turn, "beacon", None), "status", "UNKNOWN"))
            ),
            "position_from_core": _relative(
                getattr(getattr(turn, "beacon", None), "position", None),
                core_position,
            ),
        },
        "map_memory": {
            "known_cells": len(getattr(memory, "known_cells", ())),
            "obstacles": len(getattr(memory, "obstacle_cells", ())),
            "remembered_resources": len(getattr(memory, "resource_hints", ())),
            "resource_chunks": len(getattr(memory, "resource_chunks", ())),
        },
    }


def _decision(
    turn: Any,
    memory: Any,
    config: StrategyConfig,
    source_id: str,
    *,
    profile: str,
    strategy_phase: str,
    resource_radius: int | None,
    exploration_radius: int | None,
    offense_ready: bool,
    decision_ms: float,
) -> dict[str, Any]:
    core = getattr(turn, "core", None)
    core_position = _position(getattr(core, "position", None))
    plan = getattr(turn, "plan", None)
    unit_actions = getattr(plan, "unit_actions", {}) if plan is not None else {}
    core_action = getattr(plan, "core_action", None) if plan is not None else None
    units_by_id = {unit.id: unit for unit in getattr(turn, "units", ())}
    action_rows = []
    action_counts: Counter[str] = Counter()
    for unit_id, action in unit_actions.items():
        unit = units_by_id.get(unit_id)
        action_type = _action_type(action)
        action_counts[action_type] += 1
        action_rows.append(
            {
                "unit_id": _entity_token(source_id, unit_id),
                "unit_type": str(
                    _enum_value(getattr(unit, "unit_type", "UNKNOWN"))
                ),
                "action": _action_record(
                    action,
                    actor_position=getattr(unit, "position", None),
                    core_position=core_position,
                ),
            }
        )
    action_rows.sort(key=lambda item: item["unit_id"])
    return {
        "profile": profile,
        "strategy_phase": strategy_phase,
        "posture": str(getattr(memory, "last_posture", "UNKNOWN")),
        "threat_score": round(float(getattr(memory, "last_threat_score", 0.0)), 4),
        "resource_radius": resource_radius,
        "resource_radius_limit": getattr(memory, "resource_radius_limit", None),
        "effective_resource_radius": getattr(
            memory, "effective_resource_radius", None
        ),
        "exploration_radius": exploration_radius,
        "offense_ready": bool(offense_ready),
        "decision_ms": round(max(0.0, float(decision_ms)), 3),
        "core_action": _action_record(
            core_action,
            actor_position=getattr(core, "position", None),
            core_position=core_position,
        ),
        "unit_action_counts": dict(sorted(action_counts.items())),
        "unit_actions": action_rows,
        "adaptive_economy": {
            "action": str(getattr(memory, "adaptive_action", "UNKNOWN")),
            "reason": str(getattr(memory, "adaptive_reason", "UNKNOWN")),
            "throughput_per_worker": round(
                float(getattr(memory, "adaptive_throughput", 0.0)), 6
            ),
            "utilization": round(
                float(getattr(memory, "adaptive_utilization", 0.0)), 6
            ),
            "harvest_failure_rate": round(
                float(getattr(memory, "adaptive_failure_rate", 0.0)), 6
            ),
            "average_cycle_ticks": round(
                float(getattr(memory, "adaptive_average_cycle_ticks", 0.0)), 3
            ),
            "storage_full_ratio": round(
                float(getattr(memory, "adaptive_storage_full_ratio", 0.0)), 6
            ),
            "scarcity_streak": int(
                getattr(memory, "adaptive_scarcity_streak", 0) or 0
            ),
            "worker_target": getattr(memory, "adaptive_worker_target", None),
            "radius_delta": int(getattr(memory, "adaptive_radius_delta", 0) or 0),
            "scout_bonus": int(getattr(memory, "adaptive_scout_bonus", 0) or 0),
        },
        "parameters": _json_safe(config.to_dict()),
    }


def build_record(
    turn: Any,
    memory: Any,
    config: StrategyConfig,
    *,
    profile: str,
    strategy_phase: str,
    resource_radius: int | None,
    exploration_radius: int | None,
    offense_ready: bool,
    decision_ms: float = 0.0,
    source_id: str | None = None,
) -> dict[str, Any]:
    source = source_id or _source_id()
    parameters = _json_safe(config.to_dict())
    parameter_id = _hash_payload(parameters, 16)
    record_id = _hash_payload(
        {
            "source_id": source,
            "api_version": API_VERSION,
            "rules_version": RULES_VERSION,
            "tick": int(getattr(turn, "tick", 0)),
        },
        32,
    )
    return {
        "schema": RECORD_SCHEMA,
        "schema_version": RECORD_SCHEMA_VERSION,
        "record_id": record_id,
        "source_id": source,
        "session_id": SESSION_ID,
        "recorded_at": _now(),
        "tick": int(getattr(turn, "tick", 0)),
        "contract": {
            "api_version": API_VERSION,
            "rules_version": RULES_VERSION,
            "sdk_version": str(arena_hero.__version__),
        },
        "policy_id": parameter_id,
        "observation": _observation(turn, memory, source),
        "decision": _decision(
            turn,
            memory,
            config,
            source,
            profile=profile,
            strategy_phase=strategy_phase,
            resource_radius=resource_radius,
            exploration_radius=exploration_radius,
            offense_ready=offense_ready,
            decision_ms=decision_ms,
        ),
        "previous_outcome": _event_summary(
            getattr(turn, "events", ()),
            source,
            _position(getattr(getattr(turn, "core", None), "position", None)),
        ),
    }


def record_accepted_turn(
    turn: Any,
    memory: Any,
    config: StrategyConfig,
    *,
    profile: str,
    strategy_phase: str,
    resource_radius: int | None,
    exploration_radius: int | None,
    offense_ready: bool,
    decision_ms: float = 0.0,
    path: Path = ARCHIVE_FILE,
) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with _exclusive_lock(lock_path):
        record = build_record(
            turn,
            memory,
            config,
            profile=profile,
            strategy_phase=strategy_phase,
            resource_radius=resource_radius,
            exploration_radius=exploration_radius,
            offense_ready=offense_ready,
            decision_ms=decision_ms,
        )
        with path.open("a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n"
            )
        return record


def _schema_document() -> dict[str, Any]:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Arena Hero portable tactic turn",
        "type": "object",
        "required": [
            "schema",
            "schema_version",
            "record_id",
            "source_id",
            "session_id",
            "tick",
            "contract",
            "policy_id",
            "observation",
            "decision",
            "previous_outcome",
        ],
        "properties": {
            "schema": {"const": RECORD_SCHEMA},
            "schema_version": {"const": RECORD_SCHEMA_VERSION},
            "record_id": {"type": "string"},
            "source_id": {"type": "string"},
            "session_id": {"type": "string"},
            "tick": {"type": "integer", "minimum": 1},
            "contract": {"type": "object"},
            "policy_id": {"type": "string"},
            "observation": {"type": "object"},
            "decision": {"type": "object"},
            "previous_outcome": {"type": "object"},
        },
        "additionalProperties": True,
    }


def _validate_record(record: Mapping[str, Any]) -> None:
    if record.get("schema") != RECORD_SCHEMA:
        raise ValueError("unsupported record schema")
    if int(record.get("schema_version", 0) or 0) != RECORD_SCHEMA_VERSION:
        raise ValueError("unsupported record schema version")
    for key in ("record_id", "source_id", "session_id", "policy_id"):
        if not str(record.get(key, "")).strip():
            raise ValueError(f"record is missing {key}")
    if int(record.get("tick", 0) or 0) <= 0:
        raise ValueError("record tick must be positive")
    contract = record.get("contract")
    if not isinstance(contract, Mapping):
        raise ValueError("record contract must be an object")
    for key in ("api_version", "rules_version", "sdk_version"):
        if not str(contract.get(key, "")).strip():
            raise ValueError(f"record contract is missing {key}")
    for key in ("observation", "decision", "previous_outcome"):
        if not isinstance(record.get(key), Mapping):
            raise ValueError(f"record {key} must be an object")


def _records_from_lines(
    lines: Iterable[str],
    path: Path,
) -> Iterable[dict[str, Any]]:
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"{path}:{line_number}: invalid JSON") from error
        if not isinstance(record, Mapping):
            raise ValueError(f"{path}:{line_number}: record must be an object")
        _validate_record(record)
        yield dict(record)


def _iter_records(path: Path) -> Iterable[dict[str, Any]]:
    """Yield validated records without loading the source text into memory."""

    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            try:
                binary = archive.open("records.jsonl")
            except KeyError as error:
                raise ValueError(f"{path} is missing records.jsonl") from error
            with binary, TextIOWrapper(binary, encoding="utf-8") as handle:
                yield from _records_from_lines(handle, path)
        return

    with path.open(encoding="utf-8") as handle:
        yield from _records_from_lines(handle, path)


def _manifest(records: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    record_count = 0
    source_ids: set[str] = set()
    session_ids: set[str] = set()
    policy_ids: set[str] = set()
    ticks: list[int] = []
    api_versions: set[str] = set()
    rules_versions: set[str] = set()
    sdk_versions: set[str] = set()

    for record in records:
        record_count += 1
        source_ids.add(str(record.get("source_id")))
        session_ids.add(str(record.get("session_id")))
        policy_ids.add(str(record.get("policy_id")))
        ticks.append(int(record.get("tick", 0) or 0))
        contract = record.get("contract", {})
        if not isinstance(contract, Mapping):
            continue
        api_versions.add(str(contract.get("api_version")))
        rules_versions.add(str(contract.get("rules_version")))
        sdk_versions.add(str(contract.get("sdk_version")))

    return {
        "format": FORMAT_NAME,
        "format_version": FORMAT_VERSION,
        "record_schema": RECORD_SCHEMA,
        "record_schema_version": RECORD_SCHEMA_VERSION,
        "created_at": _now(),
        "record_count": record_count,
        "source_count": len(source_ids),
        "session_count": len(session_ids),
        "policy_count": len(policy_ids),
        "tick_min": min(ticks) if ticks else None,
        "tick_max": max(ticks) if ticks else None,
        "api_versions": sorted(api_versions),
        "rules_versions": sorted(rules_versions),
        "sdk_versions": sorted(sdk_versions),
        "privacy": {
            "credentials": "excluded",
            "account_identity": "excluded",
            "entity_ids": "source-pseudonymized",
            "coordinates": "relative-to-core",
        },
    }


def _record_summary(record: Mapping[str, Any]) -> dict[str, Any]:
    contract = record["contract"]
    return {
        "source_id": record["source_id"],
        "session_id": record["session_id"],
        "policy_id": record["policy_id"],
        "tick": record["tick"],
        "contract": {
            "api_version": contract["api_version"],
            "rules_version": contract["rules_version"],
            "sdk_version": contract["sdk_version"],
        },
    }


def _record_sort_key(record: Mapping[str, Any]) -> tuple[str, str, int, str]:
    return (
        str(record.get("source_id")),
        str(record.get("session_id")),
        int(record.get("tick", 0)),
        str(record.get("record_id")),
    )


def write_package(records: Iterable[Mapping[str, Any]], output: Path) -> dict[str, Any]:
    # Compact JSON strings use far less memory than retaining every nested
    # observation/action mapping while still allowing last-record-wins dedupe.
    deduplicated: dict[
        str,
        tuple[tuple[str, str, int, str], dict[str, Any], str],
    ] = {}
    input_record_count = 0
    for item in records:
        input_record_count += 1
        record = dict(item)
        _validate_record(record)
        record_id = str(record["record_id"])
        payload = json.dumps(
            record,
            ensure_ascii=True,
            separators=(",", ":"),
        )
        deduplicated[record_id] = (
            _record_sort_key(record),
            _record_summary(record),
            payload,
        )

    ordered = sorted(deduplicated.values(), key=lambda item: item[0])
    manifest = _manifest(item[1] for item in ordered)
    manifest["input_record_count"] = input_record_count
    manifest["duplicates_removed"] = input_record_count - int(manifest["record_count"])
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(
        output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as archive:
        archive.writestr(
            "manifest.json",
            json.dumps(manifest, ensure_ascii=True, indent=2) + "\n",
        )
        archive.writestr(
            "schema.json",
            json.dumps(_schema_document(), ensure_ascii=True, indent=2) + "\n",
        )
        with archive.open("records.jsonl", "w", force_zip64=True) as handle:
            for _, _, payload in ordered:
                handle.write((payload + "\n").encode("utf-8"))
    return manifest


def export_dataset(
    output: Path,
    *,
    archive_path: Path = ARCHIVE_FILE,
) -> dict[str, Any]:
    records: Iterable[Mapping[str, Any]] = (
        _iter_records(archive_path) if archive_path.is_file() else ()
    )
    return write_package(records, output)


def merge_datasets(inputs: Iterable[Path], output: Path) -> dict[str, Any]:
    def records() -> Iterable[dict[str, Any]]:
        for path in inputs:
            yield from _iter_records(path)

    return write_package(records(), output)


def dataset_status(path: Path = ARCHIVE_FILE) -> dict[str, Any]:
    deduplicated: dict[str, dict[str, Any]] = {}
    input_record_count = 0
    records = _iter_records(path) if path.is_file() else ()
    for record in records:
        input_record_count += 1
        deduplicated[str(record["record_id"])] = _record_summary(record)
    manifest = _manifest(deduplicated.values())
    manifest["input_record_count"] = input_record_count
    manifest["duplicates_removed"] = input_record_count - len(deduplicated)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    status_parser = subparsers.add_parser("status")
    status_parser.add_argument("--archive", type=Path, default=ARCHIVE_FILE)

    export_parser = subparsers.add_parser("export")
    export_parser.add_argument("--archive", type=Path, default=ARCHIVE_FILE)
    export_parser.add_argument("--output", type=Path, required=True)

    merge_parser = subparsers.add_parser("merge")
    merge_parser.add_argument("inputs", nargs="+", type=Path)
    merge_parser.add_argument("--output", type=Path, required=True)

    args = parser.parse_args()
    if args.command == "status":
        result = dataset_status(args.archive)
    elif args.command == "export":
        result = export_dataset(args.output, archive_path=args.archive)
    else:
        result = merge_datasets(args.inputs, args.output)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

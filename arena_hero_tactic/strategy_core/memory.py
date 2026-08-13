"""Deterministic bounds for strategy memory carried between runtimes."""

from __future__ import annotations

from typing import Any, Mapping

from .model import Position, Turn

MAX_KNOWN_CELLS = 2400
MAX_OBSTACLE_CELLS = 800
MAX_RESOURCE_HINTS = 64
MAX_ENEMY_TRACKS = 64
MAX_RECENT_UNITS = 128


def _position(value: object) -> Position | None:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    if type(value[0]) is not int or type(value[1]) is not int:
        return None
    return int(value[0]), int(value[1])


def _anchors(state: Turn) -> tuple[Position, ...]:
    values = [state.beacon.position]
    if state.core is not None:
        values.append(state.core.position)
    values.extend(unit.position for unit in state.units)
    values.extend(enemy.position for enemy in state.visible_enemies)
    return tuple(values)


def _distance(position: Position, anchors: tuple[Position, ...]) -> int:
    if not anchors:
        return 0
    return min(
        abs(position[0] - anchor[0]) + abs(position[1] - anchor[1])
        for anchor in anchors
    )


def _bounded_positions(
    values: object,
    limit: int,
    anchors: tuple[Position, ...],
) -> list[list[int]]:
    if not isinstance(values, list):
        return []
    positions = {position for value in values if (position := _position(value)) is not None}
    selected = sorted(positions, key=lambda item: (_distance(item, anchors), item))[:limit]
    return [[position[0], position[1]] for position in selected]


def compact_memory_document(
    memory: Mapping[str, Any],
    state: Turn,
) -> dict[str, Any]:
    """Return a bounded, deterministic, fully recoverable memory document."""

    document = dict(memory)
    anchors = _anchors(state)
    known = _bounded_positions(document.get("known_cells"), MAX_KNOWN_CELLS, anchors)
    obstacles = _bounded_positions(
        document.get("obstacle_cells"), MAX_OBSTACLE_CELLS, anchors
    )
    resources = _bounded_positions(
        document.get("resource_hints"), MAX_RESOURCE_HINTS, anchors
    )
    known_keys = {(cell[0], cell[1]) for cell in known}
    document["known_cells"] = known
    document["obstacle_cells"] = obstacles
    document["resource_hints"] = resources
    document["visited_cells"] = [
        entry
        for entry in document.get("visited_cells", [])
        if isinstance(entry, list)
        and len(entry) == 2
        and _position(entry[0]) in known_keys
    ][:MAX_KNOWN_CELLS]
    document["cell_last_seen"] = [
        entry
        for entry in document.get("cell_last_seen", [])
        if isinstance(entry, list)
        and len(entry) == 3
        and (entry[0], entry[1]) in known_keys
    ][:MAX_KNOWN_CELLS]
    active_ids = {str(unit.id) for unit in state.units}
    recent = document.get("recent_positions", {})
    document["recent_positions"] = {
        key: recent[key]
        for key in sorted(recent)
        if key in active_ids
    } if isinstance(recent, dict) else {}
    for key in (
        "worker_targets",
        "scout_targets",
        "scout_target_started",
        "worker_sectors",
        "combat_targets",
        "combat_target_started",
        "combat_sectors",
        "guard_targets",
        "guard_sectors",
        "worker_block_targets",
        "peak_hp",
        "worker_cycle_started",
    ):
        value = document.get(key)
        if isinstance(value, dict):
            document[key] = {
                item_key: value[item_key]
                for item_key in sorted(value)
                if item_key in active_ids
            }
    for key in (
        "guard_ranger_ids",
        "pursuit_unit_ids",
        "living_worker_ids",
        "population_relief_worker_ids",
    ):
        value = document.get(key)
        if isinstance(value, list):
            document[key] = sorted(
                item for item in value if isinstance(item, str) and item in active_ids
            )
    enemy_tracks = document.get("enemy_tracks")
    retained_enemy_ids: set[str] = set()
    if isinstance(enemy_tracks, dict):
        ranked = sorted(
            enemy_tracks.items(),
            key=lambda item: (
                -int(item[1].get("last_seen_tick", 0))
                if isinstance(item[1], dict)
                else 0,
                item[0],
            ),
        )[:MAX_ENEMY_TRACKS]
        document["enemy_tracks"] = dict(ranked)
        retained_enemy_ids = {item[0] for item in ranked}
    assignments = document.get("tracker_assignments")
    if isinstance(assignments, dict):
        document["tracker_assignments"] = {
            key: assignments[key]
            for key in sorted(assignments)
            if key in active_ids and assignments[key] in retained_enemy_ids
        }
    sightings = document.get("enemy_sightings")
    if isinstance(sightings, list):
        document["enemy_sightings"] = sorted(
            (
                entry
                for entry in sightings
                if isinstance(entry, list) and len(entry) == 3
            ),
            key=lambda entry: (-int(entry[2]), int(entry[0]), int(entry[1])),
        )[:MAX_ENEMY_TRACKS]
    document["economy_history"] = list(document.get("economy_history", []))[-256:]
    document["cycle_durations"] = list(document.get("cycle_durations", []))[-256:]
    return document

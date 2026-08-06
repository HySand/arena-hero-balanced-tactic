from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID

from arena_hero import APIError, BeaconStatus, CoreState, Direction, UnitType

from arena_hero_tactic.tactic.engine import (
    EnemyTrack,
    PHASE_EARLY,
    PHASE_LATE,
    PHASE_MID,
    POSTURE_ECONOMY,
    POSTURE_SURVIVAL,
    Pathfinder,
    TacticMemory,
    _exploration_radius,
    _is_tick_mismatch,
    _offense_ready,
    _normalize_api_key,
    _neighbors,
    _resource_chunk_patrol_targets,
    _resource_radius,
    _stale_visibility_patrol_targets,
    _strategy_phase,
    _worker_scout_limit,
    choose_actions,
)
from arena_hero_tactic.configuration.strategy import default_config_dict, strategy_config_from_dict


Position = tuple[int, int]
_UNSET = object()


def uid(number: int) -> UUID:
    return UUID(int=number)


class FakeUnit:
    def __init__(
        self,
        number: int,
        position: Position,
        unit_type: UnitType,
        *,
        cargo: int = 0,
        hp: int | None = None,
    ) -> None:
        self.id = uid(number)
        self.position = position
        self.unit_type = unit_type
        self.cargo = cargo
        self.hp = hp if hp is not None else {
            UnitType.WORKER: 2,
            UnitType.VANGUARD: 4,
            UnitType.RANGER: 2,
        }[unit_type]
        self.action = None

    def move(self, direction: Direction) -> None:
        self.action = ("MOVE", direction)

    def harvest(self) -> None:
        self.action = ("HARVEST",)

    def deposit(self) -> None:
        self.action = ("DEPOSIT",)

    def sweep(self, direction: Direction) -> None:
        self.action = ("SWEEP", direction)

    def shoot(self, target: object) -> None:
        self.action = ("SHOOT", target.id)

    def shoot_cell(self, position: Position) -> None:
        self.action = ("SHOOT_CELL", position)

    def heal(self) -> None:
        self.action = ("HEAL",)

    def self_destruct(self) -> None:
        self.action = ("SELF_DESTRUCT",)

    def pickup_beacon(self) -> None:
        self.action = ("PICKUP_BEACON",)


class FakeCore:
    def __init__(
        self,
        position: Position = (0, 0),
        *,
        shield: int = 5,
        hp: int = 5,
        state: CoreState = CoreState.NORMAL,
        owner_username: str = "test-player",
    ) -> None:
        self.id = uid(10_000)
        self.position = position
        self.hp = hp
        self.shield = shield
        self.owner_username = owner_username
        self.view = SimpleNamespace(state=state)
        self.action = None

    def spawn(self, unit_type: UnitType) -> None:
        self.action = ("SPAWN", unit_type)

    def repair_shield(self) -> None:
        self.action = ("REPAIR_SHIELD",)

    def heal(self) -> None:
        self.action = ("HEAL",)

    def pickup_beacon(self) -> None:
        self.action = ("PICKUP_BEACON",)

    def start_move(self, direction: Direction) -> None:
        self.action = ("START_MOVE", direction)

    def cancel_move(self) -> None:
        self.action = ("CANCEL_MOVE",)


class FakeTurn:
    def __init__(
        self,
        *,
        tick: int = 1,
        core: FakeCore | None | object = _UNSET,
        units: list[FakeUnit] | None = None,
        resources: int = 5,
        resource_space: int = 5,
        resource_cells: set[Position] | None = None,
        obstacle_cells: set[Position] | None = None,
        enemies: list[object] | None = None,
        events: list[object] | None = None,
        beacon_position: Position = (50, 50),
        beacon_status: BeaconStatus | None = None,
        beacon_carrier: UUID | None = None,
    ) -> None:
        self.tick = tick
        self.core = FakeCore() if core is _UNSET else core
        self.units = tuple(units or [])
        self.workers = tuple(u for u in self.units if u.unit_type is UnitType.WORKER)
        self.vanguards = tuple(
            u for u in self.units if u.unit_type is UnitType.VANGUARD
        )
        self.rangers = tuple(u for u in self.units if u.unit_type is UnitType.RANGER)
        self.resources = resources
        self.resource_space = resource_space
        self.resource_cells = frozenset(resource_cells or set())
        self.obstacle_cells = frozenset(obstacle_cells or set())
        self.visible_enemies = tuple(enemies or [])
        self.events = tuple(events or [])
        self.beacon = SimpleNamespace(
            position=beacon_position,
            status=beacon_status,
            carrier_id=beacon_carrier,
        )


def enemy(
    number: int,
    position: Position,
    unit_type: UnitType | None = UnitType.VANGUARD,
    *,
    core: bool = False,
) -> object:
    return SimpleNamespace(
        id=uid(number),
        kind="CORE" if core else "UNIT",
        position=position,
        unit_type=None if core else unit_type,
        hp=5 if core else 2,
        shield=5 if core else 0,
    )

def missing_enemy_memory(
    tracker: FakeUnit,
    position: Position,
    previous_position: Position,
) -> tuple[UUID, TacticMemory]:
    enemy_id = uid(101)
    known = {
        (x, y)
        for x in range(position[0] - 4, position[0] + 5)
        for y in range(position[1] - 4, position[1] + 5)
        if abs(x - position[0]) + abs(y - position[1]) <= 4
    }
    return enemy_id, TacticMemory(
        known_cells=known,
        cell_last_seen={cell: 1 for cell in known},
        enemy_tracks={
            enemy_id: EnemyTrack(
                position=position,
                previous_position=previous_position,
                first_seen_tick=1,
                last_seen_tick=1,
                missing_since_tick=2,
                kind="UNIT",
                unit_type=UnitType.VANGUARD,
                hp=4,
            )
        },
        tracker_assignments={tracker.id: enemy_id},
        first_tick=1,
        last_tick=2,
    )


def arena_event(
    event_type: str,
    *,
    tick: int,
    actor_id: UUID | None = None,
    amount: int = 0,
    reason_code: str | None = None,
) -> object:
    return SimpleNamespace(
        event_type=event_type,
        reason_code=reason_code,
        tick=tick,
        actor_id=actor_id,
        target_id=None,
        position=None,
        values={"amount": amount},
        resource_amount=amount,
        harvest_source=None,
    )



def moved_position(unit: FakeUnit) -> Position:
    assert unit.action is not None and unit.action[0] == "MOVE"
    dx, dy = unit.action[1].delta
    return unit.position[0] + dx, unit.position[1] + dy


class BalancedTacticTests(unittest.TestCase):
    def setUp(self) -> None:
        self.active_block_patch = patch(
            "arena_hero_tactic.tactic.engine.active_block_id", return_value=None
        )
        self.active_block_patch.start()
        self.addCleanup(self.active_block_patch.stop)
        self.config_patch = patch(
            "arena_hero_tactic.tactic.engine.load_strategy_config",
            return_value=strategy_config_from_dict(default_config_dict()),
        )
        self.config_patch.start()
        self.addCleanup(self.config_patch.stop)

    def test_neighbors_follow_direction_order(self) -> None:
        self.assertEqual(
            _neighbors((5, 5)),
            ((5, 4), (6, 5), (5, 6), (4, 5)),
        )

    def test_only_tick_mismatch_is_treated_as_a_stale_submission(self) -> None:
        self.assertTrue(
            _is_tick_mismatch(APIError(status_code=409, error="TICK_MISMATCH"))
        )
        self.assertFalse(
            _is_tick_mismatch(APIError(status_code=409, error="OTHER_CONFLICT"))
        )

    def test_api_key_copy_artifacts_are_removed(self) -> None:
        self.assertEqual(
            _normalize_api_key(" \ufeff“agent-\nkey-123”\u200b "),
            "agent-key-123",
        )

    def test_api_key_rejects_real_non_ascii_content(self) -> None:
        with self.assertRaises(SystemExit):
            _normalize_api_key("agent-key-密钥")

    def test_respawning_queues_nothing(self) -> None:
        turn = FakeTurn(core=None)
        choose_actions(turn)
        self.assertEqual(turn.units, ())

    def test_worker_harvests_and_deposits(self) -> None:
        harvester = FakeUnit(1, (1, 0), UnitType.WORKER)
        depositor = FakeUnit(2, (0, 0), UnitType.WORKER, cargo=1)
        turn = FakeTurn(
            units=[harvester, depositor],
            resources=4,
            resource_cells={(1, 0)},
        )
        choose_actions(turn)
        self.assertEqual(harvester.action, ("HARVEST",))
        self.assertEqual(depositor.action, ("DEPOSIT",))

    def test_lowest_uuid_wins_same_cell_harvest_intent(self) -> None:
        low = FakeUnit(1, (1, 0), UnitType.WORKER)
        high = FakeUnit(2, (1, 0), UnitType.WORKER)
        turn = FakeTurn(units=[high, low], resource_cells={(1, 0)})
        choose_actions(turn)
        self.assertEqual(low.action, ("HARVEST",))
        self.assertNotEqual(high.action, ("HARVEST",))

    def test_multiple_workers_receive_distinct_resource_targets(self) -> None:
        first = FakeUnit(1, (0, 0), UnitType.WORKER)
        second = FakeUnit(2, (0, 2), UnitType.WORKER)
        memory = TacticMemory()
        resources = {(2, 0), (2, 2)}
        turn = FakeTurn(
            core=FakeCore(position=(0, 0)),
            units=[first, second],
            resource_cells=resources,
        )
        choose_actions(turn, memory)
        self.assertEqual(set(memory.worker_targets.values()), resources)
        self.assertEqual(first.action, ("MOVE", Direction.RIGHT))
        self.assertEqual(second.action, ("MOVE", Direction.RIGHT))

    def test_movement_uses_bfs_around_obstacle(self) -> None:
        worker = FakeUnit(1, (0, 0), UnitType.WORKER)
        turn = FakeTurn(
            core=FakeCore(position=(0, 0)),
            units=[worker],
            resource_cells={(2, 0)},
            obstacle_cells={(1, 0)},
        )
        choose_actions(turn)
        self.assertIn(
            worker.action,
            {("MOVE", Direction.UP), ("MOVE", Direction.DOWN)},
        )

    def test_pathfinder_does_not_cross_unknown_cells_as_shortcut(self) -> None:
        known = {(0, 0), (0, -1), (1, -1), (2, -1), (2, 0)}
        pathfinder = Pathfinder(set(), set(), (-2, -2, 4, 4), known)
        self.assertEqual(pathfinder.distance_to((0, 0), (2, 0)), 4)
        self.assertEqual(pathfinder.first_step((0, 0), (2, 0)), Direction.UP)

    def test_pathfinder_allows_unknown_frontier_as_terminal_goal(self) -> None:
        pathfinder = Pathfinder(set(), set(), (-2, -2, 4, 4), {(0, 0), (1, 0)})
        self.assertEqual(pathfinder.distance_to((0, 0), (2, 0)), 2)
        self.assertEqual(pathfinder.first_step((0, 0), (2, 0)), Direction.RIGHT)
        self.assertEqual(pathfinder.first_step((1, 0), (2, 0)), Direction.RIGHT)

    def test_resource_radius_uses_real_route_around_obstacles(self) -> None:
        worker = FakeUnit(1, (0, 0), UnitType.WORKER)
        memory = TacticMemory(first_tick=1, last_tick=1)
        config = strategy_config_from_dict(default_config_dict())
        wall = {(1, y) for y in range(-5, 6)}
        turn = FakeTurn(
            tick=1,
            core=FakeCore(position=(0, 0)),
            units=[worker],
            resource_cells={(4, 0)},
            obstacle_cells=wall,
        )
        choose_actions(turn, memory, config)
        self.assertNotIn(worker.id, memory.worker_targets)
        self.assertEqual(memory.resource_candidate_count, 0)

    def test_resource_assignment_limits_the_complete_round_trip(self) -> None:
        worker = FakeUnit(1, (-10, 0), UnitType.WORKER)
        memory = TacticMemory(first_tick=1, last_tick=1)
        config = strategy_config_from_dict(default_config_dict())
        turn = FakeTurn(
            tick=1,
            core=FakeCore(position=(0, 0)),
            units=[worker],
            resource_cells={(10, 0)},
        )
        choose_actions(turn, memory, config)
        self.assertNotIn(worker.id, memory.worker_targets)
        self.assertEqual(memory.resource_candidate_count, 0)

    def test_effective_resource_radius_tracks_actual_assignments(self) -> None:
        worker = FakeUnit(1, (0, 0), UnitType.WORKER)
        memory = TacticMemory(
            first_tick=1,
            last_tick=1,
            known_cells={(x, 0) for x in range(9)},
        )
        config = strategy_config_from_dict(default_config_dict())
        turn = FakeTurn(
            tick=1,
            core=FakeCore(position=(0, 0)),
            units=[worker],
            resource_cells={(2, 0), (8, 0)},
        )
        choose_actions(turn, memory, config)
        self.assertEqual(memory.worker_targets[worker.id], (2, 0))
        self.assertEqual(memory.resource_candidate_count, 2)
        self.assertEqual(memory.resource_assignment_count, 1)
        self.assertEqual(memory.effective_resource_radius, 2)

    def test_scout_keeps_waypoint_while_crossing_frontier(self) -> None:
        memory = TacticMemory()
        first = FakeUnit(1, (0, 0), UnitType.WORKER)
        choose_actions(FakeTurn(tick=10, units=[first]), memory)
        target = memory.scout_targets[first.id]
        second = FakeUnit(1, moved_position(first), UnitType.WORKER)
        choose_actions(FakeTurn(tick=11, units=[second]), memory)
        self.assertEqual(memory.scout_targets[second.id], target)
        self.assertEqual(second.action[0], "MOVE")

    def test_tick_rollback_clears_stale_world_state(self) -> None:
        memory = TacticMemory(
            owner_username="test-player",
            resource_hints={(99, 99)},
            obstacle_cells={(98, 98)},
            worker_targets={uid(1): (99, 99)},
            scout_targets={uid(1): (97, 97)},
            scout_target_started={uid(1): 90},
            known_cells={(99, 99)},
            last_tick=100,
        )
        worker = FakeUnit(1, (0, 0), UnitType.WORKER)
        memory.observe(FakeTurn(tick=1, units=[worker]))
        self.assertNotIn((99, 99), memory.resource_hints)
        self.assertNotIn((98, 98), memory.obstacle_cells)
        self.assertNotIn(uid(1), memory.worker_targets)
        self.assertNotEqual(memory.scout_targets.get(uid(1)), (97, 97))
        self.assertEqual(memory.last_tick, 1)

    def test_visible_missing_resource_invalidates_hint(self) -> None:
        memory = TacticMemory(resource_hints={(2, 0)})
        worker = FakeUnit(1, (0, 0), UnitType.WORKER)
        memory.observe(FakeTurn(units=[worker], resource_cells=set()))
        self.assertNotIn((2, 0), memory.resource_hints)

    def test_state_round_trip_preserves_scouting_memory(self) -> None:
        memory = TacticMemory(
            owner_username="test-player",
            scout_targets={uid(1): (4, 5)},
            scout_target_started={uid(1): 12},
            worker_sectors={uid(1): 3},
            resource_chunks={(2, -1)},
            combat_targets={uid(2): (8, 9)},
            combat_target_started={uid(2): 11},
            combat_sectors={uid(2): 6},
            guard_targets={uid(3): (0, -6)},
            guard_sectors={uid(3): 0},
            visited_cells={(0, 0): 3},
            cell_last_seen={(0, 0): 11, (1, 0): 13},
            enemy_sightings={(9, 9): 12},
            enemy_tracks={
                uid(101): EnemyTrack(
                    position=(9, 9),
                    previous_position=(8, 9),
                    first_seen_tick=10,
                    last_seen_tick=12,
                    missing_since_tick=13,
                    kind="UNIT",
                    unit_type=UnitType.RANGER,
                    hp=2,
                )
            },
            tracker_assignments={uid(2): uid(101)},
            peak_hp={uid(1): 2},
            peak_hp_by_type={UnitType.WORKER: 2},
            fleeing_worker_ticks=4,
            last_core_damage_tick=10,
            last_core_move_tick=9,
            last_tick=13,
        )
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "state.json"
            memory.save(state_path)
            restored = TacticMemory.load(state_path)
        self.assertEqual(restored.scout_targets, memory.scout_targets)
        self.assertEqual(restored.scout_target_started, memory.scout_target_started)
        self.assertEqual(restored.worker_sectors, memory.worker_sectors)
        self.assertEqual(restored.resource_chunks, {(2, -1)})
        self.assertEqual(restored.combat_targets, memory.combat_targets)
        self.assertEqual(
            restored.combat_target_started, memory.combat_target_started
        )
        self.assertEqual(restored.combat_sectors, memory.combat_sectors)
        self.assertEqual(restored.guard_targets, memory.guard_targets)
        self.assertEqual(restored.guard_sectors, memory.guard_sectors)
        self.assertEqual(restored.visited_cells[(0, 0)], 3)
        self.assertEqual(restored.cell_last_seen, memory.cell_last_seen)
        self.assertEqual(restored.enemy_sightings, memory.enemy_sightings)
        self.assertEqual(restored.enemy_tracks, memory.enemy_tracks)
        self.assertEqual(restored.tracker_assignments, memory.tracker_assignments)
        self.assertEqual(restored.peak_hp, memory.peak_hp)
        self.assertEqual(restored.peak_hp_by_type, memory.peak_hp_by_type)
        self.assertEqual(restored.fleeing_worker_ticks, 4)
        self.assertEqual(restored.last_core_damage_tick, 10)
        self.assertEqual(restored.last_core_move_tick, 9)

    def test_full_storage_worker_does_not_harvest(self) -> None:
        worker = FakeUnit(1, (1, 0), UnitType.WORKER)
        turn = FakeTurn(
            units=[worker],
            resource_space=0,
            resource_cells={(1, 0)},
        )
        choose_actions(turn)
        self.assertNotEqual(worker.action, ("HARVEST",))

    def test_worker_flees_from_immediate_combat_danger(self) -> None:
        worker = FakeUnit(1, (0, 0), UnitType.WORKER)
        threat = enemy(101, (1, 0), UnitType.VANGUARD)
        memory = TacticMemory()
        turn = FakeTurn(
            core=FakeCore(position=(8, 8)),
            units=[worker],
            enemies=[threat],
        )
        choose_actions(turn, memory)
        destination = moved_position(worker)
        before = abs(worker.position[0] - threat.position[0]) + abs(
            worker.position[1] - threat.position[1]
        )
        after = abs(destination[0] - threat.position[0]) + abs(
            destination[1] - threat.position[1]
        )
        self.assertGreater(after, before)
        self.assertEqual(memory.last_posture, POSTURE_SURVIVAL)

    def test_worker_prefers_safe_resource_over_threatened_resource(self) -> None:
        worker = FakeUnit(1, (-3, 0), UnitType.WORKER)
        threat = enemy(101, (2, 0), UnitType.VANGUARD)
        memory = TacticMemory()
        turn = FakeTurn(
            core=FakeCore(position=(-5, 0)),
            units=[worker],
            resource_cells={(-1, 0), (1, 0)},
            enemies=[threat],
        )
        choose_actions(turn, memory)
        self.assertEqual(memory.worker_targets[worker.id], (-1, 0))
        self.assertEqual(worker.action, ("MOVE", Direction.RIGHT))

    def test_remote_weak_threat_keeps_hurt_worker_in_economy_mode(self) -> None:
        worker = FakeUnit(1, (-3, 0), UnitType.WORKER, hp=1)
        threat = enemy(101, (3, 0), UnitType.VANGUARD)
        memory = TacticMemory()
        turn = FakeTurn(
            core=FakeCore(position=(-5, 0)),
            units=[worker],
            enemies=[threat],
        )
        choose_actions(turn, memory)
        self.assertEqual(memory.last_posture, POSTURE_ECONOMY)
        self.assertNotEqual(worker.action, ("MOVE", Direction.LEFT))

    def test_recent_worker_loss_prioritizes_a_defender(self) -> None:
        survivor = FakeUnit(1, (2, 0), UnitType.WORKER)
        memory = TacticMemory(
            first_tick=1,
            last_tick=49,
            living_worker_ids={uid(1), uid(2)},
        )
        core = FakeCore()
        turn = FakeTurn(tick=50, core=core, units=[survivor], resources=10)
        choose_actions(turn, memory)
        self.assertEqual(core.action, ("SPAWN", UnitType.VANGUARD))
        self.assertEqual(memory.worker_losses, 1)

    def test_recent_worker_loss_recovers_worker_when_defender_is_unaffordable(self) -> None:
        survivor = FakeUnit(1, (2, 0), UnitType.WORKER)
        memory = TacticMemory(
            first_tick=1,
            last_tick=49,
            living_worker_ids={uid(1), uid(2)},
        )
        core = FakeCore()
        turn = FakeTurn(tick=50, core=core, units=[survivor], resources=6)
        choose_actions(turn, memory)
        self.assertEqual(core.action, ("SPAWN", UnitType.WORKER))
        self.assertEqual(memory.worker_losses, 1)

    def test_new_danger_cancels_an_unsafe_scout_waypoint(self) -> None:
        memory = TacticMemory()
        first = FakeUnit(1, (0, 0), UnitType.WORKER)
        choose_actions(FakeTurn(tick=10, units=[first]), memory)
        old_target = memory.scout_targets[first.id]
        second = FakeUnit(1, moved_position(first), UnitType.WORKER)
        threat = enemy(101, old_target, UnitType.VANGUARD)
        choose_actions(FakeTurn(tick=11, units=[second], enemies=[threat]), memory)
        self.assertNotEqual(memory.scout_targets.get(second.id), old_target)

    def test_vanguard_sweeps_and_ranger_shoots_legal_targets(self) -> None:
        vanguard = FakeUnit(1, (0, 0), UnitType.VANGUARD, hp=4)
        ranger = FakeUnit(2, (2, 0), UnitType.RANGER)
        adjacent = enemy(101, (1, 0))
        ranged = enemy(102, (2, 3), core=True)
        turn = FakeTurn(units=[vanguard, ranger], enemies=[adjacent, ranged])
        choose_actions(turn)
        self.assertEqual(vanguard.action, ("SWEEP", Direction.RIGHT))
        self.assertEqual(ranger.action, ("SHOOT_CELL", ranged.position))

    def test_early_combat_units_ignore_ground_beacon(self) -> None:
        vanguard = FakeUnit(1, (5, 0), UnitType.VANGUARD)
        ranger = FakeUnit(2, (0, 0), UnitType.RANGER)
        memory = TacticMemory(first_tick=1, last_tick=9)
        turn = FakeTurn(
            tick=10,
            units=[vanguard, ranger],
            beacon_position=(3, 0),
            beacon_status=BeaconStatus.GROUND,
        )
        choose_actions(turn, memory)
        self.assertNotEqual(vanguard.action, ("MOVE", Direction.LEFT))
        self.assertNotEqual(vanguard.action, ("PICKUP_BEACON",))
        target = memory.combat_targets[vanguard.id]
        self.assertLessEqual(abs(target[0]) + abs(target[1]), 80)

    def test_idle_workers_split_into_distinct_exploration_sectors(self) -> None:
        workers = [
            FakeUnit(1, (0, 0), UnitType.WORKER),
            FakeUnit(2, (0, 0), UnitType.WORKER),
            FakeUnit(3, (0, 0), UnitType.WORKER),
            FakeUnit(4, (0, 0), UnitType.WORKER),
        ]
        memory = TacticMemory()
        config = strategy_config_from_dict(default_config_dict())
        choose_actions(FakeTurn(units=workers, resources=0), memory, config)
        self.assertEqual(len(memory.scout_targets), 4)
        scout_ids = set(memory.scout_targets)
        self.assertEqual(
            len({memory.worker_sectors[worker_id] for worker_id in scout_ids}),
            4,
        )

    def test_prolonged_scarcity_sends_workers_to_distinct_outer_frontier(self) -> None:
        workers = [
            FakeUnit(index, (0, 0), UnitType.WORKER)
            for index in range(1, 13)
        ]
        known_cells = {
            (x, y)
            for x in range(-70, 71)
            for y in range(-70, 71)
            if abs(x) + abs(y) <= 70
        }
        known_cells.remove((12, 0))
        memory = TacticMemory(
            known_cells=known_cells,
            obstacle_cells={(70, 0)},
            scout_targets={workers[0].id: (4, 0)},
            scout_target_started={workers[0].id: 90},
            first_tick=1,
            last_tick=100,
            resource_candidate_count=1,
            economy_history=[
                {
                    "tick": tick,
                    "workers": 12,
                    "deposited": 0,
                    "busy": 12,
                    "candidates": 1,
                    "storage_full": 0,
                    "scouts": 12,
                    "new_cells": 0,
                }
                for tick in range(89, 101)
            ],
        )
        config = strategy_config_from_dict(default_config_dict())

        choose_actions(
            FakeTurn(tick=101, units=workers, resources=0),
            memory,
            config,
        )

        targets = list(memory.scout_targets.values())
        self.assertEqual(len(targets), len(workers))
        self.assertEqual(len(set(targets)), len(workers))
        self.assertTrue(all(abs(x) + abs(y) > 64 for x, y in targets))
        self.assertNotEqual(memory.scout_targets[workers[0].id], (4, 0))

    def test_scarcity_assigns_a_remembered_resource_beyond_old_radius(self) -> None:
        worker = FakeUnit(1, (0, 0), UnitType.WORKER)
        memory = TacticMemory(
            known_cells={(x, 0) for x in range(55)},
            resource_hints={(54, 0)},
            first_tick=1,
            last_tick=10,
        )
        document = default_config_dict()
        document["pacing"]["enabled"] = False
        document["adaptive_economy"]["max_resource_radius"] = 44
        config = strategy_config_from_dict(document)

        choose_actions(FakeTurn(tick=11, units=[worker]), memory, config)

        self.assertEqual(memory.worker_targets[worker.id], (54, 0))
        self.assertGreaterEqual(memory.resource_radius_limit or 0, 64)

    def test_scarcity_patrols_a_known_resource_chunk(self) -> None:
        workers = [
            FakeUnit(index, (0, 0), UnitType.WORKER)
            for index in range(1, 5)
        ]
        memory = TacticMemory(
            known_cells={(x, y) for x in range(16) for y in range(16)},
            resource_chunks={(0, 0)},
            first_tick=1,
            last_tick=10,
        )
        choose_actions(FakeTurn(tick=11, units=workers), memory)

        self.assertEqual(len(memory.scout_targets), 4)
        self.assertTrue(
            all(_target[0] < 32 and _target[1] < 32 for _target in memory.scout_targets.values())
        )

    def test_stale_visibility_patrol_skips_unreachable_cells(self) -> None:
        memory = TacticMemory(
            known_cells={
                (0, 0),
                (1, 0),
                (2, 0),
                (3, 0),
                (4, 0),
                (4, 1),
                (9, 0),
            },
            cell_last_seen={
                (1, 0): 1,
                (4, 0): 1,
                (9, 0): 1,
            },
        )
        pathfinder = Pathfinder(
            obstacles={(5, 0), (5, 1), (5, -1)},
            blocked={(5, 0), (5, 1), (5, -1)},
            bounds=(-1, -1, 10, 2),
            known_cells=memory.known_cells,
        )
        targets = _stale_visibility_patrol_targets(
            memory,
            pathfinder,
            (0, 0),
            current_tick=100,
            max_radius=20,
        )
        self.assertIn((1, 0), targets)
        self.assertIn((4, 0), targets)
        self.assertNotIn((9, 0), targets)
    def test_resource_chunk_patrol_prefers_stale_visibility(self) -> None:
        cells = {(x, 0) for x in range(32)}
        memory = TacticMemory(
            known_cells=cells,
            resource_chunks={(0, 0)},
            cell_last_seen={cell: 100 for cell in cells},
        )
        memory.cell_last_seen[(4, 0)] = 10
        pathfinder = Pathfinder(set(), set(), None, cells)

        targets = _resource_chunk_patrol_targets(memory, pathfinder, (0, 0), 64)

        self.assertIn((4, 0), targets)

    def test_partial_resource_supply_sends_other_workers_to_chunk_patrol(self) -> None:
        workers = [
            FakeUnit(index, (0, 0), UnitType.WORKER)
            for index in range(1, 5)
        ]
        memory = TacticMemory(
            known_cells={(x, y) for x in range(16) for y in range(16)},
            resource_chunks={(0, 0)},
            first_tick=1,
            last_tick=10,
        )

        choose_actions(
            FakeTurn(tick=11, units=workers, resource_cells={(8, 8)}),
            memory,
        )

        self.assertEqual(len(memory.worker_targets), 1)
        self.assertEqual(len(memory.scout_targets), 3)

    def test_quiet_economy_expands_assignment_when_adaptive_radius_is_tight(self) -> None:
        workers = [
            FakeUnit(1, (0, 0), UnitType.WORKER),
            FakeUnit(2, (0, 1), UnitType.WORKER),
        ]
        memory = TacticMemory(
            known_cells={(x, 0) for x in range(55)} | {(0, 1)},
            resource_hints={(4, 0), (54, 0)},
            adaptive_radius_delta=-64,
            first_tick=1,
            last_tick=10,
        )
        document = default_config_dict()
        document["pacing"]["enabled"] = False
        document["adaptive_economy"]["max_resource_radius"] = 96
        config = strategy_config_from_dict(document)

        choose_actions(
            FakeTurn(tick=11, units=workers, resource_cells={(4, 0)}),
            memory,
            config,
        )

        self.assertEqual(set(memory.worker_targets.values()), {(4, 0), (54, 0)})
        self.assertEqual(memory.resource_candidate_count, 2)
        self.assertEqual(memory.resource_radius_limit, 96)

    def test_early_phase_keeps_workers_on_nearby_resources(self) -> None:
        worker = FakeUnit(1, (0, 0), UnitType.WORKER)
        memory = TacticMemory(first_tick=1, last_tick=1)
        config = strategy_config_from_dict(default_config_dict())
        turn = FakeTurn(
            tick=1,
            core=FakeCore(position=(0, 0)),
            units=[worker],
            resource_cells={(4, 0), (15, 0)},
        )
        choose_actions(turn, memory, config)
        self.assertEqual(_strategy_phase(turn, memory, config), PHASE_EARLY)
        self.assertEqual(_resource_radius(turn, memory, config), 10)
        self.assertEqual(memory.worker_targets[worker.id], (4, 0))

    def test_population_and_time_expand_resource_radius(self) -> None:
        workers = [
            FakeUnit(index + 1, (0, index), UnitType.WORKER)
            for index in range(6)
        ]
        memory = TacticMemory(
            first_tick=1,
            last_tick=80,
            known_cells={(x, 0) for x in range(16)},
        )
        config = strategy_config_from_dict(default_config_dict())
        turn = FakeTurn(
            tick=100,
            core=FakeCore(position=(0, 0)),
            units=workers,
            resource_cells={(15, 0)},
        )
        choose_actions(turn, memory, config)
        self.assertEqual(_strategy_phase(turn, memory, config), PHASE_MID)
        self.assertEqual(_resource_radius(turn, memory, config), 22)
        self.assertIn((15, 0), memory.worker_targets.values())

    def test_disabled_pacing_keeps_adaptive_search_radius_active(self) -> None:
        document = default_config_dict()
        document["pacing"]["enabled"] = False
        config = strategy_config_from_dict(document)
        memory = TacticMemory()
        turn = FakeTurn(core=FakeCore(position=(0, 0)))

        self.assertEqual(_resource_radius(turn, memory, config), 96)
        self.assertEqual(_exploration_radius(turn, memory, config), 96)

    def test_adaptive_scout_bonus_adds_to_economy_scout_limit(self) -> None:
        config = strategy_config_from_dict(default_config_dict())
        memory = TacticMemory(adaptive_scout_bonus=2)

        self.assertEqual(_worker_scout_limit(FakeTurn(), memory, config), 3)

    def test_late_fleet_pursues_a_visible_remote_enemy(self) -> None:
        units = [
            *[
                FakeUnit(index + 1, (index + 1, 0), UnitType.WORKER)
                for index in range(7)
            ],
            FakeUnit(20, (1, 1), UnitType.VANGUARD),
            FakeUnit(21, (2, 1), UnitType.VANGUARD),
            FakeUnit(22, (3, 1), UnitType.RANGER),
        ]
        memory = TacticMemory(first_tick=1, last_tick=200)
        config = strategy_config_from_dict(default_config_dict())
        turn = FakeTurn(
            tick=220,
            core=FakeCore(position=(0, 0)),
            units=units,
            resources=40,
            enemies=[enemy(101, (9, 1), UnitType.RANGER)],
        )
        choose_actions(turn, memory, config)
        self.assertEqual(_strategy_phase(turn, memory, config), PHASE_LATE)
        self.assertTrue(_offense_ready(turn, memory, config))
        self.assertIn(units[7].id, memory.pursuit_unit_ids)
        self.assertEqual(units[7].action[0], "MOVE")
        self.assertNotIn(units[7].id, memory.combat_targets)

    def test_late_offense_boost_produces_missing_attack_unit(self) -> None:
        document = default_config_dict()
        document["production"]["order"] = [
            {"unit_type": "WORKER", "target": 9},
            {"unit_type": "VANGUARD", "target": 1},
            {"unit_type": "RANGER", "target": 0},
        ]
        document["production"]["max_population"] = 20
        config = strategy_config_from_dict(document)
        units = [
            *[
                FakeUnit(index + 1, (index + 1, 0), UnitType.WORKER)
                for index in range(9)
            ],
            FakeUnit(20, (1, 1), UnitType.VANGUARD),
        ]
        memory = TacticMemory(first_tick=1, last_tick=200)
        core = FakeCore(position=(0, 0))
        choose_actions(
            FakeTurn(
                tick=220,
                core=core,
                units=units,
                resources=40,
            ),
            memory,
            config,
        )
        self.assertEqual(core.action, ("SPAWN", UnitType.VANGUARD))

    def test_worker_repeats_harvest_return_deposit_and_reassignment(self) -> None:
        memory = TacticMemory()

        mining = FakeUnit(1, (1, 0), UnitType.WORKER)
        choose_actions(
            FakeTurn(tick=1, units=[mining], resource_cells={(1, 0)}),
            memory,
        )
        self.assertEqual(mining.action, ("HARVEST",))

        loaded = FakeUnit(1, (1, 0), UnitType.WORKER, cargo=1)
        choose_actions(FakeTurn(tick=2, units=[loaded]), memory)
        self.assertEqual(loaded.action, ("MOVE", Direction.LEFT))

        home = FakeUnit(1, (0, 0), UnitType.WORKER, cargo=1)
        choose_actions(FakeTurn(tick=3, units=[home]), memory)
        self.assertEqual(home.action, ("DEPOSIT",))

        reassigned = FakeUnit(1, (0, 0), UnitType.WORKER)
        choose_actions(
            FakeTurn(tick=4, units=[reassigned], resource_cells={(2, 0)}),
            memory,
        )
        self.assertEqual(reassigned.action, ("MOVE", Direction.RIGHT))
        self.assertEqual(memory.worker_targets[reassigned.id], (2, 0))

    def test_workers_never_take_the_public_beacon(self) -> None:
        worker = FakeUnit(1, (0, 0), UnitType.WORKER)
        turn = FakeTurn(
            units=[worker],
            resources=0,
            beacon_position=(0, 0),
            beacon_status=BeaconStatus.GROUND,
        )
        choose_actions(turn)
        self.assertNotEqual(worker.action, ("PICKUP_BEACON",))

    def test_vanguard_pursues_visible_enemy_during_early_economy(self) -> None:
        vanguard = FakeUnit(1, (5, 0), UnitType.VANGUARD, hp=4)
        target = enemy(101, (8, 0), UnitType.RANGER)
        memory = TacticMemory(first_tick=1, last_tick=9)
        config = strategy_config_from_dict(default_config_dict())
        choose_actions(
            FakeTurn(
                tick=10,
                units=[vanguard],
                enemies=[target],
                resources=0,
            ),
            memory,
            config,
        )
        self.assertEqual(memory.last_posture, POSTURE_ECONOMY)
        self.assertIn(vanguard.id, memory.pursuit_unit_ids)
        self.assertEqual(vanguard.action, ("MOVE", Direction.RIGHT))

    def test_three_rangers_split_two_guards_and_one_outer_scout(self) -> None:
        first_guard = FakeUnit(1, (3, 0), UnitType.RANGER)
        second_guard = FakeUnit(2, (3, 3), UnitType.RANGER)
        outer = FakeUnit(3, (10, 0), UnitType.RANGER)
        memory = TacticMemory(first_tick=1, last_tick=99)
        config = strategy_config_from_dict(default_config_dict())
        choose_actions(
            FakeTurn(
                tick=100,
                units=[first_guard, second_guard, outer],
                resources=0,
            ),
            memory,
            config,
        )
        self.assertNotIn(first_guard.id, memory.combat_targets)
        self.assertNotIn(second_guard.id, memory.combat_targets)
        self.assertIn(outer.id, memory.combat_targets)

    def test_high_danger_recalls_all_rangers_to_defense(self) -> None:
        worker = FakeUnit(1, (0, 0), UnitType.WORKER)
        rangers = [
            FakeUnit(2, (3, 0), UnitType.RANGER),
            FakeUnit(3, (3, 3), UnitType.RANGER),
            FakeUnit(4, (10, 0), UnitType.RANGER),
        ]
        threat = enemy(101, (1, 0), UnitType.VANGUARD)
        memory = TacticMemory()
        choose_actions(
            FakeTurn(units=[worker, *rangers], enemies=[threat], resources=0),
            memory,
        )
        self.assertEqual(memory.last_posture, POSTURE_SURVIVAL)
        self.assertFalse(memory.combat_targets)

    def test_two_rangers_hold_distinct_radius_six_ring_sectors(self) -> None:
        first = FakeUnit(1, (0, -6), UnitType.RANGER)
        second = FakeUnit(2, (0, 6), UnitType.RANGER)
        memory = TacticMemory(first_tick=1, last_tick=19)
        choose_actions(
            FakeTurn(tick=20, units=[first, second], resources=0),
            memory,
        )
        self.assertEqual(memory.guard_ranger_ids, {first.id, second.id})
        self.assertEqual(set(memory.guard_sectors.values()), {0, 1})
        self.assertTrue(
            all(
                abs(target[0]) + abs(target[1]) == 6
                for target in memory.guard_targets.values()
            )
        )

    def test_remote_enemy_keeps_two_ring_guards_and_pulls_outer_ranger(self) -> None:
        first_guard = FakeUnit(1, (0, -6), UnitType.RANGER)
        second_guard = FakeUnit(2, (0, 6), UnitType.RANGER)
        outer = FakeUnit(3, (8, 0), UnitType.RANGER)
        target = enemy(101, (12, 0), UnitType.VANGUARD)
        memory = TacticMemory(first_tick=1, last_tick=19)
        choose_actions(
            FakeTurn(
                tick=20,
                units=[first_guard, second_guard, outer],
                enemies=[target],
                resources=0,
            ),
            memory,
        )
        self.assertEqual(
            memory.guard_ranger_ids,
            {first_guard.id, second_guard.id},
        )
        self.assertNotIn(first_guard.id, memory.pursuit_unit_ids)
        self.assertNotIn(second_guard.id, memory.pursuit_unit_ids)
        self.assertIn(outer.id, memory.pursuit_unit_ids)
        self.assertEqual(outer.action, ("SHOOT_CELL", (11, 0)))

    def test_rangers_spread_fire_across_current_and_possible_cells(self) -> None:
        first = FakeUnit(1, (0, 0), UnitType.RANGER)
        second = FakeUnit(2, (1, 0), UnitType.RANGER)
        memory = TacticMemory(first_tick=1)
        memory.observe(
            FakeTurn(
                tick=10,
                core=FakeCore(position=(10, 10)),
                units=[first, second],
                enemies=[enemy(101, (0, 2), UnitType.VANGUARD)],
                resources=0,
            )
        )
        first_next = FakeUnit(1, (0, 0), UnitType.RANGER)
        second_next = FakeUnit(2, (1, 0), UnitType.RANGER)
        choose_actions(
            FakeTurn(
                tick=11,
                core=FakeCore(position=(10, 10)),
                units=[first_next, second_next],
                enemies=[enemy(101, (0, 3), UnitType.VANGUARD)],
                resources=0,
            ),
            memory,
        )
        self.assertEqual(first_next.action, ("SHOOT_CELL", (0, 3)))
        self.assertEqual(second_next.action, ("SHOOT_CELL", (1, 3)))

    def test_missing_enemy_shot_uses_an_uncovered_possible_cell(self) -> None:
        ranger = FakeUnit(1, (0, 0), UnitType.RANGER)
        enemy_id, memory = missing_enemy_memory(ranger, (0, 2), (0, 1))

        choose_actions(
            FakeTurn(
                tick=3,
                core=FakeCore(position=(0, 0)),
                units=[ranger],
                obstacle_cells={(1, 0)},
                resources=0,
            ),
            memory,
        )

        self.assertIn(enemy_id, memory.enemy_tracks)
        self.assertEqual(ranger.action, ("SHOOT_CELL", (1, 1)))
        self.assertNotEqual(ranger.action[1], (0, 2))
        self.assertLess(memory.cell_last_seen.get(ranger.action[1], -1), 3)

    def test_tracker_moves_to_recover_occluded_search_cells(self) -> None:
        vanguard = FakeUnit(1, (1, 0), UnitType.VANGUARD)
        enemy_id, memory = missing_enemy_memory(vanguard, (1, 0), (0, 0))

        choose_actions(
            FakeTurn(
                tick=3,
                core=FakeCore(position=(0, 0)),
                units=[vanguard],
                obstacle_cells={(2, 0)},
                resources=0,
            ),
            memory,
        )

        self.assertIn(enemy_id, memory.enemy_tracks)
        self.assertIn(vanguard.id, memory.pursuit_unit_ids)
        self.assertIsNotNone(vanguard.action)
        self.assertEqual(vanguard.action[0], "MOVE")
        self.assertIn(vanguard.action[1], {Direction.UP, Direction.DOWN})

    def test_lost_enemy_track_survives_search_window_then_expires(self) -> None:
        memory = TacticMemory()
        scout = FakeUnit(1, (6, 0), UnitType.VANGUARD)
        memory.observe(
            FakeTurn(
                tick=1,
                units=[scout],
                enemies=[enemy(101, (10, 0), UnitType.RANGER)],
                resources=0,
            )
        )
        memory.observe(FakeTurn(tick=2, units=[], resources=0))
        self.assertIn(uid(101), memory.enemy_tracks)
        self.assertEqual(memory.enemy_tracks[uid(101)].missing_since_tick, 2)
        memory.observe(FakeTurn(tick=13, units=[], resources=0))
        self.assertIn(uid(101), memory.enemy_tracks)
        memory.observe(FakeTurn(tick=14, units=[], resources=0))
        self.assertNotIn(uid(101), memory.enemy_tracks)

    def test_full_population_sacrifices_far_empty_worker_and_spawns_ranger(self) -> None:
        document = default_config_dict()
        document["production"]["max_population"] = 19
        config = strategy_config_from_dict(document)
        workers = [
            FakeUnit(
                number,
                (10 + number, 0),
                UnitType.WORKER,
                cargo=1 if number == 18 else 0,
            )
            for number in range(1, 19)
        ]
        ranger = FakeUnit(50, (4, 0), UnitType.RANGER)
        core = FakeCore()
        memory = TacticMemory(first_tick=1, last_tick=19)
        choose_actions(
            FakeTurn(
                tick=20,
                core=core,
                units=[*workers, ranger],
                resources=12,
                enemies=[enemy(101, (3, 0), UnitType.VANGUARD)],
            ),
            memory,
            config,
        )
        sacrificed = [
            worker for worker in workers if worker.action == ("SELF_DESTRUCT",)
        ]
        self.assertEqual(len(sacrificed), 1)
        self.assertEqual(sacrificed[0].cargo, 0)
        self.assertEqual(sacrificed[0].id, uid(17))
        self.assertEqual(core.action, ("SPAWN", UnitType.RANGER))

    def test_remote_enemy_assigns_nearby_empty_workers_to_block_escape(self) -> None:
        workers = [
            FakeUnit(1, (8, 1), UnitType.WORKER),
            FakeUnit(2, (8, -1), UnitType.WORKER),
        ]
        memory = TacticMemory(first_tick=1, last_tick=19)
        choose_actions(
            FakeTurn(
                tick=20,
                units=workers,
                enemies=[enemy(101, (10, 0), UnitType.VANGUARD)],
                resources=0,
            ),
            memory,
        )
        self.assertEqual(set(memory.worker_block_targets), {uid(1), uid(2)})
        self.assertTrue(all(worker.action is not None for worker in workers))

    def test_hurt_ranger_returns_to_core_and_heals(self) -> None:
        ranger = FakeUnit(1, (0, 0), UnitType.RANGER, hp=1)
        choose_actions(FakeTurn(units=[ranger], resources=2))
        self.assertEqual(ranger.action, ("HEAL",))

    def test_full_core_sends_carrying_worker_to_explore(self) -> None:
        worker = FakeUnit(1, (0, 0), UnitType.WORKER, cargo=1)
        memory = TacticMemory()
        choose_actions(
            FakeTurn(
                units=[worker],
                resources=10,
                resource_space=0,
            ),
            memory,
        )
        self.assertIsNotNone(worker.action)
        self.assertEqual(worker.action[0], "MOVE")
        self.assertNotEqual(worker.action, ("DEPOSIT",))
        self.assertIn(worker.id, memory.scout_targets)

    def test_ranger_can_fire_three_cells_on_an_exact_diagonal(self) -> None:
        ranger = FakeUnit(1, (0, 0), UnitType.RANGER)
        diagonal_core = enemy(101, (3, 3), core=True)
        choose_actions(
            FakeTurn(
                core=FakeCore(position=(10, 10)),
                units=[ranger],
                enemies=[diagonal_core],
                resources=0,
            )
        )
        self.assertEqual(ranger.action, ("SHOOT_CELL", (3, 3)))
    def test_core_migrates_toward_more_open_ground(self) -> None:
        workers = [
            FakeUnit(number, (10 + number, 10), UnitType.WORKER)
            for number in range(1, 5)
        ]
        rangers = [
            FakeUnit(10, (8, 8), UnitType.RANGER),
            FakeUnit(11, (9, 8), UnitType.RANGER),
        ]
        vanguard = FakeUnit(12, (7, 8), UnitType.VANGUARD)
        core = FakeCore()
        memory = TacticMemory(first_tick=1, last_tick=99)
        document = default_config_dict()
        document["core"]["migration_danger_score"] = 2.0
        config = strategy_config_from_dict(document)
        turn = FakeTurn(
            tick=100,
            core=core,
            units=[*workers, *rangers, vanguard],
            resources=0,
            obstacle_cells={(2, 0), (1, 1)},
            enemies=[enemy(101, (3, 0), UnitType.VANGUARD)],
        )
        choose_actions(turn, memory, config)
        self.assertEqual(core.action, ("START_MOVE", Direction.UP))

    def test_carrying_worker_blocks_core_migration(self) -> None:
        workers = [
            FakeUnit(1, (11, 10), UnitType.WORKER, cargo=1),
            FakeUnit(2, (12, 10), UnitType.WORKER),
            FakeUnit(3, (13, 10), UnitType.WORKER),
            FakeUnit(4, (14, 10), UnitType.WORKER),
        ]
        rangers = [
            FakeUnit(10, (8, 8), UnitType.RANGER),
            FakeUnit(11, (9, 8), UnitType.RANGER),
        ]
        core = FakeCore()
        memory = TacticMemory(first_tick=1, last_tick=99)
        turn = FakeTurn(
            tick=100,
            core=core,
            units=[*workers, *rangers],
            resources=0,
            obstacle_cells={(2, 0), (1, 1)},
        )
        choose_actions(turn, memory)
        self.assertIsNone(core.action)

    def test_workers_evacuate_and_combat_units_cover_moving_core(self) -> None:
        core = FakeCore(state=CoreState.MOVING)
        worker = FakeUnit(1, (1, 0), UnitType.WORKER)
        vanguard = FakeUnit(2, (5, 0), UnitType.VANGUARD)
        ranger = FakeUnit(3, (0, 5), UnitType.RANGER)
        turn = FakeTurn(
            tick=20,
            core=core,
            units=[worker, vanguard, ranger],
            obstacle_cells={(0, 1)},
        )
        choose_actions(turn, TacticMemory(first_tick=1, last_tick=19))
        self.assertEqual(worker.action[0], "MOVE")
        self.assertIsNotNone(vanguard.action)
        self.assertIsNotNone(ranger.action)

    def test_core_attack_cancels_migration_immediately(self) -> None:
        core = FakeCore(state=CoreState.MOVING)
        damage_event = SimpleNamespace(
            event_type="CORE_DAMAGED",
            reason_code="ATTACK",
            tick=50,
            position=(0, 0),
            target_id=core.id,
            actor_id=uid(101),
            values={"shield": 4},
        )
        memory = TacticMemory(first_tick=1, last_tick=49)
        choose_actions(
            FakeTurn(
                tick=50,
                core=core,
                resources=0,
                events=[damage_event],
            ),
            memory,
        )
        self.assertEqual(core.action, ("CANCEL_MOVE",))
        self.assertNotEqual(memory.last_posture, POSTURE_ECONOMY)

    def test_dashboard_production_order_changes_real_spawn_priority(self) -> None:
        document = default_config_dict()
        document["production"]["reserve_resources"] = 0
        document["production"]["order"] = [
            {"unit_type": "VANGUARD", "target": 2},
            {"unit_type": "WORKER", "target": 6},
            {"unit_type": "RANGER", "target": 3},
        ]
        config = strategy_config_from_dict(document)
        worker = FakeUnit(1, (2, 0), UnitType.WORKER)
        core = FakeCore()
        choose_actions(
            FakeTurn(core=core, units=[worker], resources=20),
            TacticMemory(),
            config,
        )
        self.assertEqual(core.action, ("SPAWN", UnitType.VANGUARD))

    def test_dashboard_production_order_waits_for_first_unmet_step(self) -> None:
        document = default_config_dict()
        document["production"]["reserve_resources"] = 0
        document["production"]["order"] = [
            {"unit_type": "RANGER", "target": 1},
            {"unit_type": "WORKER", "target": 2},
            {"unit_type": "VANGUARD", "target": 0},
        ]
        config = strategy_config_from_dict(document)
        worker = FakeUnit(1, (2, 0), UnitType.WORKER)
        core = FakeCore()
        choose_actions(
            FakeTurn(core=core, units=[worker], resources=10),
            TacticMemory(),
            config,
        )
        self.assertIsNone(core.action)

    def test_dashboard_hold_mode_stops_normal_production_after_targets(self) -> None:
        document = default_config_dict()
        document["production"]["after_plan"] = "hold"
        document["production"]["order"] = [
            {"unit_type": "WORKER", "target": 1},
            {"unit_type": "VANGUARD", "target": 1},
            {"unit_type": "RANGER", "target": 1},
        ]
        config = strategy_config_from_dict(document)
        units = [
            FakeUnit(1, (3, 0), UnitType.WORKER),
            FakeUnit(2, (4, 0), UnitType.VANGUARD, hp=4),
            FakeUnit(3, (5, 0), UnitType.RANGER),
        ]
        core = FakeCore()
        choose_actions(
            FakeTurn(tick=100, core=core, units=units, resources=20),
            TacticMemory(first_tick=1, last_tick=99),
            config,
        )
        self.assertIsNone(core.action)

    def test_damaged_core_repairs_before_production(self) -> None:
        core = FakeCore(shield=0)
        turn = FakeTurn(core=core, resources=20, resource_space=0)
        choose_actions(turn)
        self.assertEqual(core.action, ("REPAIR_SHIELD",))

    def test_economy_production_starts_with_workers(self) -> None:
        core = FakeCore()
        turn = FakeTurn(core=core, resources=10, resource_space=0)
        choose_actions(turn)
        self.assertEqual(core.action, ("SPAWN", UnitType.WORKER))

    def test_quiet_development_spends_first_five_resources_on_worker(self) -> None:
        core = FakeCore()
        worker = FakeUnit(1, (2, 0), UnitType.WORKER)
        choose_actions(
            FakeTurn(core=core, units=[worker], resources=5),
            TacticMemory(),
        )
        self.assertEqual(core.action, ("SPAWN", UnitType.WORKER))

    def test_first_defender_milestone_waits_until_ten_resources(self) -> None:
        document = default_config_dict()
        document["production"]["enabled"] = True
        document["production"]["order"] = [
            {"unit_type": "WORKER", "target": 17},
            {"unit_type": "VANGUARD", "target": 1},
            {"unit_type": "RANGER", "target": 1},
        ]
        document["production"]["max_population"] = 19
        config = strategy_config_from_dict(document)
        workers = [
            FakeUnit(index, (index + 1, 0), UnitType.WORKER)
            for index in range(1, 7)
        ]
        core = FakeCore()
        choose_actions(
            FakeTurn(core=core, units=workers, resources=9),
            TacticMemory(),
            config,
        )
        self.assertIsNone(core.action)

    def test_first_defender_preempts_the_seventeen_worker_target(self) -> None:
        document = default_config_dict()
        document["production"]["enabled"] = True
        document["production"]["order"] = [
            {"unit_type": "WORKER", "target": 17},
            {"unit_type": "VANGUARD", "target": 1},
            {"unit_type": "RANGER", "target": 1},
        ]
        document["production"]["max_population"] = 19
        config = strategy_config_from_dict(document)
        workers = [
            FakeUnit(index, (index + 1, 0), UnitType.WORKER)
            for index in range(1, 7)
        ]
        core = FakeCore()
        choose_actions(
            FakeTurn(core=core, units=workers, resources=10),
            TacticMemory(),
            config,
        )
        self.assertEqual(core.action, ("SPAWN", UnitType.VANGUARD))

    def test_deposit_event_records_throughput_and_cycle_duration(self) -> None:
        worker = FakeUnit(1, (0, 0), UnitType.WORKER)
        memory = TacticMemory(
            last_tick=4,
            resource_candidate_count=2,
            resource_assignment_count=1,
            worker_cycle_started={worker.id: 1},
        )
        memory.observe(
            FakeTurn(
                tick=5,
                units=[worker],
                events=[
                    arena_event(
                        "DEPOSIT_SUCCEEDED",
                        tick=5,
                        actor_id=worker.id,
                        amount=2,
                    )
                ],
            )
        )
        sample = memory.economy_history[-1]
        self.assertEqual(sample["deposited"], 2)
        self.assertEqual(sample["candidates"], 2)
        self.assertEqual(sample["assignments"], 1)
        self.assertEqual(memory.cycle_durations, [4])
        self.assertNotIn(worker.id, memory.worker_cycle_started)

    def test_resource_scarcity_expands_radius_and_scout_budget(self) -> None:
        config = strategy_config_from_dict(default_config_dict())
        workers = [
            FakeUnit(index, (index, 0), UnitType.WORKER)
            for index in range(1, 5)
        ]
        memory = TacticMemory(
            first_tick=1,
            last_tick=8,
            economy_history=[
                {
                    "tick": tick,
                    "workers": 4,
                    "deposited": 0,
                    "busy": 1,
                    "candidates": 0,
                    "storage_full": 0,
                    "scouts": 1,
                    "new_cells": 1,
                }
                for tick in range(1, 9)
            ],
        )
        turn = FakeTurn(tick=9, units=workers, resources=0)
        choose_actions(turn, memory, config)
        self.assertEqual(memory.adaptive_action, "EXPAND_SEARCH")
        self.assertEqual(memory.adaptive_reason, "resource_scarcity")
        self.assertEqual(memory.adaptive_radius_delta, 2)
        self.assertEqual(memory.resource_radius_limit, 96)
        self.assertEqual(memory.adaptive_scout_bonus, 1)

    def test_one_candidate_does_not_hide_scarcity_from_a_large_workforce(self) -> None:
        config = strategy_config_from_dict(default_config_dict())
        workers = [
            FakeUnit(index, (0, 0), UnitType.WORKER)
            for index in range(1, 13)
        ]
        memory = TacticMemory(
            first_tick=1,
            last_tick=8,
            resource_candidate_count=1,
            economy_history=[
                {
                    "tick": tick,
                    "workers": 12,
                    "deposited": 0,
                    "busy": 12,
                    "candidates": 1,
                    "storage_full": 0,
                    "scouts": 11,
                    "new_cells": 1,
                }
                for tick in range(1, 9)
            ],
        )

        choose_actions(
            FakeTurn(tick=9, units=workers, resources=0),
            memory,
            config,
        )

        self.assertEqual(memory.adaptive_action, "EXPAND_SEARCH")
        self.assertGreaterEqual(
            memory.adaptive_scarcity_streak,
            config.adaptive_economy.scarcity_ticks,
        )
        self.assertGreater(_exploration_radius(FakeTurn(), memory, config), 64)

    def test_sufficient_candidates_end_the_scarcity_expedition(self) -> None:
        config = strategy_config_from_dict(default_config_dict())
        workers = [
            FakeUnit(index, (0, 0), UnitType.WORKER)
            for index in range(1, 13)
        ]
        memory = TacticMemory(
            first_tick=1,
            last_tick=12,
            resource_candidate_count=6,
            resource_assignment_count=6,
            adaptive_scarcity_streak=12,
            economy_history=[
                {
                    "tick": tick,
                    "workers": 12,
                    "deposited": 0,
                    "busy": 12,
                    "candidates": 1,
                    "storage_full": 0,
                    "scouts": 11,
                    "new_cells": 1,
                }
                for tick in range(1, 13)
            ],
        )
        previous_radius = _exploration_radius(
            FakeTurn(tick=12, units=workers),
            memory,
            config,
        )
        turn = FakeTurn(tick=13, units=workers, resources=0)

        choose_actions(turn, memory, config)

        self.assertGreater(previous_radius, 64)
        self.assertEqual(memory.adaptive_scarcity_streak, 0)
        self.assertLess(_exploration_radius(turn, memory, config), previous_radius)

    def test_full_storage_reduces_radius_and_worker_target(self) -> None:
        config = strategy_config_from_dict(default_config_dict())
        workers = [
            FakeUnit(index, (index, 0), UnitType.WORKER)
            for index in range(1, 7)
        ]
        memory = TacticMemory(
            first_tick=1,
            last_tick=8,
            economy_history=[
                {
                    "tick": tick,
                    "workers": 6,
                    "deposited": 0,
                    "busy": 2,
                    "candidates": 2,
                    "storage_full": 1,
                }
                for tick in range(1, 9)
            ],
        )
        choose_actions(
            FakeTurn(
                tick=9,
                units=workers,
                resources=0,
                resource_space=0,
            ),
            memory,
            config,
        )
        self.assertEqual(memory.adaptive_action, "CONSERVE")
        self.assertEqual(memory.adaptive_reason, "storage_often_full")
        self.assertEqual(memory.adaptive_radius_delta, -2)
        self.assertEqual(memory.adaptive_worker_target, 5)

    def test_state_round_trip_preserves_adaptive_economy(self) -> None:
        memory = TacticMemory(
            economy_history=[{"tick": 7, "workers": 4, "deposited": 1}],
            worker_cycle_started={uid(1): 3},
            cycle_durations=[5, 7],
            bounds=(-10, -20, 30, 40),
            adaptive_radius_delta=4,
            adaptive_scout_bonus=2,
            adaptive_worker_target=7,
            adaptive_worker_base_target=6,
            adaptive_last_adjust_tick=7,
            adaptive_action="EXPAND_SEARCH",
            adaptive_reason="resource_scarcity",
            adaptive_throughput=0.125,
            adaptive_sample_count=8,
            economy_experiment_block_id="block-a",
        )
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "state.json"
            memory.save(state_path)
            restored = TacticMemory.load(state_path)
        self.assertEqual(restored.economy_history, memory.economy_history)
        self.assertEqual(restored.worker_cycle_started, memory.worker_cycle_started)
        self.assertEqual(restored.cycle_durations, [5, 7])
        self.assertEqual(restored.bounds, memory.bounds)
        self.assertEqual(restored.adaptive_radius_delta, 4)
        self.assertEqual(restored.adaptive_worker_target, 7)
        self.assertEqual(restored.adaptive_action, "EXPAND_SEARCH")
        self.assertEqual(restored.economy_experiment_block_id, "block-a")

    def test_experiment_block_change_resets_learning_but_preserves_map(self) -> None:
        memory = TacticMemory(
            known_cells={(90, 90)},
            obstacle_cells={(91, 90)},
            visited_cells={(90, 90): 4},
            scout_targets={uid(1): (92, 90)},
            economy_history=[{"tick": 7, "workers": 17, "deposited": 2}],
            worker_cycle_started={uid(1): 3},
            cycle_durations=[50, 70],
            adaptive_radius_delta=-12,
            adaptive_scout_bonus=2,
            adaptive_worker_target=17,
            adaptive_worker_base_target=17,
            adaptive_last_adjust_tick=7,
            adaptive_action="CONSERVE",
            adaptive_reason="long_cycle",
            adaptive_throughput=0.2,
            adaptive_utilization=0.8,
            adaptive_failure_rate=0.1,
            adaptive_average_cycle_ticks=60.0,
            adaptive_storage_full_ratio=0.3,
            adaptive_new_cells_per_scout=1.5,
            adaptive_sample_count=24,
            adaptive_scarcity_streak=5,
            economy_experiment_block_id="block-a",
        )
        self.assertTrue(memory.sync_economy_experiment("block-b"))
        self.assertEqual(memory.economy_experiment_block_id, "block-b")
        self.assertEqual(memory.economy_history, [])
        self.assertEqual(memory.worker_cycle_started, {})
        self.assertEqual(memory.cycle_durations, [])
        self.assertEqual(memory.adaptive_radius_delta, 0)
        self.assertEqual(memory.adaptive_scout_bonus, 0)
        self.assertIsNone(memory.adaptive_worker_target)
        self.assertEqual(memory.adaptive_action, "WARMUP")
        self.assertEqual(memory.adaptive_sample_count, 0)
        self.assertEqual(memory.known_cells, {(90, 90)})
        self.assertEqual(memory.obstacle_cells, {(91, 90)})
        self.assertEqual(memory.visited_cells[(90, 90)], 4)
        self.assertEqual(memory.scout_targets, {uid(1): (92, 90)})

    def test_choose_actions_syncs_the_active_experiment_before_observing(self) -> None:
        worker = FakeUnit(1, (0, 0), UnitType.WORKER)
        memory = TacticMemory(
            last_tick=9,
            economy_history=[{"tick": 8, "workers": 17, "deposited": 3}],
            adaptive_radius_delta=-12,
            adaptive_scout_bonus=2,
            economy_experiment_block_id="block-a",
        )
        with patch(
            "arena_hero_tactic.tactic.engine.active_block_id", return_value="block-b"
        ):
            choose_actions(FakeTurn(tick=10, units=[worker]), memory)
        self.assertEqual(memory.economy_experiment_block_id, "block-b")
        self.assertEqual([sample["tick"] for sample in memory.economy_history], [10])
        self.assertEqual(memory.adaptive_radius_delta, 0)
        self.assertEqual(memory.adaptive_scout_bonus, 0)

if __name__ == "__main__":
    unittest.main()

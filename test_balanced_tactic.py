from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

from arena_hero import BeaconStatus, CoreState, Direction, UnitType

from balanced_tactic import (
    PHASE_EARLY,
    PHASE_LATE,
    PHASE_MID,
    POSTURE_ECONOMY,
    POSTURE_SURVIVAL,
    TacticMemory,
    _exploration_radius,
    _offense_ready,
    _normalize_api_key,
    _resource_radius,
    _strategy_phase,
    choose_actions,
)
from strategy_config import default_config_dict, strategy_config_from_dict


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
        hp: int = 2,
    ) -> None:
        self.id = uid(number)
        self.position = position
        self.unit_type = unit_type
        self.cargo = cargo
        self.hp = hp
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

    def pickup_beacon(self) -> None:
        self.action = ("PICKUP_BEACON",)


class FakeCore:
    def __init__(
        self,
        position: Position = (0, 0),
        *,
        shield: int = 5,
        state: CoreState = CoreState.NORMAL,
        owner_username: str = "test-player",
    ) -> None:
        self.id = uid(10_000)
        self.position = position
        self.hp = 5
        self.shield = shield
        self.owner_username = owner_username
        self.view = SimpleNamespace(state=state)
        self.action = None

    def spawn(self, unit_type: UnitType) -> None:
        self.action = ("SPAWN", unit_type)

    def repair_shield(self) -> None:
        self.action = ("REPAIR_SHIELD",)

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
        self.assertEqual(worker.action, ("MOVE", Direction.UP))

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
        memory = TacticMemory(first_tick=1, last_tick=1)
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
            combat_targets={uid(2): (8, 9)},
            combat_target_started={uid(2): 11},
            combat_sectors={uid(2): 6},
            visited_cells={(0, 0): 3},
            enemy_sightings={(9, 9): 12},
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
        self.assertEqual(restored.combat_targets, memory.combat_targets)
        self.assertEqual(
            restored.combat_target_started, memory.combat_target_started
        )
        self.assertEqual(restored.combat_sectors, memory.combat_sectors)
        self.assertEqual(restored.visited_cells[(0, 0)], 3)
        self.assertEqual(restored.enemy_sightings, memory.enemy_sightings)
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
        self.assertEqual(ranger.action, ("SHOOT", adjacent.id))

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
        choose_actions(FakeTurn(units=workers, resources=0), memory)
        self.assertEqual(len(memory.scout_targets), 1)
        scout_ids = set(memory.scout_targets)
        self.assertEqual(
            len({memory.worker_sectors[worker_id] for worker_id in scout_ids}),
            1,
        )

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
        memory = TacticMemory(first_tick=1, last_tick=80)
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

    def test_late_phase_requires_economy_before_offense(self) -> None:
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
            enemies=[enemy(101, (20, 1), UnitType.RANGER)],
        )
        choose_actions(turn, memory, config)
        self.assertEqual(_strategy_phase(turn, memory, config), PHASE_LATE)
        self.assertTrue(_offense_ready(turn, memory, config))
        self.assertEqual(units[7].action, ("MOVE", Direction.RIGHT))

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

    def test_vanguard_does_not_launch_early_offensive_chase(self) -> None:
        vanguard = FakeUnit(1, (5, 0), UnitType.VANGUARD, hp=4)
        target = enemy(101, (8, 0), UnitType.RANGER)
        memory = TacticMemory(first_tick=1, last_tick=9)
        choose_actions(
            FakeTurn(
                tick=10,
                units=[vanguard],
                enemies=[target],
                resources=0,
            ),
            memory,
        )
        self.assertEqual(memory.last_posture, POSTURE_ECONOMY)
        self.assertIn(vanguard.id, memory.combat_targets)
        self.assertNotEqual(vanguard.action, ("MOVE", Direction.RIGHT))

    def test_three_rangers_split_two_guards_and_one_outer_scout(self) -> None:
        first_guard = FakeUnit(1, (3, 0), UnitType.RANGER)
        second_guard = FakeUnit(2, (3, 3), UnitType.RANGER)
        outer = FakeUnit(3, (10, 0), UnitType.RANGER)
        memory = TacticMemory(first_tick=1, last_tick=99)
        choose_actions(
            FakeTurn(
                tick=100,
                units=[first_guard, second_guard, outer],
                resources=0,
            ),
            memory,
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

    def test_core_migrates_toward_materially_better_cover(self) -> None:
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
        self.assertEqual(core.action, ("START_MOVE", Direction.RIGHT))

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
        self.assertEqual(memory.resource_radius_limit, 12)
        self.assertEqual(memory.adaptive_scout_bonus, 1)

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
            adaptive_radius_delta=4,
            adaptive_scout_bonus=2,
            adaptive_worker_target=7,
            adaptive_worker_base_target=6,
            adaptive_last_adjust_tick=7,
            adaptive_action="EXPAND_SEARCH",
            adaptive_reason="resource_scarcity",
            adaptive_throughput=0.125,
            adaptive_sample_count=8,
        )
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "state.json"
            memory.save(state_path)
            restored = TacticMemory.load(state_path)
        self.assertEqual(restored.economy_history, memory.economy_history)
        self.assertEqual(restored.worker_cycle_started, memory.worker_cycle_started)
        self.assertEqual(restored.cycle_durations, [5, 7])
        self.assertEqual(restored.adaptive_radius_delta, 4)
        self.assertEqual(restored.adaptive_worker_target, 7)
        self.assertEqual(restored.adaptive_action, "EXPAND_SEARCH")

if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import unittest
from types import SimpleNamespace
from uuid import UUID

from arena_hero import BeaconStatus as SDKBeaconStatus
from arena_hero import CoreState as SDKCoreState
from arena_hero import Direction as SDKDirection
from arena_hero import UnitType as SDKUnitType

from arena_hero_tactic.adapters.sdk_input import sdk_turn_to_canonical
from arena_hero_tactic.adapters.sdk_output import apply_command_plan
from arena_hero_tactic.strategy_core.model import (
    CommandPlan,
    Direction,
    PlannerOptions,
    RecordedAction,
    UnitType,
)


def uid(number: int) -> UUID:
    return UUID(int=number)


class RecordingUnit:
    def __init__(
        self,
        identifier: UUID,
        unit_type: SDKUnitType = SDKUnitType.WORKER,
        position: tuple[int, int] = (1, 0),
    ) -> None:
        self.id = identifier
        self.unit_type = unit_type
        self.position = position
        self.hp = 2
        self.max_hp = 2
        self.cargo = 0
        self.calls: list[tuple[object, ...]] = []

    def move(self, direction: SDKDirection) -> None:
        self.calls.append(("MOVE", direction))

    def harvest(self) -> None:
        self.calls.append(("HARVEST",))

    def deposit(self) -> None:
        self.calls.append(("DEPOSIT",))

    def sweep(self, direction: SDKDirection) -> None:
        self.calls.append(("SWEEP", direction))

    def shoot(self, target_id: UUID, *, expected_cell: tuple[int, int]) -> None:
        self.calls.append(("SHOOT", target_id, expected_cell))

    def shoot_cell(self, expected_cell: tuple[int, int]) -> None:
        self.calls.append(("SHOOT_CELL", expected_cell))

    def heal(self) -> None:
        self.calls.append(("HEAL",))

    def pickup_beacon(self) -> None:
        self.calls.append(("PICKUP_BEACON",))

    def drop_beacon(self) -> None:
        self.calls.append(("DROP_BEACON",))

    def self_destruct(self) -> None:
        self.calls.append(("SELF_DESTRUCT",))


class RecordingCore:
    def __init__(self) -> None:
        self.id = uid(1)
        self.position = (0, 0)
        self.hp = 5
        self.shield = 4
        self.owner_username = "player"
        self.view = SimpleNamespace(
            state=SDKCoreState.NORMAL,
            move_direction=None,
            move_progress=None,
            move_required_ticks=None,
            destination=None,
        )
        self.calls: list[tuple[object, ...]] = []

    def spawn(self, unit_type: SDKUnitType) -> None:
        self.calls.append(("SPAWN", unit_type))

    def repair_shield(self) -> None:
        self.calls.append(("REPAIR_SHIELD",))

    def heal(self) -> None:
        self.calls.append(("HEAL",))

    def start_move(self, direction: SDKDirection) -> None:
        self.calls.append(("START_MOVE", direction))

    def cancel_move(self) -> None:
        self.calls.append(("CANCEL_MOVE",))

    def pickup_beacon(self) -> None:
        self.calls.append(("PICKUP_BEACON",))

    def drop_beacon(self) -> None:
        self.calls.append(("DROP_BEACON",))

    def self_destruct(self) -> None:
        self.calls.append(("SELF_DESTRUCT",))


class StrategyAdapterTests(unittest.TestCase):
    def test_sdk_input_builds_the_authoritative_canonical_state(self) -> None:
        core = RecordingCore()
        core.view = SimpleNamespace(
            state=SDKCoreState.MOVING,
            move_direction=SDKDirection.RIGHT,
            move_progress=2,
            move_required_ticks=5,
            destination=(3, 0),
        )
        worker = RecordingUnit(uid(2), SDKUnitType.WORKER, (1, 0))
        worker.cargo = 3
        enemy = SimpleNamespace(
            id=uid(3),
            kind="UNIT",
            position=(4, 0),
            hp=4,
            shield=0,
            unit_type=SDKUnitType.VANGUARD,
        )
        event = SimpleNamespace(
            event_type="HARVEST",
            tick=7,
            reason_code=None,
            position=(2, 0),
            actor_id=worker.id,
            target_id=None,
            resource_amount=2,
            harvest_source="RESOURCE_NODE",
            values={"remaining": 3},
        )
        turn = SimpleNamespace(
            tick=7,
            core=core,
            units=(worker,),
            resources=9,
            resource_space=41,
            resource_cells={(2, 0)},
            obstacle_cells={(0, 1)},
            visible_enemies=(enemy,),
            events=(event,),
            beacon=SimpleNamespace(
                position=(20, 20),
                status=SDKBeaconStatus.GROUND,
                carrier_id=None,
            ),
            state=SimpleNamespace(population=8),
            width=40,
            height=30,
        )

        canonical = sdk_turn_to_canonical(
            turn,
            PlannerOptions(
                profile="economy",
                safety_enabled=True,
                core_migration_enabled=True,
            ),
        )

        self.assertEqual(canonical.tick, 7)
        self.assertEqual(canonical.core.position, (0, 0))
        self.assertEqual(canonical.core.move_direction, Direction.RIGHT)
        self.assertEqual(canonical.units[0].cargo, 3)
        self.assertEqual(canonical.visible_enemies[0].unit_type, UnitType.VANGUARD)
        self.assertEqual(canonical.events[0].resource_amount, 2)
        self.assertEqual(canonical.beacon.status.value, "GROUND")
        self.assertEqual(canonical.population, 8)
        self.assertEqual(canonical.width, 40)
        self.assertEqual(canonical.height, 30)
        self.assertEqual(set(canonical.unit_costs), set(UnitType))

    def test_sdk_output_applies_every_unit_action(self) -> None:
        actions = (
            RecordedAction("WAIT"),
            RecordedAction("MOVE", direction=Direction.UP),
            RecordedAction("HARVEST"),
            RecordedAction("DEPOSIT"),
            RecordedAction("SWEEP", direction=Direction.LEFT),
            RecordedAction("SHOOT", target_id=uid(100), expected_cell=(4, 4)),
            RecordedAction("SHOOT", expected_cell=(5, 5)),
            RecordedAction("HEAL"),
            RecordedAction("PICKUP_BEACON"),
            RecordedAction("DROP_BEACON"),
            RecordedAction("SELF_DESTRUCT"),
        )
        units = tuple(RecordingUnit(uid(index + 10)) for index in range(len(actions)))
        plan = CommandPlan(
            tick=9,
            unit_actions={unit.id: action for unit, action in zip(units, actions)},
        )

        apply_command_plan(SimpleNamespace(tick=9, units=units, core=None), plan)

        self.assertEqual(units[0].calls, [])
        self.assertEqual(units[1].calls, [("MOVE", SDKDirection.UP)])
        self.assertEqual(units[2].calls, [("HARVEST",)])
        self.assertEqual(units[3].calls, [("DEPOSIT",)])
        self.assertEqual(units[4].calls, [("SWEEP", SDKDirection.LEFT)])
        self.assertEqual(units[5].calls, [("SHOOT", uid(100), (4, 4))])
        self.assertEqual(units[6].calls, [("SHOOT_CELL", (5, 5))])
        self.assertEqual(units[7].calls, [("HEAL",)])
        self.assertEqual(units[8].calls, [("PICKUP_BEACON",)])
        self.assertEqual(units[9].calls, [("DROP_BEACON",)])
        self.assertEqual(units[10].calls, [("SELF_DESTRUCT",)])

    def test_sdk_output_applies_every_core_action(self) -> None:
        cases = (
            (RecordedAction("WAIT"), []),
            (
                RecordedAction("SPAWN", unit_type=UnitType.RANGER),
                [("SPAWN", SDKUnitType.RANGER)],
            ),
            (RecordedAction("REPAIR_SHIELD"), [("REPAIR_SHIELD",)]),
            (RecordedAction("HEAL"), [("HEAL",)]),
            (
                RecordedAction("START_MOVE", direction=Direction.DOWN),
                [("START_MOVE", SDKDirection.DOWN)],
            ),
            (RecordedAction("CANCEL_MOVE"), [("CANCEL_MOVE",)]),
            (RecordedAction("PICKUP_BEACON"), [("PICKUP_BEACON",)]),
            (RecordedAction("DROP_BEACON"), [("DROP_BEACON",)]),
            (RecordedAction("SELF_DESTRUCT"), [("SELF_DESTRUCT",)]),
        )

        for action, expected in cases:
            with self.subTest(action=action.type):
                core = RecordingCore()
                apply_command_plan(
                    SimpleNamespace(tick=11, units=(), core=core),
                    CommandPlan(tick=11, unit_actions={}, core_action=action),
                )
                self.assertEqual(core.calls, expected)

    def test_sdk_output_rejects_mismatched_ticks_and_unknown_units(self) -> None:
        turn = SimpleNamespace(tick=3, units=(), core=None)
        with self.assertRaisesRegex(ValueError, "plan tick"):
            apply_command_plan(turn, CommandPlan(tick=4, unit_actions={}))
        with self.assertRaisesRegex(ValueError, "unknown unit"):
            apply_command_plan(
                turn,
                CommandPlan(
                    tick=3,
                    unit_actions={uid(99): RecordedAction("WAIT")},
                ),
            )


if __name__ == "__main__":
    unittest.main()

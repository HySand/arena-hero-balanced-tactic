from __future__ import annotations

import unittest
from types import SimpleNamespace

from arena_hero import UnitType, unit_cost

from arena_hero_tactic.tactic.engine import _unit_cost
from arena_hero_tactic.training.dataset import RULES_VERSION


class V014ContractTests(unittest.TestCase):
    def test_dynamic_unit_cost_uses_authoritative_sdk_helper(self) -> None:
        turn = SimpleNamespace(
            state=SimpleNamespace(population=20),
            units=(),
        )
        self.assertEqual(_unit_cost(turn, UnitType.WORKER), unit_cost(UnitType.WORKER, 20))
        self.assertGreater(_unit_cost(turn, UnitType.WORKER), 5)

    def test_training_records_current_gameplay_contract(self) -> None:
        self.assertEqual(RULES_VERSION, "v0.14")


if __name__ == "__main__":
    unittest.main()

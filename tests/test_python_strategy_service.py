from __future__ import annotations

from copy import deepcopy
import json
import unittest
from pathlib import Path

from arena_hero_tactic.strategy_core.serialization import (
    InvalidJsonError,
    canonical_json,
    decode_tick_request,
    decode_tick_request_json,
    encode_tick_response,
)
from arena_hero_tactic.strategy_core.service import classify_ordering, execute_tick


FIXTURE_PATH = (
    Path(__file__).resolve().parents[1]
    / "fixtures"
    / "python_strategy_tick_1.json"
)


class PythonStrategyServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    def test_ordering_classifies_new_replay_stale_and_conflict(self) -> None:
        self.assertEqual(classify_ordering(None, None, 1, "digest-a"), "new")
        self.assertEqual(classify_ordering(4, "digest-a", 4, "digest-a"), "replay")
        self.assertEqual(classify_ordering(4, "digest-a", 3, "digest-b"), "stale")
        self.assertEqual(classify_ordering(4, "digest-a", 4, "digest-b"), "conflict")

    def test_shared_fixture_matches_request_plan_memory_and_summary(self) -> None:
        request = decode_tick_request(self.fixture["request"])
        result = execute_tick(request)
        response = json.loads(
            canonical_json(encode_tick_response(request, result, 0.0))
        )

        self.assertEqual(request.agent_id, "arena-hero-primary")
        self.assertEqual(request.tick, 1)
        self.assertEqual(response["plan"], self.fixture["expected"]["plan"])
        self.assertEqual(response["memory"], self.fixture["expected"]["memory"])
        self.assertEqual(response["summary"], self.fixture["expected"]["summary"])

    def test_cold_start_memory_advances_only_after_planning(self) -> None:
        request = decode_tick_request(self.fixture["request"])
        self.assertEqual(dict(request.memory), {"version": 12})
        self.assertEqual(request.state.resource_space, 5)
        self.assertEqual(
            {unit_type.value: cost for unit_type, cost in request.state.unit_costs.items()},
            {"WORKER": 5, "VANGUARD": 10, "RANGER": 12},
        )

        result = execute_tick(request)

        self.assertEqual(result.memory["version"], 12)
        self.assertEqual(result.memory["first_tick"], 1)
        self.assertEqual(result.memory["last_tick"], 1)

    def test_python_derives_dynamic_costs_from_forwarded_arena_state(self) -> None:
        payload = deepcopy(self.fixture["request"])
        payload["state"]["population"] = 20
        payload["state"]["resources"] = 7

        request = decode_tick_request(payload)

        self.assertEqual(request.state.resource_space, 93)
        self.assertEqual(
            {unit_type.value: cost for unit_type, cost in request.state.unit_costs.items()},
            {"WORKER": 7, "VANGUARD": 13, "RANGER": 16},
        )

    def test_respawn_round_trip_resets_persisted_world_memory(self) -> None:
        respawning_payload = deepcopy(self.fixture["request"])
        respawning_payload["tick"] = 2
        respawning_payload["state"]["status"] = "RESPAWNING"
        respawning_payload["state"]["respawn_at_tick"] = 3
        respawning_payload["state"]["objects"] = []
        respawning_payload["memory"] = deepcopy(self.fixture["expected"]["memory"])
        respawning_payload["memory"].update(
            {
                "resource_hints": [[99, 99]],
                "obstacle_cells": [[98, 98]],
                "known_cells": [[97, 97]],
                "last_tick": 1,
            }
        )

        respawning = execute_tick(decode_tick_request(respawning_payload))

        self.assertTrue(respawning.memory["respawn_reset_pending"])
        self.assertEqual(respawning.summary["strategy_phase"], "RESPAWNING")
        self.assertEqual(respawning.plan.tick, 2)
        self.assertIsNone(respawning.plan.core_action)

        resumed_payload = deepcopy(self.fixture["request"])
        resumed_payload["tick"] = 3
        resumed_payload["memory"] = dict(respawning.memory)
        resumed = execute_tick(decode_tick_request(resumed_payload))

        self.assertFalse(resumed.memory["respawn_reset_pending"])
        self.assertEqual(resumed.memory["first_tick"], 3)
        self.assertEqual(resumed.memory["last_tick"], 3)
        self.assertNotIn([99, 99], resumed.memory["resource_hints"])
        self.assertNotIn([98, 98], resumed.memory["obstacle_cells"])
        self.assertNotIn([97, 97], resumed.memory["known_cells"])

    def test_invalid_json_has_a_dedicated_error_class(self) -> None:
        with self.assertRaisesRegex(
            InvalidJsonError,
            "request body must contain valid JSON",
        ):
            decode_tick_request_json("{not-json")


if __name__ == "__main__":
    unittest.main()

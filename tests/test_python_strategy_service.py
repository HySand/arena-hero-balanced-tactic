from __future__ import annotations

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

        result = execute_tick(request)

        self.assertEqual(result.memory["version"], 12)
        self.assertEqual(result.memory["first_tick"], 1)
        self.assertEqual(result.memory["last_tick"], 1)

    def test_invalid_json_has_a_dedicated_error_class(self) -> None:
        with self.assertRaisesRegex(
            InvalidJsonError,
            "request body must contain valid JSON",
        ):
            decode_tick_request_json("{not-json")


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from arena_hero_tactic.training.peace_economy import load_training_data


class TrainingInputTests(unittest.TestCase):
    def test_telemetry_can_be_reloaded_and_filtered(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "telemetry.jsonl"
            rows = [
                {
                    "version": 1,
                    "tick": tick,
                    "candidate_id": "radius-96" if tick < 3 else "radius-64",
                    "measurement_eligible": tick % 2 == 0,
                    "sample": {
                        "tick": tick,
                        "workers": 17,
                        "scouts": tick,
                    },
                }
                for tick in range(1, 5)
            ]
            path.write_text(
                "".join(json.dumps(row) + "\n" for row in rows),
                encoding="utf-8",
            )

            samples, cycles = load_training_data(
                telemetry_path=path,
                candidate_id="radius-96",
                measurements_only=True,
            )

        self.assertEqual([sample["tick"] for sample in samples], [2])
        self.assertEqual(cycles, [])

    def test_legacy_state_remains_supported(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "state.json"
            path.write_text(
                json.dumps(
                    {
                        "economy_history": [{"tick": 10, "workers": 17}],
                        "cycle_durations": [8, 12],
                    }
                ),
                encoding="utf-8",
            )

            samples, cycles = load_training_data(state_path=path)

        self.assertEqual(samples, [{"tick": 10, "workers": 17}])
        self.assertEqual(cycles, [8, 12])


if __name__ == "__main__":
    unittest.main()
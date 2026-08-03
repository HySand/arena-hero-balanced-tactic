from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from peace_economy_experiment import (
    _candidate_results,
    _record_metrics,
    _select_best,
    active_block_id,
    append_telemetry,
    load_records,
    load_state,
    restart_current_block,
    start_experiment,
)
from strategy_config import default_config_dict, load_strategy_config, save_strategy_config


class PeaceEconomyExperimentTests(unittest.TestCase):
    def _plan(self, path: Path) -> None:
        path.write_text(
            json.dumps(
                {
                    "experiment_plan": {
                        "id": "test-plan",
                        "warmup_samples": 1,
                        "measurement_samples": 2,
                        "minimum_outcomes": 0,
                        "max_measurement_samples": 2,
                        "schedule": ["scouts-12", "scouts-8"],
                        "candidates": [
                            {
                                "id": "scouts-12",
                                "overrides": {"workers": {"max_economy_scouts": 12}},
                            },
                            {
                                "id": "scouts-8",
                                "overrides": {"workers": {"max_economy_scouts": 8}},
                            },
                        ],
                    }
                }
            ),
            encoding="utf-8",
        )

    @staticmethod
    def _sample(tick: int) -> dict[str, int]:
        return {
            "tick": tick,
            "workers": 17,
            "deposited": 1,
            "harvested": 1,
            "harvest_successes": 1,
            "harvest_failures": 0,
            "deposit_successes": 1,
            "deposit_full": 0,
            "candidates": 2,
            "assignments": 2,
            "scouts": 12,
            "busy": 14,
            "storage_full": 0,
            "new_cells": 3,
        }

    def test_archive_is_anonymous_and_keeps_parameter_signature(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "telemetry.jsonl"
            state = root / "state.json"
            config_path = root / "config.json"
            config = save_strategy_config(default_config_dict(), config_path)
            append_telemetry(
                self._sample(10),
                config,
                composition={"workers": 17, "vanguards": 1, "rangers": 1},
                posture="ECONOMY",
                threat_score=0.0,
                worker_losses=0,
                path=archive,
                state_path=state,
            )
            records = load_records(archive)
            self.assertEqual(len(records), 1)
            self.assertEqual(len(records[0]["parameter_id"]), 12)
            text = archive.read_text(encoding="utf-8")
            self.assertNotIn("owner", text.lower())
            self.assertNotIn("api_key", text.lower())

    def test_low_utilization_candidate_cannot_gain_confidence(self) -> None:
        records = []
        for tick in range(720):
            sample = self._sample(tick)
            sample["busy"] = 2
            records.append({**sample, "block_id": f"block-{tick // 240}"})
        metrics = _record_metrics(records)
        self.assertFalse(metrics["viable"])
        self.assertEqual(metrics["confidence"], "low")

    def test_candidate_selection_prioritizes_delivery_throughput(self) -> None:
        selected = _select_best(
            [
                {
                    "candidate_id": "more-discovery",
                    "confidence": "medium",
                    "viable": True,
                    "throughput_per_worker": 0.02,
                    "harvest_per_worker": 0.03,
                    "utilization": 0.95,
                    "score": 10.0,
                    "sample_count": 500,
                },
                {
                    "candidate_id": "more-delivery",
                    "confidence": "medium",
                    "viable": True,
                    "throughput_per_worker": 0.03,
                    "harvest_per_worker": 0.025,
                    "utilization": 0.8,
                    "score": 8.0,
                    "sample_count": 500,
                },
            ]
        )
        self.assertEqual(selected, "more-delivery")

    def test_candidate_results_are_scoped_to_the_current_experiment(self) -> None:
        records = []
        for experiment_id in ("old-plan", "new-plan"):
            for tick in range(2):
                records.append(
                    {
                        **self._sample(tick),
                        "experiment_id": experiment_id,
                        "candidate_id": "radius-96",
                        "block_id": f"{experiment_id}-block",
                        "measurement_eligible": True,
                    }
                )

        results = _candidate_results(records, experiment_id="new-plan")

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["sample_count"], 2)

    def test_state_loader_and_active_block_read_persisted_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "state.json"
            state_path.write_text(
                json.dumps({"enabled": True, "block_id": "block-7"}),
                encoding="utf-8",
            )
            self.assertEqual(load_state(state_path)["block_id"], "block-7")
            self.assertEqual(active_block_id(state_path), "block-7")

    def test_restart_uses_a_fresh_block_without_deleting_progress(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "enabled": True,
                        "experiment_id": "test-plan",
                        "schedule_index": 0,
                        "block_id": "test-plan-0001",
                        "block_ticks": 99,
                        "measurement_samples_collected": 80,
                        "block_outcomes": 12,
                        "last_record_key": "old-record",
                    }
                ),
                encoding="utf-8",
            )
            state = restart_current_block(state_path=state_path)
            self.assertEqual(state["block_id"], "test-plan-0001-r2")
            self.assertEqual(state["block_ticks"], 0)
            self.assertEqual(state["measurement_samples_collected"], 0)
            self.assertEqual(state["block_outcomes"], 0)
            self.assertNotIn("last_record_key", state)
            self.assertEqual(active_block_id(state_path), state["block_id"])

    def test_experiment_rotates_candidates_and_restores_original(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = root / "plan.json"
            state_path = root / "state.json"
            archive = root / "telemetry.jsonl"
            config_path = root / "config.json"
            self._plan(plan)
            original = default_config_dict()
            save_strategy_config(original, config_path)
            state = start_experiment(
                plan_path=plan,
                state_path=state_path,
                config_path=config_path,
                archive_path=archive,
            )
            self.assertEqual(state["candidate_id"], "scouts-12")
            self.assertEqual(
                load_strategy_config(config_path, strict=True).workers.max_economy_scouts,
                12,
            )

            for tick in range(1, 4):
                config = load_strategy_config(config_path, strict=True)
                append_telemetry(
                    self._sample(tick),
                    config,
                    composition={"workers": 17, "vanguards": 1, "rangers": 1},
                    posture="ECONOMY",
                    threat_score=0.0,
                    worker_losses=0,
                    path=archive,
                    state_path=state_path,
                )
            state = load_state(state_path)
            self.assertEqual(state["candidate_id"], "scouts-8")
            self.assertEqual(
                load_strategy_config(config_path, strict=True).workers.max_economy_scouts,
                8,
            )

            for tick in range(4, 7):
                config = load_strategy_config(config_path, strict=True)
                append_telemetry(
                    self._sample(tick),
                    config,
                    composition={"workers": 17, "vanguards": 1, "rangers": 1},
                    posture="ECONOMY",
                    threat_score=0.0,
                    worker_losses=0,
                    path=archive,
                    state_path=state_path,
                )
            state = load_state(state_path)
            self.assertFalse(state["enabled"])
            restored = load_strategy_config(config_path, strict=True).to_dict()
            self.assertEqual(restored, original)
            self.assertEqual(len(state["completed_blocks"]), 2)


if __name__ == "__main__":
    unittest.main()

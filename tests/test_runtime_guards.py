from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from arena_hero_tactic.training.experiment import (
    append_telemetry,
    ensure_active_experiment_config,
    load_state,
    start_experiment,
)
from arena_hero_tactic.runtime.process_lock import InstanceAlreadyRunning, SingleInstanceLock
from arena_hero_tactic.configuration.strategy import default_config_dict, load_strategy_config, save_strategy_config


class RuntimeGuardTests(unittest.TestCase):
    def _plan(self, path: Path, *, max_readiness_samples: int = 720) -> None:
        path.write_text(
            json.dumps(
                {
                    "experiment_plan": {
                        "id": "guard-plan",
                        "warmup_samples": 1,
                        "measurement_samples": 2,
                        "minimum_outcomes": 0,
                        "max_measurement_samples": 2,
                        "max_readiness_samples": max_readiness_samples,
                        "schedule": ["radius-64"],
                        "candidates": [
                            {
                                "id": "radius-64",
                                "overrides": {
                                    "adaptive_economy": {"max_resource_radius": 64}
                                },
                            }
                        ],
                    }
                }
            ),
            encoding="utf-8",
        )

    def test_single_instance_lock_rejects_second_owner(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.lock"
            with SingleInstanceLock(path):
                with self.assertRaises(InstanceAlreadyRunning):
                    SingleInstanceLock(path).acquire()
            self.assertFalse(path.exists())

    def test_active_experiment_reconciles_configuration_drift(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = root / "plan.json"
            state = root / "state.json"
            config_path = root / "config.json"
            self._plan(plan)
            original = default_config_dict()
            save_strategy_config(original, config_path)
            start_experiment(
                plan_path=plan,
                state_path=state,
                config_path=config_path,
                archive_path=root / "telemetry.jsonl",
            )
            save_strategy_config(original, config_path)

            result = ensure_active_experiment_config(
                plan_path=plan,
                state_path=state,
                config_path=config_path,
            )

            config = load_strategy_config(config_path, strict=True)
            self.assertTrue(result["corrected"])
            self.assertTrue(config.production.enabled)
            self.assertEqual(config.production.order[0].target, 17)
            self.assertEqual(config.adaptive_economy.max_resource_radius, 64)

    def test_readiness_limit_pauses_experiment_and_restores_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = root / "plan.json"
            state = root / "state.json"
            archive = root / "telemetry.jsonl"
            config_path = root / "config.json"
            self._plan(plan, max_readiness_samples=1)
            original = default_config_dict()
            save_strategy_config(original, config_path)
            start_experiment(
                plan_path=plan,
                state_path=state,
                config_path=config_path,
                archive_path=archive,
            )
            config = load_strategy_config(config_path, strict=True)
            append_telemetry(
                {
                    "tick": 1,
                    "workers": 1,
                    "deposited": 0,
                    "harvested": 0,
                    "harvest_successes": 0,
                    "harvest_failures": 0,
                    "deposit_successes": 0,
                    "deposit_full": 0,
                    "candidates": 0,
                    "assignments": 0,
                    "scouts": 1,
                    "busy": 1,
                    "storage_full": 0,
                    "new_cells": 0,
                },
                config,
                composition={"workers": 1, "vanguards": 0, "rangers": 0},
                posture="SURVIVAL",
                threat_score=4.0,
                worker_losses=0,
                path=archive,
                state_path=state,
            )

            current = load_state(state)
            restored = load_strategy_config(config_path, strict=True)
            self.assertFalse(current["enabled"])
            self.assertTrue(current["paused"])
            self.assertEqual(current["pause_reason"], "stable_composition_unavailable")
            self.assertTrue(restored.production.enabled)
            self.assertEqual(restored.production.order[0].target, 6)


if __name__ == "__main__":
    unittest.main()

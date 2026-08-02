from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from dashboard_state import build_dashboard_state
from strategy_config import (
    StrategyConfigError,
    default_config_dict,
    load_strategy_config,
    save_strategy_config,
    strategy_config_from_dict,
)
from tactic_dashboard import create_server
from test_balanced_tactic import FakeTurn
from balanced_tactic import TacticMemory


class StrategyConfigTests(unittest.TestCase):
    def test_defaults_are_valid_and_include_every_unit_type(self) -> None:
        config = strategy_config_from_dict(default_config_dict())
        self.assertEqual(
            [item.unit_type for item in config.production.order],
            ["WORKER", "VANGUARD", "RANGER"],
        )
        self.assertEqual(config.vanguards.early_scout_radius, 80)
        self.assertEqual(
            (config.rangers.guard_numerator, config.rangers.guard_denominator),
            (2, 3),
        )
        self.assertEqual(
            (
                config.pacing.early_resource_radius,
                config.pacing.mid_resource_radius,
                config.pacing.late_resource_radius,
            ),
            (10, 22, 40),
        )
        self.assertEqual(
            (
                config.pacing.early_worker_scouts,
                config.pacing.mid_worker_scouts,
                config.pacing.late_worker_scouts,
            ),
            (1, 3, 6),
        )
        self.assertTrue(config.adaptive_economy.enabled)
        self.assertEqual(config.adaptive_economy.window_ticks, 12)
        self.assertEqual(
            (
                config.adaptive_economy.min_resource_radius,
                config.adaptive_economy.max_resource_radius,
                config.adaptive_economy.worker_target_min,
                config.adaptive_economy.worker_target_max,
            ),
            (6, 44, 4, 8),
        )

    def test_invalid_order_and_thresholds_are_rejected(self) -> None:
        duplicate = default_config_dict()
        duplicate["production"]["order"][1]["unit_type"] = "WORKER"
        with self.assertRaises(StrategyConfigError):
            strategy_config_from_dict(duplicate)

        thresholds = default_config_dict()
        thresholds["threat"]["guarded_score"] = 5
        thresholds["threat"]["survival_score"] = 4
        with self.assertRaises(StrategyConfigError):
            strategy_config_from_dict(thresholds)

        pacing = default_config_dict()
        pacing["pacing"]["mid_worker_scouts"] = 0
        with self.assertRaises(StrategyConfigError):
            strategy_config_from_dict(pacing)

        adaptive_radius = default_config_dict()
        adaptive_radius["adaptive_economy"]["min_resource_radius"] = 50
        with self.assertRaises(StrategyConfigError):
            strategy_config_from_dict(adaptive_radius)

        adaptive_throughput = default_config_dict()
        adaptive_throughput["adaptive_economy"][
            "low_throughput_per_worker"
        ] = 0.06
        with self.assertRaises(StrategyConfigError):
            strategy_config_from_dict(adaptive_throughput)

    def test_atomic_save_and_hot_reload_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "strategy.json"
            document = default_config_dict()
            document["production"]["order"] = [
                {"unit_type": "VANGUARD", "target": 2},
                {"unit_type": "WORKER", "target": 5},
                {"unit_type": "RANGER", "target": 3},
            ]
            document["extensions"] = {"future_feature": {"enabled": True}}
            saved = save_strategy_config(document, path)
            restored = load_strategy_config(path, strict=True)
            self.assertEqual(saved, restored)
            self.assertEqual(restored.production.order[0].unit_type, "VANGUARD")
            self.assertTrue(restored.extensions["future_feature"]["enabled"])
            self.assertFalse(path.with_suffix(".json.tmp").exists())

    def test_invalid_manual_file_falls_back_for_unattended_tactic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "strategy.json"
            path.write_text("{not-json", encoding="utf-8")
            fallback = load_strategy_config(path)
            self.assertEqual(fallback.production.order[0].unit_type, "WORKER")
            with self.assertRaises(StrategyConfigError):
                load_strategy_config(path, strict=True)

    def test_dashboard_snapshot_contains_status_but_no_credentials(self) -> None:
        document = build_dashboard_state(
            FakeTurn(),
            TacticMemory(),
            strategy_config_from_dict(default_config_dict()),
            profile="economy",
            accepted=True,
        )
        encoded = json.dumps(document)
        self.assertEqual(document["counts"]["WORKER"], 0)
        self.assertIn("production_order", document)
        self.assertTrue(document["adaptive_economy"]["enabled"])
        self.assertNotIn("api_key", encoded.lower())


class DashboardAPITests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.config_path = root / "strategy.json"
        self.status_path = root / "status.json"
        self.static_dir = root / "static"
        self.static_dir.mkdir()
        for name in ("index.html", "app.js", "styles.css"):
            (self.static_dir / name).write_text(name, encoding="utf-8")
        save_strategy_config(default_config_dict(), self.config_path)
        self.server = create_server(
            "127.0.0.1",
            0,
            config_path=self.config_path,
            status_path=self.status_path,
            static_dir=self.static_dir,
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def get_json(self, path: str) -> dict:
        with urllib.request.urlopen(self.base_url + path, timeout=2) as response:
            return json.load(response)

    def put_json(self, path: str, document: dict) -> tuple[int, dict]:
        request = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(document).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="PUT",
        )
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            try:
                return error.code, json.load(error)
            finally:
                error.close()

    def test_config_get_put_and_validation(self) -> None:
        config = self.get_json("/api/config")
        config["production"]["order"] = [
            {"unit_type": "RANGER", "target": 2},
            {"unit_type": "WORKER", "target": 6},
            {"unit_type": "VANGUARD", "target": 2},
        ]
        status, response = self.put_json("/api/config", config)
        self.assertEqual(status, 200)
        self.assertTrue(response["ok"])
        self.assertEqual(
            load_strategy_config(self.config_path, strict=True).production.order[0].unit_type,
            "RANGER",
        )

        config["threat"]["guarded_score"] = 9
        config["threat"]["survival_score"] = 4
        status, response = self.put_json("/api/config", config)
        self.assertEqual(status, 422)
        self.assertFalse(response["ok"])

    def test_status_endpoint_marks_recent_snapshot_online(self) -> None:
        self.status_path.write_text(
            json.dumps({"updated_at": time.time(), "tick": 42}),
            encoding="utf-8",
        )
        status = self.get_json("/api/status")
        self.assertTrue(status["online"])
        self.assertFalse(status["stale"])
        self.assertEqual(status["tick"], 42)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import importlib
import json
import unittest
from pathlib import Path

from arena_hero_tactic.configuration.strategy import strategy_config_from_dict
from arena_hero_tactic.runtime.paths import (
    DATA_DIR,
    DEFAULT_CONFIG_FILE,
    MODEL_DIR,
    PROJECT_ROOT,
    RUNTIME_DIR,
    TRAINING_DIR,
)


class ProjectLayoutTests(unittest.TestCase):
    def test_central_paths_resolve_from_the_repository_root(self) -> None:
        expected_root = Path(__file__).resolve().parents[1]
        self.assertEqual(PROJECT_ROOT, expected_root)
        self.assertEqual(DATA_DIR, expected_root / "data")
        self.assertEqual(RUNTIME_DIR, DATA_DIR / "runtime")
        self.assertEqual(TRAINING_DIR, DATA_DIR / "training")
        self.assertEqual(MODEL_DIR, DATA_DIR / "models")

    def test_public_default_config_is_valid(self) -> None:
        document = json.loads(DEFAULT_CONFIG_FILE.read_text(encoding="utf-8"))
        config = strategy_config_from_dict(document)
        self.assertEqual(config.to_dict(), document)

    def test_root_entrypoint_aliases_the_canonical_module(self) -> None:
        canonical = importlib.import_module("arena_hero_tactic.tactic.engine")
        root_legacy = importlib.import_module("balanced_tactic")
        self.assertIs(root_legacy, canonical)

    def test_python_worker_uses_runtime_sdk_compatibility_mode(self) -> None:
        worker_config = json.loads(
            (PROJECT_ROOT / "python-worker" / "wrangler.jsonc").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(
            worker_config["compatibility_flags"],
            ["python_workers", "disable_python_external_sdk"],
        )


if __name__ == "__main__":
    unittest.main()

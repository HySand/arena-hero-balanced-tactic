from __future__ import annotations

import os
import runpy
import unittest
from pathlib import Path
from unittest.mock import Mock, call, patch


ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = runpy.run_path(str(ROOT / "launcher.pyw"))


class LauncherSecurityTests(unittest.TestCase):
    def test_dashboard_environment_drops_inherited_api_key(self) -> None:
        build_environment = LAUNCHER["_background_environment"]
        inherited = "inherited-placeholder"
        explicit = "explicit-placeholder"

        with patch.dict(os.environ, {"ARENA_HERO_API_KEY": inherited}):
            dashboard_environment = build_environment()
            tactic_environment = build_environment(explicit)

        self.assertNotIn("ARENA_HERO_API_KEY", dashboard_environment)
        self.assertEqual(tactic_environment["ARENA_HERO_API_KEY"], explicit)

    def test_service_launcher_only_passes_key_to_tactic(self) -> None:
        ensure_services = LAUNCHER["_ensure_services"]
        start_background = Mock()
        credential = "test-placeholder"

        with patch.dict(
            ensure_services.__globals__,
            {
                "_dashboard_online": Mock(side_effect=[False, True]),
                "_lock_active": Mock(return_value=False),
                "_start_background": start_background,
            },
        ):
            self.assertTrue(ensure_services(credential))

        self.assertEqual(
            start_background.call_args_list,
            [
                call(
                    "arena_hero_tactic.dashboard.server",
                    "dashboard.log",
                    "dashboard.error.log",
                ),
                call(
                    "arena_hero_tactic.tactic.engine",
                    "tactic.log",
                    "tactic.error.log",
                    api_key=credential,
                ),
            ],
        )


if __name__ == "__main__":
    unittest.main()

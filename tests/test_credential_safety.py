from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from arena_hero_tactic.tactic import engine


class CredentialSafetyTests(unittest.TestCase):
    def test_dotenv_change_is_detected_without_exposing_credentials(self) -> None:
        active_key = "active-placeholder"
        expected_username = "expected-player"

        with patch.object(
            engine,
            "_dotenv_values",
            return_value={
                "ARENA_HERO_API_KEY": active_key,
                "ARENA_HERO_EXPECTED_USERNAME": expected_username,
            },
        ):
            self.assertTrue(
                engine._watch_dotenv_credentials(active_key, expected_username)
            )
            self.assertFalse(
                engine._dotenv_credentials_changed(active_key, expected_username)
            )

        with patch.object(
            engine,
            "_dotenv_values",
            return_value={
                "ARENA_HERO_API_KEY": "replacement-placeholder",
                "ARENA_HERO_EXPECTED_USERNAME": expected_username,
            },
        ):
            self.assertTrue(
                engine._dotenv_credentials_changed(active_key, expected_username)
            )

    def test_expected_owner_must_match_the_controlled_core(self) -> None:
        matching = SimpleNamespace(
            core=SimpleNamespace(owner_username="Expected-Player")
        )
        mismatching = SimpleNamespace(
            core=SimpleNamespace(owner_username="different-player")
        )
        missing_core = SimpleNamespace(core=None)

        self.assertTrue(
            engine._expected_owner_matches(matching, "expected-player")
        )
        self.assertFalse(
            engine._expected_owner_matches(mismatching, "expected-player")
        )
        self.assertIsNone(
            engine._expected_owner_matches(missing_core, "expected-player")
        )
        self.assertTrue(engine._expected_owner_matches(mismatching, ""))


if __name__ == "__main__":
    unittest.main()

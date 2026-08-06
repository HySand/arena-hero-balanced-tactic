from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

from arena_hero_tactic.configuration.strategy import (
    default_config_dict,
    default_strategy_config,
    strategy_config_from_dict,
)
from arena_hero_tactic.training.dataset import (
    RULES_VERSION,
    build_record,
    dataset_status,
    merge_datasets,
    write_package,
)


class MoveAction:
    def __init__(self) -> None:
        self.direction = SimpleNamespace(value="RIGHT")


class TrainingDatasetTests(unittest.TestCase):
    @staticmethod
    def _turn(tick: int = 100) -> SimpleNamespace:
        unit_id = UUID("00000000-0000-0000-0000-000000000001")
        core_id = UUID("00000000-0000-0000-0000-000000000002")
        unit = SimpleNamespace(
            id=unit_id,
            unit_type=SimpleNamespace(value="WORKER"),
            hp=2,
            cargo=0,
            position=(11, 10),
        )
        core = SimpleNamespace(
            id=core_id,
            position=(10, 10),
            hp=5,
            shield=5,
            view=SimpleNamespace(state="IDLE"),
        )
        event = SimpleNamespace(
            tick=tick - 1,
            event_type="UNIT_DAMAGED",
            reason_code="UPKEEP_DEFICIT",
            actor_id=None,
            target_id=unit_id,
            position=(11, 10),
            values={
                "damage": 1,
                "hp": 1,
                "target_id": str(unit_id),
                "owner_username": "must-not-leak",
            },
            resource_amount=None,
        )
        return SimpleNamespace(
            tick=tick,
            core=core,
            units=(unit,),
            workers=(unit,),
            vanguards=(),
            rangers=(),
            visible_enemies=(),
            resource_cells=frozenset({(12, 10)}),
            obstacle_cells=frozenset({(10, 11)}),
            resources=5,
            resource_capacity=10,
            resource_space=5,
            beacon=SimpleNamespace(status="GROUND", position=(0, 0)),
            state=SimpleNamespace(
                status="ACTIVE",
                respawn_at_tick=None,
            ),
            plan=SimpleNamespace(
                unit_actions={unit_id: MoveAction()},
                core_action=None,
            ),
            events=(event,),
        )

    @staticmethod
    def _memory() -> SimpleNamespace:
        return SimpleNamespace(
            last_posture="ECONOMY",
            last_threat_score=0.0,
            known_cells={(10, 10)},
            obstacle_cells={(10, 11)},
            resource_hints={(12, 10)},
            resource_chunks={(0, 0)},
        )

    def _record(self, *, tick: int = 100, config=None) -> dict:
        return build_record(
            self._turn(tick),
            self._memory(),
            config or default_strategy_config(),
            profile="balanced",
            strategy_phase="development",
            resource_radius=12,
            exploration_radius=16,
            offense_ready=False,
            decision_ms=1.25,
            source_id="portable-source",
        )

    def test_record_is_anonymous_relative_and_outcome_linked(self) -> None:
        record = self._record()
        friendly = record["observation"]["friendly_units"][0]
        action = record["decision"]["unit_actions"][0]
        event = record["previous_outcome"]["events"][0]

        self.assertEqual(friendly["position_from_core"], [1, 0])
        self.assertEqual(action["unit_id"], friendly["unit_id"])
        self.assertEqual(event["target_id"], friendly["unit_id"])
        self.assertEqual(event["position_from_core"], [1, 0])
        self.assertEqual(record["contract"]["rules_version"], RULES_VERSION)

        text = json.dumps(record, ensure_ascii=True)
        self.assertNotIn("00000000-0000-0000-0000-000000000001", text)
        self.assertNotIn("must-not-leak", text)
        self.assertNotIn("owner_username", text)

    def test_record_id_is_stable_per_source_rule_and_tick(self) -> None:
        first = self._record()
        document = default_config_dict()
        document["production"]["reserve_resources"] = 9
        second = self._record(config=strategy_config_from_dict(document))

        self.assertEqual(first["record_id"], second["record_id"])
        self.assertNotEqual(first["policy_id"], second["policy_id"])

    def test_packages_deduplicate_and_merge_across_exports(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = self._record()
            document = default_config_dict()
            document["production"]["reserve_resources"] = 9
            replacement = self._record(config=strategy_config_from_dict(document))
            package = root / "first.zip"

            manifest = write_package([first, replacement, replacement], package)
            self.assertEqual(manifest["input_record_count"], 3)
            self.assertEqual(manifest["record_count"], 1)
            self.assertEqual(manifest["duplicates_removed"], 2)

            with zipfile.ZipFile(package) as archive:
                stored = json.loads(
                    archive.read("records.jsonl").decode("utf-8").strip()
                )
            self.assertEqual(stored["policy_id"], replacement["policy_id"])

            merged = root / "merged.zip"
            merged_manifest = merge_datasets([package, package], merged)
            self.assertEqual(merged_manifest["record_count"], 1)
            self.assertEqual(merged_manifest["duplicates_removed"], 1)

    def test_status_reports_raw_and_unique_counts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "records.jsonl"
            record = self._record()
            archive.write_text(
                json.dumps(record) + "\n" + json.dumps(record) + "\n",
                encoding="utf-8",
            )

            status = dataset_status(archive)

            self.assertEqual(status["input_record_count"], 2)
            self.assertEqual(status["record_count"], 1)
            self.assertEqual(status["duplicates_removed"], 1)

    def test_status_reports_corrupt_line_number(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "records.jsonl"
            archive.write_text(
                json.dumps(self._record()) + "\n{" + "\n",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, r"records\.jsonl:2: invalid JSON"):
                dataset_status(archive)

if __name__ == "__main__":
    unittest.main()
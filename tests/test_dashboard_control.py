from __future__ import annotations

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

from arena_hero import Direction, UnitType

from arena_hero_tactic.configuration.strategy import (
    default_config_dict,
    save_strategy_config,
)
from arena_hero_tactic.dashboard.control import (
    ControlCommandError,
    apply_control_commands,
    pending_control_commands,
    queue_control_command,
)
from arena_hero_tactic.dashboard.server import create_server


def uid(number: int) -> UUID:
    return UUID(int=number)


class FakeUnit:
    def __init__(self, number: int, unit_type: UnitType) -> None:
        self.id = uid(number)
        self.unit_type = unit_type
        self.action = ("AUTO",)

    def move(self, direction: Direction) -> None:
        self.action = ("MOVE", direction)

    def wait(self) -> None:
        self.action = ("WAIT",)

    def harvest(self) -> None:
        self.action = ("HARVEST",)

    def deposit(self) -> None:
        self.action = ("DEPOSIT",)

    def sweep(self, direction: Direction) -> None:
        self.action = ("SWEEP", direction)

    def shoot(self, target_id: UUID, *, expected_cell: tuple[int, int]) -> None:
        self.action = ("SHOOT", target_id, expected_cell)

    def pickup_beacon(self) -> None:
        self.action = ("PICKUP_BEACON",)

    def drop_beacon(self) -> None:
        self.action = ("DROP_BEACON",)


class FakeCore:
    def __init__(self) -> None:
        self.id = uid(100)
        self.action = ("AUTO",)

    def wait(self) -> None:
        self.action = ("WAIT",)

    def spawn(self, unit_type: UnitType) -> None:
        self.action = ("SPAWN", unit_type)

    def repair_shield(self) -> None:
        self.action = ("REPAIR_SHIELD",)

    def start_move(self, direction: Direction) -> None:
        self.action = ("START_MOVE", direction)

    def cancel_move(self) -> None:
        self.action = ("CANCEL_MOVE",)

    def pickup_beacon(self) -> None:
        self.action = ("PICKUP_BEACON",)

    def drop_beacon(self) -> None:
        self.action = ("DROP_BEACON",)


class FakeTurn:
    def __init__(self, tick: int, units: list[FakeUnit] | None = None) -> None:
        self.tick = tick
        self.units = tuple(units or [])
        self.core = FakeCore()


class ControlQueueTests(unittest.TestCase):
    def test_worker_move_overrides_automatic_action_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            queue = root / "queue"
            receipt = root / "receipt.json"
            worker = FakeUnit(1, UnitType.WORKER)
            queue_control_command(
                {
                    "target_type": "UNIT",
                    "target_id": str(worker.id),
                    "action": "MOVE",
                    "direction": "LEFT",
                    "observed_tick": 10,
                },
                queue,
            )

            receipts = apply_control_commands(FakeTurn(11, [worker]), queue, receipt)

            self.assertEqual(worker.action, ("MOVE", Direction.LEFT))
            self.assertEqual(receipts[-1]["status"], "applied")
            self.assertEqual(pending_control_commands(queue), [])
            self.assertEqual(
                json.loads(receipt.read_text(encoding="utf-8"))["applied_tick"],
                11,
            )

    def test_latest_command_for_one_target_wins(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            queue = root / "queue"
            worker = FakeUnit(2, UnitType.WORKER)
            base = {
                "target_type": "UNIT",
                "target_id": str(worker.id),
                "observed_tick": 20,
            }
            queue_control_command(
                {**base, "action": "MOVE", "direction": "UP"},
                queue,
            )
            queue_control_command({**base, "action": "WAIT"}, queue)

            receipts = apply_control_commands(
                FakeTurn(20, [worker]),
                queue,
                root / "receipt.json",
            )

            self.assertEqual(worker.action, ("WAIT",))
            self.assertEqual([item["status"] for item in receipts], ["superseded", "applied"])

    def test_core_spawn_and_ranger_shoot_use_typed_sdk_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            queue = root / "queue"
            turn = FakeTurn(30, [FakeUnit(3, UnitType.RANGER)])
            queue_control_command(
                {
                    "target_type": "CORE",
                    "target_id": str(turn.core.id),
                    "action": "SPAWN",
                    "unit_type": "VANGUARD",
                    "observed_tick": 30,
                },
                queue,
            )
            enemy_id = uid(900)
            queue_control_command(
                {
                    "target_type": "UNIT",
                    "target_id": str(turn.units[0].id),
                    "action": "SHOOT",
                    "enemy_id": str(enemy_id),
                    "expected_cell": [5, -2],
                    "observed_tick": 30,
                },
                queue,
            )

            apply_control_commands(turn, queue, root / "receipt.json")

            self.assertEqual(turn.core.action, ("SPAWN", UnitType.VANGUARD))
            self.assertEqual(turn.units[0].action, ("SHOOT", enemy_id, (5, -2)))

    def test_invalid_action_shape_is_rejected_before_queueing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ControlCommandError):
                queue_control_command(
                    {
                        "target_type": "UNIT",
                        "target_id": str(uid(1)),
                        "action": "SHOOT",
                        "observed_tick": 1,
                    },
                    Path(directory),
                )


class ControlAPITests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.config_path = root / "strategy.json"
        self.status_path = root / "status.json"
        self.control_dir = root / "control"
        self.receipt_path = root / "receipt.json"
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
            control_dir=self.control_dir,
            control_receipt_path=self.receipt_path,
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

    def request_json(
        self,
        method: str,
        document: dict | None = None,
    ) -> tuple[int, dict]:
        data = None if document is None else json.dumps(document).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + "/api/control",
            data=data,
            headers={"Content-Type": "application/json"} if data else {},
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            try:
                return error.code, json.load(error)
            finally:
                error.close()

    def test_post_get_and_delete_control_queue(self) -> None:
        status, queued = self.request_json(
            "POST",
            {
                "target_type": "UNIT",
                "target_id": str(uid(5)),
                "action": "MOVE",
                "direction": "RIGHT",
                "observed_tick": 42,
            },
        )
        self.assertEqual(status, 202)
        self.assertTrue(queued["ok"])

        status, current = self.request_json("GET")
        self.assertEqual(status, 200)
        self.assertEqual(len(current["pending"]), 1)

        status, cleared = self.request_json("DELETE")
        self.assertEqual(status, 200)
        self.assertEqual(cleared["removed"], 1)


if __name__ == "__main__":
    unittest.main()

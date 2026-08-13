"""Local filesystem persistence for pure strategy memory."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Mapping

from ..strategy_core.planner import TacticMemory as CoreTacticMemory


class TacticMemory(CoreTacticMemory):
    @classmethod
    def load(cls, path: Path) -> TacticMemory:
        if not path.is_file():
            return cls()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            return cls()
        return cls.from_dict(data)

    def save(self, path: Path) -> None:
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(self.to_dict(), ensure_ascii=True, separators=(",", ":")),
            encoding="utf-8",
        )
        temporary.replace(path)


def replace_memory(target: CoreTacticMemory, document: Mapping[str, object]) -> None:
    restored = type(target).from_dict(document)
    target.__dict__.clear()
    target.__dict__.update(restored.__dict__)

"""Pure service helpers shared by the Python Durable Object and tests."""

from __future__ import annotations

from dataclasses import replace
from typing import Literal

from .contracts import PlanResult
from .memory import compact_memory_document
from .planner import plan_tick
from .serialization import TickRequest

OrderingResult = Literal["new", "replay", "stale", "conflict"]


def classify_ordering(
    last_tick: int | None,
    last_digest: str | None,
    tick: int,
    digest: str,
) -> OrderingResult:
    if last_tick is None or tick > last_tick:
        return "new"
    if tick < last_tick:
        return "stale"
    return "replay" if last_digest == digest else "conflict"


def execute_tick(request: TickRequest) -> PlanResult:
    result = plan_tick(request.state, request.memory, request.config)
    return replace(
        result,
        memory=compact_memory_document(result.memory, request.state),
    )

"""Versioned public contracts for the shared Python strategy."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from .model import CommandPlan

CONTRACT_VERSION = "1"
STRATEGY_VERSION = "python-economy-v1"


class ContractError(ValueError):
    """Raised when a wire payload does not match the strategy contract."""


@dataclass(frozen=True)
class PlanResult:
    plan: CommandPlan
    memory: Mapping[str, Any]
    summary: Mapping[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "plan": self.plan.to_dict(),
            "memory": dict(self.memory),
            "summary": dict(self.summary),
        }

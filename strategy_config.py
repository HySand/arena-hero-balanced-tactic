"""Validated, hot-reloadable strategy configuration shared by tactic and UI."""

from __future__ import annotations

import copy
import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


CONFIG_VERSION = 1
CONFIG_FILE = Path(__file__).with_name("strategy_config.json")
UNIT_TYPES = ("WORKER", "VANGUARD", "RANGER")
AFTER_PLAN_MODES = ("adaptive", "hold")


class StrategyConfigError(ValueError):
    """Raised when a dashboard or hand-edited configuration is invalid."""


@dataclass(frozen=True)
class ProductionStep:
    unit_type: str
    target: int


@dataclass(frozen=True)
class ProductionConfig:
    enabled: bool
    order: tuple[ProductionStep, ...]
    reserve_resources: int
    max_population: int
    after_plan: str


@dataclass(frozen=True)
class ThreatConfig:
    guarded_score: float
    survival_score: float


@dataclass(frozen=True)
class WorkerConfig:
    max_economy_scouts: int
    max_scouts_under_threat: int
    safe_scout_radius: int


@dataclass(frozen=True)
class AdaptiveEconomyConfig:
    enabled: bool
    window_ticks: int
    warmup_ticks: int
    adjustment_cooldown_ticks: int
    radius_step: int
    min_resource_radius: int
    max_resource_radius: int
    scarcity_ticks: int
    long_cycle_ticks: int
    low_throughput_per_worker: float
    healthy_throughput_per_worker: float
    max_harvest_failure_rate: float
    storage_full_ratio: float
    max_scout_bonus: int
    worker_target_min: int
    worker_target_max: int


@dataclass(frozen=True)
class PacingConfig:
    enabled: bool
    early_ticks: int
    mid_ticks: int
    early_population: int
    mid_population: int
    early_resource_radius: int
    mid_resource_radius: int
    late_resource_radius: int
    early_exploration_radius: int
    mid_exploration_radius: int
    late_exploration_radius: int
    early_worker_scouts: int
    mid_worker_scouts: int
    late_worker_scouts: int
    offense_enabled: bool
    offense_after_ticks: int
    offense_min_resources: int
    offense_min_population: int
    offense_min_vanguards: int
    offense_min_rangers: int
    offense_min_defenders: int
    offense_radius: int


@dataclass(frozen=True)
class VanguardConfig:
    early_scout_radius: int
    late_scout_radius: int
    beacon_after_ticks: int
    beacon_min_defenders: int


@dataclass(frozen=True)
class RangerConfig:
    guard_numerator: int
    guard_denominator: int
    guard_radius: int


@dataclass(frozen=True)
class CoreConfig:
    migration_enabled: bool
    migration_danger_score: float
    migration_start_ticks: int
    migration_cooldown_ticks: int
    migration_min_workers: int
    migration_min_vanguards: int
    migration_min_rangers: int
    worker_evacuation_radius: int
    cover_gain_required: float


@dataclass(frozen=True)
class StrategyConfig:
    version: int
    production: ProductionConfig
    threat: ThreatConfig
    workers: WorkerConfig
    adaptive_economy: AdaptiveEconomyConfig
    pacing: PacingConfig
    vanguards: VanguardConfig
    rangers: RangerConfig
    core: CoreConfig
    extensions: Mapping[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "production": {
                "enabled": self.production.enabled,
                "order": [
                    {"unit_type": item.unit_type, "target": item.target}
                    for item in self.production.order
                ],
                "reserve_resources": self.production.reserve_resources,
                "max_population": self.production.max_population,
                "after_plan": self.production.after_plan,
            },
            "threat": vars(self.threat),
            "workers": vars(self.workers),
            "adaptive_economy": vars(self.adaptive_economy),
            "pacing": vars(self.pacing),
            "vanguards": vars(self.vanguards),
            "rangers": vars(self.rangers),
            "core": vars(self.core),
            "extensions": copy.deepcopy(dict(self.extensions)),
        }


_DEFAULT_DOCUMENT: dict[str, Any] = {
    "version": CONFIG_VERSION,
    "production": {
        "enabled": True,
        "order": [
            {"unit_type": "WORKER", "target": 6},
            {"unit_type": "VANGUARD", "target": 2},
            {"unit_type": "RANGER", "target": 3},
        ],
        "reserve_resources": 5,
        "max_population": 18,
        "after_plan": "adaptive",
    },
    "threat": {"guarded_score": 2.0, "survival_score": 4.0},
    "workers": {
        "max_economy_scouts": 8,
        "max_scouts_under_threat": 1,
        "safe_scout_radius": 12,
    },
    "adaptive_economy": {
        "enabled": True,
        "window_ticks": 12,
        "warmup_ticks": 8,
        "adjustment_cooldown_ticks": 6,
        "radius_step": 2,
        "min_resource_radius": 6,
        "max_resource_radius": 44,
        "scarcity_ticks": 3,
        "long_cycle_ticks": 24,
        "low_throughput_per_worker": 0.025,
        "healthy_throughput_per_worker": 0.05,
        "max_harvest_failure_rate": 0.25,
        "storage_full_ratio": 0.5,
        "max_scout_bonus": 2,
        "worker_target_min": 4,
        "worker_target_max": 8,
    },
    "pacing": {
        "enabled": True,
        "early_ticks": 80,
        "mid_ticks": 180,
        "early_population": 6,
        "mid_population": 10,
        "early_resource_radius": 10,
        "mid_resource_radius": 22,
        "late_resource_radius": 40,
        "early_exploration_radius": 12,
        "mid_exploration_radius": 24,
        "late_exploration_radius": 42,
        "early_worker_scouts": 1,
        "mid_worker_scouts": 3,
        "late_worker_scouts": 6,
        "offense_enabled": True,
        "offense_after_ticks": 180,
        "offense_min_resources": 35,
        "offense_min_population": 10,
        "offense_min_vanguards": 2,
        "offense_min_rangers": 1,
        "offense_min_defenders": 3,
        "offense_radius": 36,
    },
    "vanguards": {
        "early_scout_radius": 80,
        "late_scout_radius": 120,
        "beacon_after_ticks": 240,
        "beacon_min_defenders": 4,
    },
    "rangers": {
        "guard_numerator": 2,
        "guard_denominator": 3,
        "guard_radius": 3,
    },
    "core": {
        "migration_enabled": True,
        "migration_danger_score": 3.0,
        "migration_start_ticks": 0,
        "migration_cooldown_ticks": 20,
        "migration_min_workers": 0,
        "migration_min_vanguards": 1,
        "migration_min_rangers": 1,
        "worker_evacuation_radius": 8,
        "cover_gain_required": 1.5,
    },
    "extensions": {},
}

CONFIG_SCHEMA = {
    "version": CONFIG_VERSION,
    "unit_types": list(UNIT_TYPES),
    "unit_costs": {"WORKER": 5, "VANGUARD": 10, "RANGER": 12},
    "after_plan_modes": list(AFTER_PLAN_MODES),
    "defaults": copy.deepcopy(_DEFAULT_DOCUMENT),
    "limits": {
        "target": [0, 100],
        "reserve_resources": [0, 10000],
        "max_population": [1, 100],
        "score": [0, 100],
        "radius": [0, 500],
        "ticks": [0, 100000],
        "ratio_part": [1, 100],
        "cover_gain_required": [0, 100],
    },
}


def default_config_dict() -> dict[str, Any]:
    return copy.deepcopy(_DEFAULT_DOCUMENT)


def _section(root: Mapping[str, Any], name: str) -> Mapping[str, Any]:
    value = root.get(name, _DEFAULT_DOCUMENT[name])
    if not isinstance(value, Mapping):
        raise StrategyConfigError(f"{name} must be an object")
    return value


def _boolean(section: Mapping[str, Any], key: str, default: bool) -> bool:
    value = section.get(key, default)
    if not isinstance(value, bool):
        raise StrategyConfigError(f"{key} must be true or false")
    return value


def _integer(
    section: Mapping[str, Any],
    key: str,
    default: int | None,
    minimum: int,
    maximum: int,
) -> int:
    value = section.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise StrategyConfigError(f"{key} must be an integer")
    if not minimum <= value <= maximum:
        raise StrategyConfigError(f"{key} must be between {minimum} and {maximum}")
    return value


def _number(
    section: Mapping[str, Any],
    key: str,
    default: float,
    minimum: float,
    maximum: float,
) -> float:
    value = section.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise StrategyConfigError(f"{key} must be a number")
    result = float(value)
    if not minimum <= result <= maximum:
        raise StrategyConfigError(f"{key} must be between {minimum:g} and {maximum:g}")
    return result


def strategy_config_from_dict(document: Mapping[str, Any]) -> StrategyConfig:
    if not isinstance(document, Mapping):
        raise StrategyConfigError("configuration must be an object")
    version = _integer(document, "version", CONFIG_VERSION, 1, CONFIG_VERSION)

    raw_production = _section(document, "production")
    raw_order = raw_production.get("order", _DEFAULT_DOCUMENT["production"]["order"])
    if not isinstance(raw_order, list) or not raw_order:
        raise StrategyConfigError("production.order must be a non-empty array")
    order: list[ProductionStep] = []
    for index, raw_item in enumerate(raw_order):
        if not isinstance(raw_item, Mapping):
            raise StrategyConfigError(f"production.order[{index}] must be an object")
        unit_type = str(raw_item.get("unit_type", "")).upper()
        if unit_type not in UNIT_TYPES:
            raise StrategyConfigError(
                f"production.order[{index}].unit_type must be one of {UNIT_TYPES}"
            )
        target = _integer(raw_item, "target", None, 0, 100)
        order.append(ProductionStep(unit_type, target))
    types = [item.unit_type for item in order]
    if len(types) != len(set(types)):
        raise StrategyConfigError("production.order cannot repeat a unit type")
    if set(types) != set(UNIT_TYPES):
        raise StrategyConfigError("production.order must contain all three unit types")
    after_plan = str(
        raw_production.get("after_plan", _DEFAULT_DOCUMENT["production"]["after_plan"])
    ).lower()
    if after_plan not in AFTER_PLAN_MODES:
        raise StrategyConfigError(f"production.after_plan must be one of {AFTER_PLAN_MODES}")
    production = ProductionConfig(
        enabled=_boolean(
            raw_production, "enabled", _DEFAULT_DOCUMENT["production"]["enabled"]
        ),
        order=tuple(order),
        reserve_resources=_integer(
            raw_production,
            "reserve_resources",
            _DEFAULT_DOCUMENT["production"]["reserve_resources"],
            0,
            10000,
        ),
        max_population=_integer(
            raw_production,
            "max_population",
            _DEFAULT_DOCUMENT["production"]["max_population"],
            1,
            100,
        ),
        after_plan=after_plan,
    )
    if sum(item.target for item in order) > production.max_population:
        raise StrategyConfigError("production targets exceed max_population")

    raw_threat = _section(document, "threat")
    threat = ThreatConfig(
        _number(raw_threat, "guarded_score", 2.0, 0, 100),
        _number(raw_threat, "survival_score", 4.0, 0, 100),
    )
    if threat.guarded_score >= threat.survival_score:
        raise StrategyConfigError("guarded_score must be lower than survival_score")

    raw_workers = _section(document, "workers")
    workers = WorkerConfig(
        _integer(raw_workers, "max_economy_scouts", 8, 0, 100),
        _integer(raw_workers, "max_scouts_under_threat", 1, 0, 100),
        _integer(raw_workers, "safe_scout_radius", 12, 0, 500),
    )

    raw_pacing = _section(document, "pacing")
    raw_adaptive = _section(document, "adaptive_economy")
    adaptive_economy = AdaptiveEconomyConfig(
        _boolean(raw_adaptive, "enabled", True),
        _integer(raw_adaptive, "window_ticks", 12, 4, 64),
        _integer(raw_adaptive, "warmup_ticks", 8, 0, 1000),
        _integer(raw_adaptive, "adjustment_cooldown_ticks", 6, 1, 1000),
        _integer(raw_adaptive, "radius_step", 2, 1, 20),
        _integer(raw_adaptive, "min_resource_radius", 6, 1, 500),
        _integer(raw_adaptive, "max_resource_radius", 44, 1, 500),
        _integer(raw_adaptive, "scarcity_ticks", 3, 1, 64),
        _integer(raw_adaptive, "long_cycle_ticks", 24, 1, 1000),
        _number(raw_adaptive, "low_throughput_per_worker", 0.025, 0, 100),
        _number(raw_adaptive, "healthy_throughput_per_worker", 0.05, 0, 100),
        _number(raw_adaptive, "max_harvest_failure_rate", 0.25, 0, 1),
        _number(raw_adaptive, "storage_full_ratio", 0.5, 0, 1),
        _integer(raw_adaptive, "max_scout_bonus", 2, 0, 20),
        _integer(raw_adaptive, "worker_target_min", 4, 0, 100),
        _integer(raw_adaptive, "worker_target_max", 8, 0, 100),
    )
    if adaptive_economy.min_resource_radius > adaptive_economy.max_resource_radius:
        raise StrategyConfigError(
            "adaptive_economy.min_resource_radius cannot exceed max_resource_radius"
        )
    if (
        adaptive_economy.low_throughput_per_worker
        >= adaptive_economy.healthy_throughput_per_worker
    ):
        raise StrategyConfigError(
            "adaptive_economy.low_throughput_per_worker must be lower than "
            "healthy_throughput_per_worker"
        )
    if adaptive_economy.worker_target_min > adaptive_economy.worker_target_max:
        raise StrategyConfigError(
            "adaptive_economy.worker_target_min cannot exceed worker_target_max"
        )

    pacing = PacingConfig(
        _boolean(raw_pacing, "enabled", True),
        _integer(raw_pacing, "early_ticks", 80, 0, 100000),
        _integer(raw_pacing, "mid_ticks", 180, 0, 100000),
        _integer(raw_pacing, "early_population", 6, 0, 100),
        _integer(raw_pacing, "mid_population", 10, 0, 100),
        _integer(raw_pacing, "early_resource_radius", 10, 0, 500),
        _integer(raw_pacing, "mid_resource_radius", 22, 0, 500),
        _integer(raw_pacing, "late_resource_radius", 40, 0, 500),
        _integer(raw_pacing, "early_exploration_radius", 12, 0, 500),
        _integer(raw_pacing, "mid_exploration_radius", 24, 0, 500),
        _integer(raw_pacing, "late_exploration_radius", 42, 0, 500),
        _integer(raw_pacing, "early_worker_scouts", 1, 0, 100),
        _integer(raw_pacing, "mid_worker_scouts", 3, 0, 100),
        _integer(raw_pacing, "late_worker_scouts", 6, 0, 100),
        _boolean(raw_pacing, "offense_enabled", True),
        _integer(raw_pacing, "offense_after_ticks", 180, 0, 100000),
        _integer(raw_pacing, "offense_min_resources", 35, 0, 10000),
        _integer(raw_pacing, "offense_min_population", 10, 0, 100),
        _integer(raw_pacing, "offense_min_vanguards", 2, 0, 100),
        _integer(raw_pacing, "offense_min_rangers", 1, 0, 100),
        _integer(raw_pacing, "offense_min_defenders", 3, 0, 100),
        _integer(raw_pacing, "offense_radius", 36, 0, 500),
    )
    if pacing.mid_ticks < pacing.early_ticks:
        raise StrategyConfigError("pacing.mid_ticks cannot be smaller than early_ticks")
    if pacing.mid_population < pacing.early_population:
        raise StrategyConfigError(
            "pacing.mid_population cannot be smaller than early_population"
        )
    if pacing.mid_resource_radius < pacing.early_resource_radius:
        raise StrategyConfigError(
            "pacing.mid_resource_radius cannot be smaller than early_resource_radius"
        )
    if pacing.late_resource_radius < pacing.mid_resource_radius:
        raise StrategyConfigError(
            "pacing.late_resource_radius cannot be smaller than mid_resource_radius"
        )
    if pacing.mid_exploration_radius < pacing.early_exploration_radius:
        raise StrategyConfigError(
            "pacing.mid_exploration_radius cannot be smaller than early_exploration_radius"
        )
    if pacing.late_exploration_radius < pacing.mid_exploration_radius:
        raise StrategyConfigError(
            "pacing.late_exploration_radius cannot be smaller than mid_exploration_radius"
        )
    if pacing.mid_worker_scouts < pacing.early_worker_scouts:
        raise StrategyConfigError(
            "pacing.mid_worker_scouts cannot be smaller than early_worker_scouts"
        )
    if pacing.late_worker_scouts < pacing.mid_worker_scouts:
        raise StrategyConfigError(
            "pacing.late_worker_scouts cannot be smaller than mid_worker_scouts"
        )

    raw_vanguards = _section(document, "vanguards")
    vanguards = VanguardConfig(
        _integer(raw_vanguards, "early_scout_radius", 80, 0, 500),
        _integer(raw_vanguards, "late_scout_radius", 120, 0, 500),
        _integer(raw_vanguards, "beacon_after_ticks", 240, 0, 100000),
        _integer(raw_vanguards, "beacon_min_defenders", 4, 0, 100),
    )
    if vanguards.late_scout_radius < vanguards.early_scout_radius:
        raise StrategyConfigError("late_scout_radius cannot be smaller than early_scout_radius")

    raw_rangers = _section(document, "rangers")
    rangers = RangerConfig(
        _integer(raw_rangers, "guard_numerator", 2, 1, 100),
        _integer(raw_rangers, "guard_denominator", 3, 1, 100),
        _integer(raw_rangers, "guard_radius", 3, 0, 500),
    )
    if rangers.guard_numerator > rangers.guard_denominator:
        raise StrategyConfigError("guard_numerator cannot exceed guard_denominator")

    raw_core = _section(document, "core")
    core = CoreConfig(
        _boolean(raw_core, "migration_enabled", True),
        _number(raw_core, "migration_danger_score", 3.0, 0, 100),
        _integer(raw_core, "migration_start_ticks", 40, 0, 100000),
        _integer(raw_core, "migration_cooldown_ticks", 20, 0, 100000),
        _integer(raw_core, "migration_min_workers", 0, 0, 100),
        _integer(raw_core, "migration_min_vanguards", 1, 0, 100),
        _integer(raw_core, "migration_min_rangers", 1, 0, 100),
        _integer(raw_core, "worker_evacuation_radius", 8, 1, 500),
        _number(raw_core, "cover_gain_required", 1.5, 0, 100),
    )

    extensions = document.get("extensions", {})
    if not isinstance(extensions, Mapping):
        raise StrategyConfigError("extensions must be an object")
    try:
        json.dumps(extensions, ensure_ascii=True)
    except (TypeError, ValueError) as error:
        raise StrategyConfigError("extensions must contain JSON values") from error
    return StrategyConfig(
        version,
        production,
        threat,
        workers,
        adaptive_economy,
        pacing,
        vanguards,
        rangers,
        core,
        copy.deepcopy(dict(extensions)),
    )


def default_strategy_config() -> StrategyConfig:
    return strategy_config_from_dict(default_config_dict())


_CACHE_LOCK = threading.Lock()
_CACHE: dict[Path, tuple[tuple[int, int] | None, StrategyConfig]] = {}


def _stamp(path: Path) -> tuple[int, int] | None:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return stat.st_mtime_ns, stat.st_size


def load_strategy_config(
    path: Path = CONFIG_FILE,
    *,
    strict: bool = False,
) -> StrategyConfig:
    """Load cached config; unattended tactics fall back after invalid edits."""

    resolved = path.resolve()
    stamp = _stamp(resolved)
    with _CACHE_LOCK:
        cached = _CACHE.get(resolved)
        if cached is not None and cached[0] == stamp:
            return cached[1]
    try:
        if stamp is None:
            config = default_strategy_config()
        else:
            config = strategy_config_from_dict(
                json.loads(resolved.read_text(encoding="utf-8"))
            )
    except (OSError, json.JSONDecodeError, StrategyConfigError) as error:
        if strict:
            if isinstance(error, StrategyConfigError):
                raise
            raise StrategyConfigError(f"cannot read strategy config: {error}") from error
        # Do not cache an invalid manual edit: the next Turn must be able to
        # pick up a corrected file even on filesystems with coarse timestamps.
        return default_strategy_config()
    with _CACHE_LOCK:
        _CACHE[resolved] = (stamp, config)
    return config


def save_strategy_config(
    document: Mapping[str, Any],
    path: Path = CONFIG_FILE,
) -> StrategyConfig:
    """Validate and atomically replace the document consumed by the tactic."""

    config = strategy_config_from_dict(document)
    resolved = path.resolve()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    temporary = resolved.with_suffix(resolved.suffix + ".tmp")
    temporary.write_text(
        json.dumps(config.to_dict(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(resolved)
    with _CACHE_LOCK:
        _CACHE[resolved] = (_stamp(resolved), config)
    return config

"""Hot-reloadable filesystem adapter for the pure strategy configuration."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any, Mapping

from ..runtime.paths import CONFIG_FILE, DEFAULT_CONFIG_FILE
from ..strategy_core.config import (
    AFTER_PLAN_MODES,
    CONFIG_SCHEMA,
    CONFIG_VERSION,
    UNIT_TYPES,
    AdaptiveEconomyConfig,
    CoreConfig,
    PacingConfig,
    ProductionConfig,
    ProductionStep,
    RangerConfig,
    StrategyConfig,
    StrategyConfigError,
    ThreatConfig,
    VanguardConfig,
    WorkerConfig,
    default_config_dict,
    default_strategy_config,
    strategy_config_from_dict,
)

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
            if resolved == CONFIG_FILE.resolve() and DEFAULT_CONFIG_FILE.is_file():
                config = strategy_config_from_dict(
                    json.loads(DEFAULT_CONFIG_FILE.read_text(encoding="utf-8"))
                )
            else:
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


__all__ = [
    "AFTER_PLAN_MODES",
    "CONFIG_SCHEMA",
    "CONFIG_VERSION",
    "UNIT_TYPES",
    "AdaptiveEconomyConfig",
    "CoreConfig",
    "PacingConfig",
    "ProductionConfig",
    "ProductionStep",
    "RangerConfig",
    "StrategyConfig",
    "StrategyConfigError",
    "ThreatConfig",
    "VanguardConfig",
    "WorkerConfig",
    "default_config_dict",
    "default_strategy_config",
    "load_strategy_config",
    "save_strategy_config",
    "strategy_config_from_dict",
]

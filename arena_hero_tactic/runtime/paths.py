"""Central project paths for runtime state, training data, and public models."""

from __future__ import annotations

import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = PROJECT_ROOT / "config"
DATA_DIR = PROJECT_ROOT / "data"
RUNTIME_DIR = DATA_DIR / "runtime"
STATE_DIR = RUNTIME_DIR / "state"
LOCK_DIR = RUNTIME_DIR / "locks"
LOG_DIR = RUNTIME_DIR / "logs"
CONTROL_DIR = RUNTIME_DIR / "control"
CONTROL_RECEIPT_FILE = STATE_DIR / "control_receipt.json"
TRAINING_DIR = DATA_DIR / "training"
EXPORT_DIR = TRAINING_DIR / "exports"
MODEL_DIR = DATA_DIR / "models"
STATIC_DIR = PROJECT_ROOT / "dashboard"
ENV_FILE = PROJECT_ROOT / ".env"

DEFAULT_CONFIG_FILE = CONFIG_DIR / "strategy_config.json"
CONFIG_FILE = Path(
    os.environ.get("ARENA_HERO_CONFIG_FILE", str(RUNTIME_DIR / "strategy_config.json"))
).expanduser()

STATE_FILE = Path(
    os.environ.get("ARENA_HERO_STATE_FILE", str(STATE_DIR / "tactic_state.json"))
).expanduser()
DASHBOARD_STATE_FILE = Path(
    os.environ.get(
        "ARENA_HERO_DASHBOARD_STATE_FILE",
        str(STATE_DIR / "dashboard_state.json"),
    )
).expanduser()
TACTIC_LOCK_FILE = Path(
    os.environ.get("ARENA_HERO_TACTIC_LOCK_FILE", str(LOCK_DIR / "tactic.lock"))
).expanduser()
DASHBOARD_LOCK_FILE = Path(
    os.environ.get(
        "ARENA_HERO_DASHBOARD_LOCK_FILE",
        str(LOCK_DIR / "dashboard.lock"),
    )
).expanduser()

TRAINING_ARCHIVE_FILE = Path(
    os.environ.get("ARENA_HERO_TRAINING_FILE", str(TRAINING_DIR / "turns.jsonl"))
).expanduser()
TRAINING_SOURCE_FILE = Path(
    os.environ.get(
        "ARENA_HERO_TRAINING_SOURCE_FILE",
        str(TRAINING_DIR / "source.json"),
    )
).expanduser()
ECONOMY_TELEMETRY_FILE = Path(
    os.environ.get(
        "ARENA_HERO_ECONOMY_TELEMETRY_FILE",
        str(TRAINING_DIR / "peace_economy_telemetry.jsonl"),
    )
).expanduser()
EXPERIMENT_STATE_FILE = Path(
    os.environ.get(
        "ARENA_HERO_EXPERIMENT_STATE_FILE",
        str(STATE_DIR / "peace_economy_experiment_state.json"),
    )
).expanduser()
EXPERIMENT_PLAN_FILE = Path(
    os.environ.get(
        "ARENA_HERO_EXPERIMENT_PLAN_FILE",
        str(CONFIG_DIR / "peace_economy_17_1_1.json"),
    )
).expanduser()
MODEL_FILE = MODEL_DIR / "peace_economy_training_snapshot.json"
COMPATIBILITY_HOLD_FILE = Path(
    os.environ.get(
        "ARENA_HERO_COMPAT_MARKER",
        str(STATE_DIR / "compatibility_hold.json"),
    )
).expanduser()
VERSION_REPORT_FILE = Path(
    os.environ.get(
        "ARENA_HERO_COMPAT_REPORT",
        str(STATE_DIR / "version_report.json"),
    )
).expanduser()


LEGACY_FILE_MAP = {
    # Files created by the previous centralized data layout.
    STATE_DIR / ".arena_hero_state.json": STATE_FILE,
    STATE_DIR / ".arena_hero_dashboard_state.json": DASHBOARD_STATE_FILE,
    STATE_DIR / ".arena_hero_training_source.json": TRAINING_SOURCE_FILE,
    STATE_DIR / ".peace_economy_experiment_state.json": EXPERIMENT_STATE_FILE,
    STATE_DIR / ".arena_hero_version_report.json": VERSION_REPORT_FILE,
    STATE_DIR / ".arena_hero_compatibility_hold.json": COMPATIBILITY_HOLD_FILE,
    # Files created before data was centralized under data/.
    PROJECT_ROOT / ".arena_hero_state.json": STATE_FILE,
    PROJECT_ROOT / ".arena_hero_dashboard_state.json": DASHBOARD_STATE_FILE,
    PROJECT_ROOT / ".arena_hero_training.jsonl": TRAINING_ARCHIVE_FILE,
    PROJECT_ROOT / ".arena_hero_training_source.json": TRAINING_SOURCE_FILE,
    PROJECT_ROOT / ".peace_economy_telemetry.jsonl": ECONOMY_TELEMETRY_FILE,
    PROJECT_ROOT / ".peace_economy_experiment_state.json": EXPERIMENT_STATE_FILE,
    PROJECT_ROOT / ".arena_hero_version_report.json": VERSION_REPORT_FILE,
    PROJECT_ROOT / ".arena_hero_compatibility_hold.json": COMPATIBILITY_HOLD_FILE,
    PROJECT_ROOT / "strategy_config.json": CONFIG_FILE,
    PROJECT_ROOT / "peace_economy_17_1_1.json": EXPERIMENT_PLAN_FILE,
    PROJECT_ROOT / "peace_economy_training_snapshot.json": MODEL_FILE,
}


def ensure_data_dirs() -> None:
    """Create the data layout and migrate one-time legacy root files."""
    for directory in (
        CONFIG_DIR,
        STATE_DIR,
        LOCK_DIR,
        LOG_DIR,
        CONTROL_DIR,
        TRAINING_DIR,
        EXPORT_DIR,
        MODEL_DIR,
    ):
        directory.mkdir(parents=True, exist_ok=True)
    for legacy, current in LEGACY_FILE_MAP.items():
        if legacy == current or not legacy.is_file() or current.exists():
            continue
        current.parent.mkdir(parents=True, exist_ok=True)
        try:
            legacy.replace(current)
        except OSError:
            # A read-only checkout can still use the new paths without migration.
            pass


ensure_data_dirs()

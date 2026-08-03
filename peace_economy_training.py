"""Calibrate the peaceful late-game economy from recorded tactic telemetry."""

from __future__ import annotations

import argparse
import json
import math
import statistics
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from strategy_config import CONFIG_FILE, load_strategy_config, save_strategy_config


STATE_FILE = Path(__file__).with_name(".arena_hero_state.json")
MIN_TRAINING_SAMPLES = 12
SCOUT_PRIOR_SAMPLES = 6
PEACE_WORKER_TARGET = 17
CONFIDENCE_RANK = {"low": 0, "medium": 1, "high": 2}


def _number(sample: Mapping[str, Any], key: str) -> float:
    value = sample.get(key, 0)
    return float(value) if isinstance(value, (int, float)) else 0.0


def _clamp(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, value))


def _round_even(value: float) -> int:
    return max(2, int(round(value / 2.0)) * 2)


def _percentile(values: Sequence[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def _sample_reward(sample: Mapping[str, Any]) -> float:
    workers = _number(sample, "workers")
    busy = min(workers, _number(sample, "busy"))
    idle = max(0.0, workers - busy)
    return (
        4.0 * _number(sample, "harvested")
        + 2.0 * _number(sample, "deposited")
        + 1.5 * _number(sample, "assignments")
        + 0.5 * _number(sample, "new_cells")
        - 2.5 * _number(sample, "harvest_failures")
        - 1.0 * _number(sample, "storage_full")
        - 0.15 * idle
    )


@dataclass(frozen=True)
class PeaceEconomyTrainingResult:
    sample_count: int
    tick_start: int
    tick_end: int
    score: float
    confidence: str
    max_economy_scouts: int
    max_scout_bonus: int
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
    worker_target: int
    selected_scout_samples: int
    outcome_events: int

    def adaptive_values(self) -> dict[str, int | float | bool]:
        return {
            "enabled": True,
            "window_ticks": self.window_ticks,
            "warmup_ticks": self.warmup_ticks,
            "adjustment_cooldown_ticks": self.adjustment_cooldown_ticks,
            "radius_step": self.radius_step,
            "min_resource_radius": self.min_resource_radius,
            "max_resource_radius": self.max_resource_radius,
            "scarcity_ticks": self.scarcity_ticks,
            "long_cycle_ticks": self.long_cycle_ticks,
            "low_throughput_per_worker": self.low_throughput_per_worker,
            "healthy_throughput_per_worker": self.healthy_throughput_per_worker,
            "max_harvest_failure_rate": self.max_harvest_failure_rate,
            "storage_full_ratio": self.storage_full_ratio,
            "max_scout_bonus": self.max_scout_bonus,
            "worker_target_min": self.worker_target,
            "worker_target_max": self.worker_target,
        }

    def metadata(self) -> dict[str, Any]:
        document = asdict(self)
        document["trained_at"] = datetime.now(timezone.utc).isoformat()
        document["objective"] = (
            "resource delivery, harvesting, discovery and utilization minus "
            "failures, overflow and idle worker time"
        )
        return document


def train_peace_economy(
    history: Sequence[Mapping[str, Any]],
    cycle_durations: Sequence[int | float] = (),
) -> PeaceEconomyTrainingResult:
    samples = [sample for sample in history if _number(sample, "workers") > 0]
    if len(samples) < MIN_TRAINING_SAMPLES:
        raise ValueError(
            f"peace economy training needs at least {MIN_TRAINING_SAMPLES} samples"
        )

    rewards = [_sample_reward(sample) for sample in samples]
    global_reward = statistics.fmean(rewards)
    grouped: dict[int, list[float]] = {}
    for sample, reward in zip(samples, rewards):
        scouts = int(_number(sample, "scouts"))
        if scouts > 0:
            grouped.setdefault(scouts, []).append(reward)
    if not grouped:
        raise ValueError("peace economy training needs samples with active scouts")

    scout_scores: dict[int, float] = {}
    for scouts, group_rewards in grouped.items():
        smoothed = (
            sum(group_rewards) + SCOUT_PRIOR_SAMPLES * global_reward
        ) / (len(group_rewards) + SCOUT_PRIOR_SAMPLES)
        scout_scores[scouts] = smoothed - 0.03 * scouts
    selected_scouts = max(
        scout_scores,
        key=lambda scouts: (scout_scores[scouts], len(grouped[scouts]), scouts),
    )

    worker_counts = [int(_number(sample, "workers")) for sample in samples]
    worker_target = PEACE_WORKER_TARGET
    max_workers = max(worker_counts)
    max_scout_bonus = _clamp(max_workers - selected_scouts, 0, 2)

    cycles = [float(value) for value in cycle_durations if float(value) > 0]
    cycle_p75 = _percentile(cycles, 0.75) if cycles else 18.0
    cycle_p90 = _percentile(cycles, 0.90) if cycles else 24.0
    min_radius = _clamp(_round_even(cycle_p75), 12, 24)
    long_cycle = _clamp(
        _round_even(max(cycle_p90 * 2.0, min_radius * 2.0)),
        24,
        80,
    )

    sample_count = len(samples)
    window_ticks = _clamp(round(math.sqrt(sample_count) * 2.0), 12, 24)
    warmup_ticks = _clamp(window_ticks // 2, 6, window_ticks)
    candidate_samples = sum(_number(sample, "candidates") > 0 for sample in samples)
    candidate_ratio = candidate_samples / sample_count
    scarcity_ticks = 2 if candidate_ratio < 0.25 else 3
    cooldown_ticks = 2 if candidate_ratio < 0.25 else 3
    radius_step = _clamp(round(min_radius / 3), 4, 8)

    worker_ticks = sum(_number(sample, "workers") for sample in samples)
    deposited = sum(_number(sample, "deposited") for sample in samples)
    throughput = deposited / worker_ticks if worker_ticks else 0.0
    low_throughput = round(max(0.005, min(0.025, throughput * 2.0)), 4)
    healthy_throughput = round(
        max(0.02, min(0.06, max(low_throughput + 0.01, throughput * 8.0))),
        4,
    )

    attempts = sum(
        _number(sample, "harvest_successes")
        + _number(sample, "harvest_failures")
        for sample in samples
    )
    failures = sum(_number(sample, "harvest_failures") for sample in samples)
    failure_rate = failures / attempts if attempts else 0.0
    failure_limit = round(max(0.15, min(0.30, failure_rate + 0.10)), 3)
    full_ratio = sum(_number(sample, "storage_full") > 0 for sample in samples) / sample_count
    storage_limit = round(max(0.40, min(0.70, full_ratio + 0.40)), 2)
    outcome_events = int(
        sum(
            _number(sample, "harvest_successes")
            + _number(sample, "deposited")
            for sample in samples
        )
    )
    if outcome_events >= 20 and len(grouped[selected_scouts]) >= 12:
        confidence = "high"
    elif outcome_events >= 5 and len(grouped[selected_scouts]) >= 6:
        confidence = "medium"
    else:
        confidence = "low"

    ticks = [int(_number(sample, "tick")) for sample in samples]
    return PeaceEconomyTrainingResult(
        sample_count=sample_count,
        tick_start=min(ticks),
        tick_end=max(ticks),
        score=round(scout_scores[selected_scouts], 4),
        confidence=confidence,
        max_economy_scouts=selected_scouts,
        max_scout_bonus=max_scout_bonus,
        window_ticks=window_ticks,
        warmup_ticks=warmup_ticks,
        adjustment_cooldown_ticks=cooldown_ticks,
        radius_step=radius_step,
        min_resource_radius=min_radius,
        max_resource_radius=44,
        scarcity_ticks=scarcity_ticks,
        long_cycle_ticks=long_cycle,
        low_throughput_per_worker=low_throughput,
        healthy_throughput_per_worker=healthy_throughput,
        max_harvest_failure_rate=failure_limit,
        storage_full_ratio=storage_limit,
        worker_target=worker_target,
        selected_scout_samples=len(grouped[selected_scouts]),
        outcome_events=outcome_events,
    )


def apply_peace_training(
    document: Mapping[str, Any],
    result: PeaceEconomyTrainingResult,
    *,
    allow_confidence_downgrade: bool = False,
) -> dict[str, Any]:
    updated = json.loads(json.dumps(document))
    existing_training = updated.get("extensions", {}).get(
        "peace_economy_training", {}
    )
    existing_confidence = str(existing_training.get("confidence", "low")).lower()
    if (
        not allow_confidence_downgrade
        and CONFIDENCE_RANK.get(existing_confidence, 0)
        > CONFIDENCE_RANK[result.confidence]
    ):
        return updated

    updated["production"] = {
        "enabled": True,
        "order": [
            {"unit_type": "WORKER", "target": 17},
            {"unit_type": "VANGUARD", "target": 1},
            {"unit_type": "RANGER", "target": 1},
        ],
        "reserve_resources": 5,
        "max_population": 19,
        "after_plan": "hold",
    }
    updated["workers"]["max_economy_scouts"] = result.max_economy_scouts
    updated["adaptive_economy"].update(result.adaptive_values())
    updated["pacing"]["enabled"] = False
    updated["vanguards"].update(
        {
            "early_scout_radius": 44,
            "late_scout_radius": 44,
            "beacon_after_ticks": 100000,
            "beacon_min_defenders": 8,
        }
    )
    updated["rangers"].update(
        {"guard_numerator": 1, "guard_denominator": 1, "guard_radius": 3}
    )
    updated["core"]["migration_enabled"] = False
    updated.setdefault("extensions", {})["peace_economy_training"] = result.metadata()
    return updated


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Train peaceful late-game economy defaults from local telemetry"
    )
    parser.add_argument("--state", type=Path, default=STATE_FILE)
    parser.add_argument("--config", type=Path, default=CONFIG_FILE)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument(
        "--force",
        action="store_true",
        help="allow a lower-confidence result to replace the current model",
    )
    args = parser.parse_args()

    state = json.loads(args.state.read_text(encoding="utf-8"))
    result = train_peace_economy(
        state.get("economy_history", ()),
        state.get("cycle_durations", ()),
    )
    output: dict[str, Any] = {"training": result.metadata()}
    if args.apply:
        current = load_strategy_config(args.config, strict=True).to_dict()
        updated = apply_peace_training(
            current,
            result,
            allow_confidence_downgrade=args.force,
        )
        applied = updated != current
        output["applied"] = applied
        if applied:
            saved = save_strategy_config(updated, args.config)
            output["config"] = saved.to_dict()
        else:
            output["reason"] = "lower_confidence_than_current_model"
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

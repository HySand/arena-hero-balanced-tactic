import defaultConfig from "../../../config/strategy_config.json";

export const PYTHON_CONFIG_VERSION = 1;
export const DEFAULT_PYTHON_STRATEGY_CONFIG = defaultConfig;
export type PythonStrategyConfig = typeof defaultConfig;

export const CONFIG_SCHEMA = {
  version: PYTHON_CONFIG_VERSION,
  unit_types: ["WORKER", "VANGUARD", "RANGER"],
  unit_costs: { WORKER: 5, VANGUARD: 10, RANGER: 12 },
  after_plan_modes: ["adaptive", "hold"],
  defaults: defaultConfig,
  limits: {
    target: [0, 100],
    reserve_resources: [0, 10000],
    max_population: [1, 100],
    score: [0, 100],
    radius: [0, 500],
    ticks: [0, 100000],
    ratio_part: [1, 100],
    cover_gain_required: [0, 100],
  },
} as const;

export function parsePythonStrategyConfig(
  value: unknown,
): PythonStrategyConfig {
  const root = object(value, "configuration");
  exactKeys(
    root,
    [
      "version",
      "production",
      "threat",
      "workers",
      "adaptive_economy",
      "pacing",
      "vanguards",
      "rangers",
      "core",
      "extensions",
    ],
    "configuration",
  );
  integer(root.version, "configuration.version", 1, 1);

  const production = object(root.production, "production");
  exactKeys(
    production,
    ["enabled", "order", "reserve_resources", "max_population", "after_plan"],
    "production",
  );
  boolean(production.enabled, "production.enabled");
  const order = array(production.order, "production.order");
  if (order.length !== 3)
    throw new Error("production.order must contain three units");
  const seenUnits = new Set<string>();
  for (const [index, rawStep] of order.entries()) {
    const step = object(rawStep, `production.order[${index}]`);
    exactKeys(step, ["unit_type", "target"], `production.order[${index}]`);
    const unitType = string(
      step.unit_type,
      `production.order[${index}].unit_type`,
    );
    if (!isUnitType(unitType) || seenUnits.has(unitType)) {
      throw new Error("production.order must contain each unit type once");
    }
    seenUnits.add(unitType);
    integer(step.target, `production.order[${index}].target`, 0, 100);
  }
  if (seenUnits.size !== 3) {
    throw new Error(
      "production.order must contain WORKER, VANGUARD and RANGER",
    );
  }
  integer(
    production.reserve_resources,
    "production.reserve_resources",
    0,
    10000,
  );
  integer(production.max_population, "production.max_population", 1, 100);
  const afterPlan = string(production.after_plan, "production.after_plan");
  if (afterPlan !== "adaptive" && afterPlan !== "hold") {
    throw new Error("production.after_plan must be adaptive or hold");
  }

  const threat = object(root.threat, "threat");
  exactKeys(threat, ["guarded_score", "survival_score"], "threat");
  number(threat.guarded_score, "threat.guarded_score", 0, 100);
  number(threat.survival_score, "threat.survival_score", 0, 100);

  const workers = object(root.workers, "workers");
  exactKeys(
    workers,
    [
      "max_economy_scouts",
      "max_scouts_under_threat",
      "safe_scout_radius",
      "recovery_worker_floor",
    ],
    "workers",
  );
  integer(workers.max_economy_scouts, "workers.max_economy_scouts", 0, 100);
  integer(
    workers.max_scouts_under_threat,
    "workers.max_scouts_under_threat",
    0,
    100,
  );
  integer(workers.safe_scout_radius, "workers.safe_scout_radius", 0, 500);
  integer(
    workers.recovery_worker_floor,
    "workers.recovery_worker_floor",
    1,
    100,
  );

  const adaptive = object(root.adaptive_economy, "adaptive_economy");
  exactKeys(
    adaptive,
    [
      "enabled",
      "window_ticks",
      "warmup_ticks",
      "adjustment_cooldown_ticks",
      "radius_step",
      "min_resource_radius",
      "max_resource_radius",
      "scarcity_ticks",
      "long_cycle_ticks",
      "low_throughput_per_worker",
      "healthy_throughput_per_worker",
      "max_harvest_failure_rate",
      "storage_full_ratio",
      "max_scout_bonus",
      "worker_target_min",
      "worker_target_max",
    ],
    "adaptive_economy",
  );
  boolean(adaptive.enabled, "adaptive_economy.enabled");
  integer(adaptive.window_ticks, "adaptive_economy.window_ticks", 4, 64);
  integer(adaptive.warmup_ticks, "adaptive_economy.warmup_ticks", 0, 1000);
  integer(
    adaptive.adjustment_cooldown_ticks,
    "adaptive_economy.adjustment_cooldown_ticks",
    1,
    1000,
  );
  integer(adaptive.radius_step, "adaptive_economy.radius_step", 1, 20);
  integer(
    adaptive.min_resource_radius,
    "adaptive_economy.min_resource_radius",
    1,
    500,
  );
  integer(
    adaptive.max_resource_radius,
    "adaptive_economy.max_resource_radius",
    1,
    500,
  );
  integer(adaptive.scarcity_ticks, "adaptive_economy.scarcity_ticks", 1, 64);
  integer(
    adaptive.long_cycle_ticks,
    "adaptive_economy.long_cycle_ticks",
    1,
    1000,
  );
  number(
    adaptive.low_throughput_per_worker,
    "adaptive_economy.low_throughput_per_worker",
    0,
    100,
  );
  number(
    adaptive.healthy_throughput_per_worker,
    "adaptive_economy.healthy_throughput_per_worker",
    0,
    100,
  );
  number(
    adaptive.max_harvest_failure_rate,
    "adaptive_economy.max_harvest_failure_rate",
    0,
    1,
  );
  number(
    adaptive.storage_full_ratio,
    "adaptive_economy.storage_full_ratio",
    0,
    1,
  );
  integer(adaptive.max_scout_bonus, "adaptive_economy.max_scout_bonus", 0, 20);
  integer(
    adaptive.worker_target_min,
    "adaptive_economy.worker_target_min",
    0,
    100,
  );
  integer(
    adaptive.worker_target_max,
    "adaptive_economy.worker_target_max",
    0,
    100,
  );

  validatePacing(root.pacing);
  validateVanguards(root.vanguards);
  validateRangers(root.rangers);
  validateCore(root.core);
  object(root.extensions, "extensions");
  return structuredClone(value) as PythonStrategyConfig;
}

function validatePacing(value: unknown): void {
  const pacing = object(value, "pacing");
  exactKeys(
    pacing,
    [
      "enabled",
      "early_ticks",
      "mid_ticks",
      "early_population",
      "mid_population",
      "early_resource_radius",
      "mid_resource_radius",
      "late_resource_radius",
      "early_exploration_radius",
      "mid_exploration_radius",
      "late_exploration_radius",
      "early_worker_scouts",
      "mid_worker_scouts",
      "late_worker_scouts",
      "offense_enabled",
      "offense_after_ticks",
      "offense_min_resources",
      "offense_min_population",
      "offense_min_vanguards",
      "offense_min_rangers",
      "offense_min_defenders",
      "offense_radius",
    ],
    "pacing",
  );
  boolean(pacing.enabled, "pacing.enabled");
  boolean(pacing.offense_enabled, "pacing.offense_enabled");
  for (const key of [
    "early_ticks",
    "mid_ticks",
    "early_population",
    "mid_population",
    "early_resource_radius",
    "mid_resource_radius",
    "late_resource_radius",
    "early_exploration_radius",
    "mid_exploration_radius",
    "late_exploration_radius",
    "early_worker_scouts",
    "mid_worker_scouts",
    "late_worker_scouts",
    "offense_after_ticks",
    "offense_min_resources",
    "offense_min_population",
    "offense_min_vanguards",
    "offense_min_rangers",
    "offense_min_defenders",
    "offense_radius",
  ]) {
    integer(
      pacing[key],
      `pacing.${key}`,
      0,
      key.includes("radius") ? 500 : 100000,
    );
  }
}

function validateVanguards(value: unknown): void {
  const vanguards = object(value, "vanguards");
  exactKeys(
    vanguards,
    [
      "early_scout_radius",
      "late_scout_radius",
      "beacon_after_ticks",
      "beacon_min_defenders",
    ],
    "vanguards",
  );
  integer(vanguards.early_scout_radius, "vanguards.early_scout_radius", 0, 500);
  integer(vanguards.late_scout_radius, "vanguards.late_scout_radius", 0, 500);
  integer(
    vanguards.beacon_after_ticks,
    "vanguards.beacon_after_ticks",
    0,
    100000,
  );
  integer(
    vanguards.beacon_min_defenders,
    "vanguards.beacon_min_defenders",
    0,
    100,
  );
}

function validateRangers(value: unknown): void {
  const rangers = object(value, "rangers");
  exactKeys(
    rangers,
    ["guard_numerator", "guard_denominator", "guard_radius"],
    "rangers",
  );
  integer(rangers.guard_numerator, "rangers.guard_numerator", 1, 100);
  integer(rangers.guard_denominator, "rangers.guard_denominator", 1, 100);
  integer(rangers.guard_radius, "rangers.guard_radius", 0, 500);
}

function validateCore(value: unknown): void {
  const core = object(value, "core");
  exactKeys(
    core,
    [
      "migration_enabled",
      "migration_danger_score",
      "migration_start_ticks",
      "migration_cooldown_ticks",
      "migration_min_workers",
      "migration_min_vanguards",
      "migration_min_rangers",
      "worker_evacuation_radius",
      "cover_gain_required",
    ],
    "core",
  );
  boolean(core.migration_enabled, "core.migration_enabled");
  number(core.migration_danger_score, "core.migration_danger_score", 0, 100);
  integer(core.migration_start_ticks, "core.migration_start_ticks", 0, 100000);
  integer(
    core.migration_cooldown_ticks,
    "core.migration_cooldown_ticks",
    0,
    100000,
  );
  integer(core.migration_min_workers, "core.migration_min_workers", 0, 100);
  integer(core.migration_min_vanguards, "core.migration_min_vanguards", 0, 100);
  integer(core.migration_min_rangers, "core.migration_min_rangers", 0, 100);
  integer(
    core.worker_evacuation_radius,
    "core.worker_evacuation_radius",
    1,
    500,
  );
  number(core.cover_gain_required, "core.cover_gain_required", 0, 100);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
    throw new Error(`${field} contains unknown or missing fields`);
  }
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): void {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
}

function number(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${field} must be a number between ${minimum} and ${maximum}`,
    );
  }
}

function boolean(value: unknown, field: string): void {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function isUnitType(value: string): value is "WORKER" | "VANGUARD" | "RANGER" {
  return value === "WORKER" || value === "VANGUARD" || value === "RANGER";
}

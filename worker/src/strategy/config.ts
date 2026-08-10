import type { Posture } from "../contracts";

export interface StrategyConfig {
  computeBudgetMs: number;
  postureMinTicks: number;
  threatCoreRadius: number;
  reserveFraction: number;
  reserveResponseRadius: number;
  minControlRadius: number;
  safeControlRadius: number;
  maxControlRadius: number;
  safeExpansionInterval: number;
  baseSupportResponseTicks: number;
  softControlMaxOffset: number;
  workerScoutExtension: number;
  resourceScarcityScoutExtension: number;
  workerEscapeDanger: number;
  workerTargetSpacing: number;
  retreatPowerRatio: number;
  patrolRadius: number;
  contestRadius: number;
  attackRadius: number;
  resourceMemoryTicks: number;
  resourceReplenishTicks: number;
  migrationDryTicks: number;
  enemyLocalizedTicks: number;
  roleHysteresisTicks: number;
  safeWorkerShare: number;
  pressuredWorkerShare: number;
  minimumCombatCount: number;
  combatCountPerWorker: number;
  controlRadiusPerCombatUnit: number;
  minimumCombatPowerPerUnit: number;
  militaryPressureHorizonTicks: number;
  combatLossMemoryCap: number;
  combatLossDecayTicks: number;
  combatReplacementDeadlineTicks: number;
  postureTaskWeights: Record<Posture, Record<string, number>>;
}

export const DEFAULT_CONFIG: StrategyConfig = {
  computeBudgetMs: 2000,
  postureMinTicks: 4,
  threatCoreRadius: 6,
  reserveFraction: 0.25,
  reserveResponseRadius: 4,
  minControlRadius: 4,
  safeControlRadius: 7,
  maxControlRadius: 16,
  safeExpansionInterval: 4,
  baseSupportResponseTicks: 5,
  softControlMaxOffset: 3,
  workerScoutExtension: 3,
  resourceScarcityScoutExtension: 6,
  workerEscapeDanger: 0.5,
  workerTargetSpacing: 3,
  retreatPowerRatio: 1.15,
  patrolRadius: 6,
  contestRadius: 10,
  attackRadius: 12,
  resourceMemoryTicks: 32,
  resourceReplenishTicks: 4,
  migrationDryTicks: 12,
  enemyLocalizedTicks: 4,
  roleHysteresisTicks: 3,
  safeWorkerShare: 0.45,
  pressuredWorkerShare: 0.4,
  minimumCombatCount: 3,
  combatCountPerWorker: 1.2,
  controlRadiusPerCombatUnit: 4,
  minimumCombatPowerPerUnit: 3,
  militaryPressureHorizonTicks: 12,
  combatLossMemoryCap: 6,
  combatLossDecayTicks: 3,
  combatReplacementDeadlineTicks: 10,
  postureTaskWeights: {
    RECOVER: {
      economy: 1.5,
      defense: 1.5,
      contest: 0,
      attack: 0,
      explore: 0.4,
    },
    ECONOMY: {
      economy: 1.5,
      defense: 1,
      contest: 0.4,
      attack: 0.2,
      explore: 1.3,
    },
    HOLD: { economy: 1, defense: 1.5, contest: 0.7, attack: 0.3, explore: 0.7 },
    CONTEST: {
      economy: 0.8,
      defense: 1.2,
      contest: 1.5,
      attack: 0.7,
      explore: 0.4,
    },
    ATTACK: {
      economy: 0.6,
      defense: 1,
      contest: 0.8,
      attack: 1.6,
      explore: 0.2,
    },
    REGROUP: {
      economy: 1.1,
      defense: 1.6,
      contest: 0,
      attack: 0,
      explore: 0.2,
    },
  },
};

type NumericConfigKey = {
  [Key in keyof StrategyConfig]: StrategyConfig[Key] extends number
    ? Key
    : never;
}[keyof StrategyConfig];

interface NumericField {
  key: NumericConfigKey;
  label: string;
  min: number;
  max: number;
  step: number;
  group: "runtime" | "control" | "workers" | "combat" | "memory";
}

export const NUMERIC_CONFIG_FIELDS = [
  {
    key: "computeBudgetMs",
    label: "单 Tick 计算预算（毫秒）",
    min: 50,
    max: 10_000,
    step: 50,
    group: "runtime",
  },
  {
    key: "postureMinTicks",
    label: "姿态最短保持 Tick",
    min: 0,
    max: 100,
    step: 1,
    group: "runtime",
  },
  {
    key: "threatCoreRadius",
    label: "Core 威胁半径",
    min: 1,
    max: 30,
    step: 1,
    group: "combat",
  },
  {
    key: "reserveFraction",
    label: "预备队比例",
    min: 0,
    max: 1,
    step: 0.05,
    group: "combat",
  },
  {
    key: "reserveResponseRadius",
    label: "预备队响应半径",
    min: 1,
    max: 30,
    step: 1,
    group: "combat",
  },
  {
    key: "minControlRadius",
    label: "最小控制半径",
    min: 1,
    max: 50,
    step: 1,
    group: "control",
  },
  {
    key: "safeControlRadius",
    label: "安全控制半径",
    min: 1,
    max: 80,
    step: 1,
    group: "control",
  },
  {
    key: "maxControlRadius",
    label: "最大控制半径",
    min: 1,
    max: 120,
    step: 1,
    group: "control",
  },
  {
    key: "safeExpansionInterval",
    label: "安全扩张间隔",
    min: 1,
    max: 100,
    step: 1,
    group: "control",
  },
  {
    key: "baseSupportResponseTicks",
    label: "基础支援响应 Tick",
    min: 1,
    max: 100,
    step: 1,
    group: "control",
  },
  {
    key: "softControlMaxOffset",
    label: "软控制最大偏移",
    min: 0,
    max: 30,
    step: 1,
    group: "control",
  },
  {
    key: "workerScoutExtension",
    label: "工人探索扩展",
    min: 0,
    max: 50,
    step: 1,
    group: "workers",
  },
  {
    key: "resourceScarcityScoutExtension",
    label: "资源稀缺探索扩展",
    min: 0,
    max: 100,
    step: 1,
    group: "workers",
  },
  {
    key: "workerEscapeDanger",
    label: "工人逃生危险阈值",
    min: 0,
    max: 10,
    step: 0.1,
    group: "workers",
  },
  {
    key: "workerTargetSpacing",
    label: "工人目标间距",
    min: 0,
    max: 20,
    step: 1,
    group: "workers",
  },
  {
    key: "retreatPowerRatio",
    label: "撤退力量比",
    min: 0.1,
    max: 5,
    step: 0.05,
    group: "combat",
  },
  {
    key: "patrolRadius",
    label: "巡逻半径",
    min: 1,
    max: 80,
    step: 1,
    group: "control",
  },
  {
    key: "contestRadius",
    label: "争夺半径",
    min: 1,
    max: 100,
    step: 1,
    group: "control",
  },
  {
    key: "attackRadius",
    label: "进攻半径",
    min: 1,
    max: 120,
    step: 1,
    group: "combat",
  },
  {
    key: "resourceMemoryTicks",
    label: "资源记忆 Tick",
    min: 1,
    max: 1000,
    step: 1,
    group: "memory",
  },
  {
    key: "resourceReplenishTicks",
    label: "资源刷新 Tick",
    min: 1,
    max: 100,
    step: 1,
    group: "memory",
  },
  {
    key: "migrationDryTicks",
    label: "迁移空窗 Tick",
    min: 0,
    max: 200,
    step: 1,
    group: "memory",
  },
  {
    key: "enemyLocalizedTicks",
    label: "敌人定位保持 Tick",
    min: 0,
    max: 200,
    step: 1,
    group: "memory",
  },
  {
    key: "roleHysteresisTicks",
    label: "角色滞后 Tick",
    min: 0,
    max: 100,
    step: 1,
    group: "memory",
  },
  {
    key: "safeWorkerShare",
    label: "安全期工人占比",
    min: 0,
    max: 1,
    step: 0.05,
    group: "workers",
  },
  {
    key: "pressuredWorkerShare",
    label: "受压期工人占比",
    min: 0,
    max: 1,
    step: 0.05,
    group: "workers",
  },
  {
    key: "minimumCombatCount",
    label: "最低战斗单位数",
    min: 0,
    max: 100,
    step: 1,
    group: "combat",
  },
  {
    key: "combatCountPerWorker",
    label: "每工人战斗单位系数",
    min: 0,
    max: 10,
    step: 0.1,
    group: "combat",
  },
  {
    key: "controlRadiusPerCombatUnit",
    label: "每战斗单位控制半径",
    min: 0,
    max: 30,
    step: 0.5,
    group: "control",
  },
  {
    key: "minimumCombatPowerPerUnit",
    label: "单位最低战力",
    min: 0,
    max: 20,
    step: 0.5,
    group: "combat",
  },
  {
    key: "militaryPressureHorizonTicks",
    label: "军事压力保持 Tick",
    min: 0,
    max: 200,
    step: 1,
    group: "combat",
  },
  {
    key: "combatLossMemoryCap",
    label: "战损记忆上限",
    min: 0,
    max: 100,
    step: 1,
    group: "memory",
  },
  {
    key: "combatLossDecayTicks",
    label: "战损衰减 Tick",
    min: 1,
    max: 200,
    step: 1,
    group: "memory",
  },
  {
    key: "combatReplacementDeadlineTicks",
    label: "补兵截止 Tick",
    min: 1,
    max: 200,
    step: 1,
    group: "combat",
  },
] as const satisfies readonly NumericField[];

const POSTURES = [
  "RECOVER",
  "ECONOMY",
  "HOLD",
  "CONTEST",
  "ATTACK",
  "REGROUP",
] as const satisfies readonly Posture[];
const TASKS = ["economy", "defense", "contest", "attack", "explore"] as const;
const POSTURE_KEYS = new Set<string>(POSTURES);
const TASK_KEYS = new Set<string>(TASKS);
const CONFIG_KEYS = new Set<keyof StrategyConfig>([
  ...NUMERIC_CONFIG_FIELDS.map((field) => field.key),
  "postureTaskWeights",
]);

export const CONFIG_SCHEMA = {
  version: 1,
  defaults: DEFAULT_CONFIG,
  numericFields: NUMERIC_CONFIG_FIELDS,
  postureWeights: {
    postures: POSTURES,
    tasks: TASKS,
    min: 0,
    max: 5,
    step: 0.1,
  },
} as const;

export function parseStrategyConfig(value: unknown): StrategyConfig {
  if (!isRecord(value)) throw new Error("configuration must be a JSON object");
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key as keyof StrategyConfig)) {
      throw new Error(`unknown configuration field: ${key}`);
    }
  }

  const config = structuredClone(DEFAULT_CONFIG);
  for (const field of NUMERIC_CONFIG_FIELDS) {
    const candidate = value[field.key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
      throw new Error(`${field.key} must be a finite number`);
    }
    if (candidate < field.min || candidate > field.max) {
      throw new Error(
        `${field.key} must be between ${field.min} and ${field.max}`,
      );
    }
    config[field.key] = candidate;
  }

  const weights = value.postureTaskWeights;
  if (!isRecord(weights))
    throw new Error("postureTaskWeights must be an object");
  for (const posture of Object.keys(weights)) {
    if (!POSTURE_KEYS.has(posture)) {
      throw new Error(`unknown postureTaskWeights posture: ${posture}`);
    }
  }
  for (const posture of POSTURES) {
    const postureWeights = weights[posture];
    if (!isRecord(postureWeights)) {
      throw new Error(`postureTaskWeights.${posture} must be an object`);
    }
    for (const task of Object.keys(postureWeights)) {
      if (!TASK_KEYS.has(task)) {
        throw new Error(`unknown postureTaskWeights.${posture} task: ${task}`);
      }
    }
    for (const task of TASKS) {
      const candidate = postureWeights[task];
      if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
        throw new Error(
          `postureTaskWeights.${posture}.${task} must be a finite number`,
        );
      }
      if (candidate < 0 || candidate > 5) {
        throw new Error(
          `postureTaskWeights.${posture}.${task} must be between 0 and 5`,
        );
      }
      config.postureTaskWeights[posture][task] = candidate;
    }
  }

  if (
    config.minControlRadius > config.safeControlRadius ||
    config.safeControlRadius > config.maxControlRadius
  ) {
    throw new Error(
      "control radii must satisfy minControlRadius <= safeControlRadius <= maxControlRadius",
    );
  }
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

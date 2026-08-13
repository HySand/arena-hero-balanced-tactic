import type {
  CommandPlan,
  DecisionSummary,
  StrategyMemory,
  StrategyStatusSummary,
} from "../contracts";
import type { PythonStrategyMemory } from "./wire";
import { stableStringify } from "./wire";

export interface ShadowDifference {
  matched: boolean;
  unitActionDifferences: number;
  coreActionDifferent: boolean;
  summaryDifferent: boolean;
  memoryMetadataDifferent: boolean;
}

interface ShadowComparisonInput {
  tick: number;
  submittedPlan: CommandPlan;
  shadowPlan: CommandPlan;
  typescriptMemory: StrategyMemory;
  pythonMemory: PythonStrategyMemory;
  typescriptSummary: DecisionSummary;
  pythonSummary: StrategyStatusSummary;
}

export function compareStrategyResults(
  input: ShadowComparisonInput,
): ShadowDifference {
  const submittedUnits = input.submittedPlan.unit_actions ?? {};
  const shadowUnits = input.shadowPlan.unit_actions ?? {};
  const unitIds = new Set([
    ...Object.keys(submittedUnits),
    ...Object.keys(shadowUnits),
  ]);
  let unitActionDifferences = 0;
  for (const unitId of unitIds) {
    if (
      stableStringify(submittedUnits[unitId]) !==
      stableStringify(shadowUnits[unitId])
    ) {
      unitActionDifferences += 1;
    }
  }
  const coreActionDifferent =
    stableStringify(input.submittedPlan.core_action) !==
    stableStringify(input.shadowPlan.core_action);
  const summaryDifferent =
    stableStringify(summaryMetadata(input.typescriptSummary)) !==
    stableStringify(summaryMetadata(input.pythonSummary));
  const memoryMetadataDifferent =
    input.pythonMemory.last_tick !== input.tick ||
    input.pythonMemory.last_posture !== input.typescriptMemory.posture;
  return {
    matched:
      unitActionDifferences === 0 &&
      !coreActionDifferent &&
      !summaryDifferent &&
      !memoryMetadataDifferent,
    unitActionDifferences,
    coreActionDifferent,
    summaryDifferent,
    memoryMetadataDifferent,
  };
}

function summaryMetadata(summary: StrategyStatusSummary): object {
  return {
    posture: summary.posture,
    threatened: summary.threatened,
    retreating: summary.retreating,
    actions: summary.actions,
  };
}

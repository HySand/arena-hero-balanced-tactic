import type {
  CommandPlan,
  DecisionSummary,
  PlayerState,
  StrategyBackend,
  StrategyMemory,
  StrategyRuntimeStatus,
  StrategyStatusSummary,
} from "../contracts";
import type { PythonStrategyResult, PythonStrategyMemory } from "./wire";
import { compareStrategyResults } from "./shadow";

export interface TypeScriptStrategyResult {
  plan: CommandPlan;
  memory: StrategyMemory;
  summary: DecisionSummary;
}

export interface StrategyBackendOutcome {
  plan: CommandPlan;
  summary?: StrategyStatusSummary;
  typescriptMemory?: StrategyMemory;
  pythonMemory?: PythonStrategyMemory;
  status: StrategyRuntimeStatus;
}

interface StrategyBackendInput {
  backend: StrategyBackend;
  tick: number;
  state: PlayerState;
  runTypeScript(): TypeScriptStrategyResult;
  runPython(): Promise<PythonStrategyResult>;
  validate(plan: CommandPlan, state: PlayerState): boolean;
  fallback(): CommandPlan;
}

export async function runStrategyBackend(
  input: StrategyBackendInput,
): Promise<StrategyBackendOutcome> {
  if (input.backend === "typescript_primary") {
    try {
      const result = input.runTypeScript();
      const valid = input.validate(result.plan, input.state);
      return {
        plan: valid ? result.plan : input.fallback(),
        summary: result.summary,
        ...(valid ? { typescriptMemory: result.memory } : {}),
        status: {
          backend: input.backend,
          submittedBackend: valid ? "typescript" : "safe_fallback",
          strategyVersion: "typescript-rollback",
          contractVersion: "local",
          latencyMs: result.summary.planningMs,
          ...(valid ? { lastSuccessTick: input.tick } : {}),
          lastError: valid ? null : "INVALID_TYPESCRIPT_PLAN",
          fallbackUsed: !valid,
          consecutiveFailures: 0,
          blocked: false,
        },
      };
    } catch (error) {
      return fallbackOutcome(input, error);
    }
  }

  if (input.backend === "python_shadow") {
    let current: TypeScriptStrategyResult;
    try {
      current = input.runTypeScript();
    } catch (error) {
      return fallbackOutcome(input, error);
    }
    const currentValid = input.validate(current.plan, input.state);
    const submitted = currentValid ? current.plan : input.fallback();
    try {
      const shadow = await input.runPython();
      if (!input.validate(shadow.plan, input.state)) {
        throw new Error("INVALID_PYTHON_PLAN");
      }
      return {
        plan: submitted,
        summary: current.summary,
        ...(currentValid ? { typescriptMemory: current.memory } : {}),
        pythonMemory: shadow.memory,
        status: {
          backend: input.backend,
          submittedBackend: currentValid ? "typescript" : "safe_fallback",
          strategyVersion: shadow.strategyVersion,
          contractVersion: shadow.contractVersion,
          latencyMs: shadow.latencyMs ?? shadow.planningMs,
          lastSuccessTick: input.tick,
          lastError: currentValid ? null : "INVALID_TYPESCRIPT_PLAN",
          fallbackUsed: !currentValid,
          consecutiveFailures: 0,
          blocked: false,
          shadow: compareStrategyResults({
            tick: input.tick,
            submittedPlan: submitted,
            shadowPlan: shadow.plan,
            typescriptMemory: current.memory,
            pythonMemory: shadow.memory,
            typescriptSummary: current.summary,
            pythonSummary: shadow.summary,
          }),
        },
      };
    } catch (error) {
      return {
        plan: submitted,
        summary: current.summary,
        ...(currentValid ? { typescriptMemory: current.memory } : {}),
        status: {
          backend: input.backend,
          submittedBackend: currentValid ? "typescript" : "safe_fallback",
          strategyVersion: "python-economy-v1",
          contractVersion: "1",
          lastError: currentValid
            ? errorName(error)
            : `INVALID_TYPESCRIPT_PLAN;${errorName(error)}`,
          fallbackUsed: !currentValid,
          consecutiveFailures: 0,
          blocked: false,
        },
      };
    }
  }

  try {
    const result = await input.runPython();
    if (!input.validate(result.plan, input.state)) {
      throw new Error("INVALID_PYTHON_PLAN");
    }
    return {
      plan: result.plan,
      summary: result.summary,
      pythonMemory: result.memory,
      status: {
        backend: input.backend,
        submittedBackend: "python",
        strategyVersion: result.strategyVersion,
        contractVersion: result.contractVersion,
        latencyMs: result.latencyMs ?? result.planningMs,
        lastSuccessTick: input.tick,
        lastError: null,
        fallbackUsed: false,
        consecutiveFailures: 0,
        blocked: false,
      },
    };
  } catch (error) {
    return fallbackOutcome(input, error);
  }
}

export function applyStrategyStatusHistory(
  current: StrategyRuntimeStatus,
  previous: StrategyRuntimeStatus | undefined,
  tick: number,
  failureThreshold: number,
): StrategyRuntimeStatus {
  const compatiblePrevious =
    previous?.backend === current.backend ? previous : undefined;
  const failed = current.lastError !== null || current.fallbackUsed;
  const consecutiveFailures = failed
    ? (compatiblePrevious?.consecutiveFailures ?? 0) + 1
    : 0;
  const shadow = aggregateShadowStatus(
    current.shadow,
    compatiblePrevious?.shadow,
    tick,
  );
  const lastSuccessTick =
    current.lastSuccessTick ?? compatiblePrevious?.lastSuccessTick;
  return {
    ...current,
    consecutiveFailures,
    blocked: consecutiveFailures >= failureThreshold,
    ...(lastSuccessTick === undefined ? {} : { lastSuccessTick }),
    ...(shadow === undefined ? {} : { shadow }),
  };
}

function aggregateShadowStatus(
  current: StrategyRuntimeStatus["shadow"],
  previous: StrategyRuntimeStatus["shadow"],
  tick: number,
): StrategyRuntimeStatus["shadow"] {
  if (!current) return previous;
  const comparedTicks = (previous?.comparedTicks ?? 0) + 1;
  return {
    ...current,
    comparedTicks,
    matchedTicks: (previous?.matchedTicks ?? 0) + (current.matched ? 1 : 0),
    mismatchedTicks:
      (previous?.mismatchedTicks ?? 0) + (current.matched ? 0 : 1),
    cumulativeUnitActionDifferences:
      (previous?.cumulativeUnitActionDifferences ?? 0) +
      current.unitActionDifferences,
    cumulativeCoreActionDifferences:
      (previous?.cumulativeCoreActionDifferences ?? 0) +
      (current.coreActionDifferent ? 1 : 0),
    cumulativeSummaryDifferences:
      (previous?.cumulativeSummaryDifferences ?? 0) +
      (current.summaryDifferent ? 1 : 0),
    cumulativeMemoryMetadataDifferences:
      (previous?.cumulativeMemoryMetadataDifferences ?? 0) +
      (current.memoryMetadataDifferent ? 1 : 0),
    lastComparedTick: tick,
    ...(current.matched
      ? previous?.lastDifferenceTick === undefined
        ? {}
        : { lastDifferenceTick: previous.lastDifferenceTick }
      : { lastDifferenceTick: tick }),
  };
}

function fallbackOutcome(
  input: StrategyBackendInput,
  error: unknown,
): StrategyBackendOutcome {
  return {
    plan: input.fallback(),
    status: {
      backend: input.backend,
      submittedBackend: "safe_fallback",
      strategyVersion:
        input.backend === "typescript_primary"
          ? "typescript-rollback"
          : "python-economy-v1",
      contractVersion: input.backend === "typescript_primary" ? "local" : "1",
      lastError: errorName(error),
      fallbackUsed: true,
      consecutiveFailures: 0,
      blocked: false,
    },
  };
}

function errorName(error: unknown): string {
  if (error instanceof Error) {
    const code = "code" in error ? String(error.code) : undefined;
    return code ? `${code}:${error.message}` : error.message || error.name;
  }
  return "UnknownError";
}

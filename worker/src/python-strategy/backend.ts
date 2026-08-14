import type {
  CommandPlan,
  PlayerState,
  StrategyRuntimeStatus,
  StrategyStatusSummary,
} from "../contracts";
import type { PythonStrategyMemory, PythonStrategyResult } from "./wire";

export interface StrategyBackendOutcome {
  plan: CommandPlan;
  summary?: StrategyStatusSummary;
  pythonMemory?: PythonStrategyMemory;
  status: StrategyRuntimeStatus;
}

interface StrategyBackendInput {
  tick: number;
  state: PlayerState;
  runPython(): Promise<PythonStrategyResult>;
  validate(plan: CommandPlan, state: PlayerState): boolean;
  fallback(): CommandPlan;
}

export async function runStrategyBackend(
  input: StrategyBackendInput,
): Promise<StrategyBackendOutcome> {
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
        backend: "python_primary",
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
  _tick: number,
  failureThreshold: number,
): StrategyRuntimeStatus {
  const compatiblePrevious =
    previous?.backend === "python_primary" ? previous : undefined;
  const failed = current.lastError !== null || current.fallbackUsed;
  const consecutiveFailures = failed
    ? (compatiblePrevious?.consecutiveFailures ?? 0) + 1
    : 0;
  const lastSuccessTick =
    current.lastSuccessTick ?? compatiblePrevious?.lastSuccessTick;
  return {
    ...current,
    consecutiveFailures,
    blocked: consecutiveFailures >= failureThreshold,
    ...(lastSuccessTick === undefined ? {} : { lastSuccessTick }),
  };
}

function fallbackOutcome(
  input: StrategyBackendInput,
  error: unknown,
): StrategyBackendOutcome {
  return {
    plan: input.fallback(),
    status: {
      backend: "python_primary",
      submittedBackend: "safe_fallback",
      strategyVersion: "python-economy-v1",
      contractVersion: "1",
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
    return code ? code + ":" + error.message : error.message || error.name;
  }
  return "UnknownError";
}

import { describe, expect, it } from "vitest";

import type { StrategyRuntimeStatus } from "../src/contracts";
import { projectDashboardStatus } from "../src/dashboard-status";
import { DEFAULT_PYTHON_STRATEGY_CONFIG } from "../src/python-strategy/config";
import { emptyPythonMemory } from "../src/python-strategy/wire";
import { reconcileDashboardPhase } from "../src/router";
import { core, IDS, state, unit } from "./fixtures";

const strategy: StrategyRuntimeStatus = {
  backend: "python_primary",
  submittedBackend: "python",
  strategyVersion: "python-economy-v1",
  contractVersion: "1",
  lastError: null,
  fallbackUsed: false,
  consecutiveFailures: 0,
  blocked: false,
};

function statusAt(tick: number) {
  return projectDashboardStatus({
    desired: "running",
    phase: "open",
    authBlocked: false,
    tick,
    updatedAt: new Date().toISOString(),
    state: state([core(), unit(IDS.worker1, "WORKER", [0, 0])]),
    plan: { tick },
    memory: { ...emptyPythonMemory(), first_tick: 1 },
    config: DEFAULT_PYTHON_STRATEGY_CONFIG,
    strategy,
  });
}

describe("dashboard phase projection", () => {
  it("keeps a low-population economy in the early phase after the tick threshold", () => {
    const status = statusAt(500);

    expect(status.strategy_phase).toBe("EARLY");
    expect(status.resource_radius).toBe(
      DEFAULT_PYTHON_STRATEGY_CONFIG.pacing.early_resource_radius,
    );
  });

  it("uses the early phase before either readiness gate is met", () => {
    expect(statusAt(2).strategy_phase).toBe("EARLY");
  });

  it("corrects an advanced phase from an older State Durable Object", () => {
    const corrected = reconcileDashboardPhase(
      {
        strategy_phase: "LATE",
        population: 1,
        resource_radius: 40,
        exploration_radius: 42,
      },
      DEFAULT_PYTHON_STRATEGY_CONFIG,
    );

    expect(corrected).toMatchObject({
      strategy_phase: "EARLY",
      resource_radius:
        DEFAULT_PYTHON_STRATEGY_CONFIG.pacing.early_resource_radius,
      exploration_radius:
        DEFAULT_PYTHON_STRATEGY_CONFIG.pacing.early_exploration_radius,
    });
  });
});

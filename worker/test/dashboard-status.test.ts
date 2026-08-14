import { describe, expect, it } from "vitest";

import type { StrategyRuntimeStatus } from "../src/contracts";
import { projectDashboardStatus } from "../src/dashboard-status";
import { DEFAULT_PYTHON_STRATEGY_CONFIG } from "../src/python-strategy/config";
import { emptyPythonMemory } from "../src/python-strategy/wire";
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
    summary: {
      posture: "ECONOMY",
      threatened: false,
      retreating: false,
      actions: {},
      planningMs: 1,
      strategyPhase: "EARLY",
      resourceRadius: 10,
      explorationRadius: 12,
      offenseReady: false,
      resourceSpace: 5,
      resourceCapacity: 10,
    },
  });
}

describe("Python dashboard projection", () => {
  it("uses strategy values returned by Python", () => {
    const status = statusAt(500);

    expect(status.strategy_phase).toBe("EARLY");
    expect(status.resource_radius).toBe(10);
    expect(status.exploration_radius).toBe(12);
    expect(status.offense_ready).toBe(false);
    expect(status.resource_space).toBe(5);
    expect(status.resource_capacity).toBe(10);
  });

  it("does not reconstruct missing Python strategy values", () => {
    const status = projectDashboardStatus({
      desired: "running",
      phase: "open",
      authBlocked: false,
      tick: 500,
      updatedAt: new Date().toISOString(),
      state: state([core(), unit(IDS.worker1, "WORKER", [0, 0])]),
      plan: { tick: 500 },
      memory: { ...emptyPythonMemory(), first_tick: 1 },
      config: DEFAULT_PYTHON_STRATEGY_CONFIG,
      strategy,
    });

    expect(status.strategy_phase).toBe("UNKNOWN");
    expect(status.resource_radius).toBeNull();
    expect(status.exploration_radius).toBeNull();
  });
});

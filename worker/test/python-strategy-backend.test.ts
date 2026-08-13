import { describe, expect, it, vi } from "vitest";

import type { DecisionSummary, StrategyRuntimeStatus } from "../src/contracts";
import {
  applyStrategyStatusHistory,
  runStrategyBackend,
} from "../src/python-strategy/backend";
import type { PythonStrategyResult } from "../src/python-strategy/wire";
import { emptyMemory } from "../src/strategy/planner";
import { core, IDS, state, unit } from "./fixtures";

const currentState = state([
  core(),
  unit(IDS.worker1, "WORKER", [0, 0], { cargo: 1 }),
]);

const typescriptSummary: DecisionSummary = {
  posture: "ECONOMY",
  threatened: false,
  retreating: false,
  controlRadius: 4,
  supportResponseTicks: 5,
  reserveCount: 0,
  reserve: 0,
  militaryReady: false,
  minimumCombatCount: 2,
  minimumCombatPower: 6,
  combatCountDeficit: 2,
  combatPowerDeficit: 6,
  targetWorkerShare: 0.45,
  recentCombatLosses: 0,
  militaryPressureTicks: 0,
  actions: { WAIT: 1 },
  planningMs: 3,
};

function pythonResult(
  tick: number,
  overrides: Partial<PythonStrategyResult> = {},
): PythonStrategyResult {
  return {
    contractVersion: "1",
    strategyVersion: "python-economy-v1",
    configVersion: 1,
    agentId: "arena-hero-primary",
    tick,
    plan: { tick },
    memory: { version: 12, last_tick: tick, last_posture: "ECONOMY" },
    summary: {
      posture: "ECONOMY",
      threatened: false,
      retreating: false,
      actions: {},
      planningMs: 2,
    },
    planningMs: 2,
    latencyMs: 5,
    ...overrides,
  };
}

describe("strategy backend safety", () => {
  it("never invokes the TypeScript planner when Python primary fails", async () => {
    const runTypeScript = vi.fn(() => {
      throw new Error("must not run");
    });
    const fallback = vi.fn(() => ({
      tick: 7,
      unit_actions: { [IDS.worker1]: { type: "DEPOSIT" as const } },
    }));

    const outcome = await runStrategyBackend({
      backend: "python_primary",
      tick: 7,
      state: currentState,
      runTypeScript,
      runPython: () => Promise.reject(new Error("python unavailable")),
      validate: () => true,
      fallback,
    });

    expect(runTypeScript).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
    expect(outcome.status.submittedBackend).toBe("safe_fallback");
    expect(outcome.status.lastError).toContain("python unavailable");
    expect(outcome.pythonMemory).toBeUndefined();
  });

  it("does not advance Python memory after plan validation fails", async () => {
    const runTypeScript = vi.fn(() => ({
      plan: { tick: 8 },
      memory: emptyMemory(),
      summary: typescriptSummary,
    }));

    const outcome = await runStrategyBackend({
      backend: "python_primary",
      tick: 8,
      state: currentState,
      runTypeScript,
      runPython: () => Promise.resolve(pythonResult(8)),
      validate: () => false,
      fallback: () => ({ tick: 8 }),
    });

    expect(runTypeScript).not.toHaveBeenCalled();
    expect(outcome.status.submittedBackend).toBe("safe_fallback");
    expect(outcome.pythonMemory).toBeUndefined();
  });

  it("keeps the TypeScript submission when shadow Python fails", async () => {
    const typescriptMemory = emptyMemory();
    const typescriptPlan = { tick: 9, core_action: { type: "WAIT" as const } };

    const outcome = await runStrategyBackend({
      backend: "python_shadow",
      tick: 9,
      state: currentState,
      runTypeScript: () => ({
        plan: typescriptPlan,
        memory: typescriptMemory,
        summary: typescriptSummary,
      }),
      runPython: () => Promise.reject(new Error("shadow timeout")),
      validate: () => true,
      fallback: () => ({ tick: 9 }),
    });

    expect(outcome.plan).toEqual(typescriptPlan);
    expect(outcome.typescriptMemory).toBe(typescriptMemory);
    expect(outcome.pythonMemory).toBeUndefined();
    expect(outcome.status.submittedBackend).toBe("typescript");
    expect(outcome.status.lastError).toContain("shadow timeout");
  });

  it("compares plan, summary, and memory metadata in shadow mode", async () => {
    const outcome = await runStrategyBackend({
      backend: "python_shadow",
      tick: 10,
      state: currentState,
      runTypeScript: () => ({
        plan: { tick: 10 },
        memory: { ...emptyMemory(), posture: "ECONOMY" },
        summary: typescriptSummary,
      }),
      runPython: () =>
        Promise.resolve(
          pythonResult(10, {
            memory: {
              version: 12,
              last_tick: 9,
              last_posture: "SURVIVAL",
            },
            summary: {
              posture: "SURVIVAL",
              threatened: true,
              retreating: true,
              actions: {},
              planningMs: 2,
            },
          }),
        ),
      validate: () => true,
      fallback: () => ({ tick: 10 }),
    });

    expect(outcome.status.shadow).toMatchObject({
      matched: false,
      unitActionDifferences: 0,
      coreActionDifferent: false,
      summaryDifferent: true,
      memoryMetadataDifferent: true,
    });
  });
});

describe("strategy status history", () => {
  it("blocks after the configured consecutive failure threshold", () => {
    const base: StrategyRuntimeStatus = {
      backend: "python_primary",
      submittedBackend: "safe_fallback",
      strategyVersion: "python-economy-v1",
      contractVersion: "1",
      lastError: "TIMEOUT",
      fallbackUsed: true,
      consecutiveFailures: 0,
      blocked: false,
    };
    const first = applyStrategyStatusHistory(base, undefined, 10, 3);
    const second = applyStrategyStatusHistory(base, first, 11, 3);
    const third = applyStrategyStatusHistory(base, second, 12, 3);

    expect(first.consecutiveFailures).toBe(1);
    expect(second.blocked).toBe(false);
    expect(third.consecutiveFailures).toBe(3);
    expect(third.blocked).toBe(true);
  });

  it("accumulates bounded shadow comparison counters", () => {
    const current: StrategyRuntimeStatus = {
      backend: "python_shadow",
      submittedBackend: "typescript",
      strategyVersion: "python-economy-v1",
      contractVersion: "1",
      lastError: null,
      fallbackUsed: false,
      consecutiveFailures: 0,
      blocked: false,
      shadow: {
        matched: false,
        unitActionDifferences: 2,
        coreActionDifferent: true,
        summaryDifferent: true,
        memoryMetadataDifferent: true,
      },
    };
    const first = applyStrategyStatusHistory(current, undefined, 20, 3);
    const second = applyStrategyStatusHistory(
      {
        ...current,
        shadow: {
          matched: true,
          unitActionDifferences: 0,
          coreActionDifferent: false,
          summaryDifferent: false,
          memoryMetadataDifferent: false,
        },
      },
      first,
      21,
      3,
    );

    expect(second.shadow).toMatchObject({
      comparedTicks: 2,
      matchedTicks: 1,
      mismatchedTicks: 1,
      cumulativeUnitActionDifferences: 2,
      cumulativeCoreActionDifferences: 1,
      cumulativeSummaryDifferences: 1,
      cumulativeMemoryMetadataDifferences: 1,
      lastComparedTick: 21,
      lastDifferenceTick: 20,
    });
  });
});

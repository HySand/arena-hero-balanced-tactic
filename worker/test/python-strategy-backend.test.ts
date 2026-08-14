import { describe, expect, it, vi } from "vitest";

import type { StrategyRuntimeStatus } from "../src/contracts";
import {
  applyStrategyStatusHistory,
  runStrategyBackend,
} from "../src/python-strategy/backend";
import type { PythonStrategyResult } from "../src/python-strategy/wire";
import { core, IDS, state, unit } from "./fixtures";

const currentState = state([
  core(),
  unit(IDS.worker1, "WORKER", [0, 0], { cargo: 1 }),
]);

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
  it("uses the safe fallback when Python primary fails", async () => {
    const fallback = vi.fn(() => ({
      tick: 7,
      unit_actions: { [IDS.worker1]: { type: "DEPOSIT" as const } },
    }));

    const outcome = await runStrategyBackend({
      tick: 7,
      state: currentState,
      runPython: () => Promise.reject(new Error("python unavailable")),
      validate: () => true,
      fallback,
    });

    expect(fallback).toHaveBeenCalledOnce();
    expect(outcome.status.submittedBackend).toBe("safe_fallback");
    expect(outcome.status.lastError).toContain("python unavailable");
    expect(outcome.pythonMemory).toBeUndefined();
  });

  it("does not advance Python memory after plan validation fails", async () => {
    const outcome = await runStrategyBackend({
      tick: 8,
      state: currentState,
      runPython: () => Promise.resolve(pythonResult(8)),
      validate: () => false,
      fallback: () => ({ tick: 8 }),
    });

    expect(outcome.status.submittedBackend).toBe("safe_fallback");
    expect(outcome.pythonMemory).toBeUndefined();
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
    const second = applyStrategyStatusHistory(
      { ...base, consecutiveFailures: 0 },
      first,
      11,
      3,
    );
    const third = applyStrategyStatusHistory(
      { ...base, consecutiveFailures: 0 },
      second,
      12,
      3,
    );

    expect(first.consecutiveFailures).toBe(1);
    expect(second.blocked).toBe(false);
    expect(third.consecutiveFailures).toBe(3);
    expect(third.blocked).toBe(true);
  });
});

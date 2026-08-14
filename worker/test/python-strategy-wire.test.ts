import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { requestPythonStrategy } from "../src/python-strategy/client";
import {
  buildPythonStrategyRequest,
  decodePythonStrategyResponse,
  emptyPythonMemory,
  type PythonStrategyMemory,
  type PythonStrategyRequest,
  type PythonStrategyResult,
  PythonStrategyServiceError,
  stableStringify,
} from "../src/python-strategy/wire";
import { core, IDS, state, unit } from "./fixtures";

const sharedFixture = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../fixtures/python_strategy_tick_1.json",
    ),
    "utf8",
  ),
) as {
  request: PythonStrategyRequest;
  expected: {
    plan: PythonStrategyResult["plan"];
    memory: PythonStrategyMemory;
    summary: Omit<PythonStrategyResult["summary"], "planningMs">;
  };
};

describe("Python strategy wire contract", () => {
  it("matches the shared Python request, plan, memory, and summary fixture", () => {
    const request = buildPythonStrategyRequest(
      "arena-hero-primary",
      1,
      state([core()], { resources: 5 }),
      emptyPythonMemory(),
    );

    expect(request).toEqual(sharedFixture.request);

    const decoded = decodePythonStrategyResponse(
      stableStringify({
        contract_version: request.contract_version,
        strategy_version: request.strategy_version,
        config_version: request.config_version,
        agent_id: request.agent_id,
        tick: request.tick,
        plan: sharedFixture.expected.plan,
        memory: sharedFixture.expected.memory,
        summary: sharedFixture.expected.summary,
        planning_ms: 0,
      }),
      request,
    );

    expect(decoded.plan).toEqual(sharedFixture.expected.plan);
    expect(decoded.memory).toEqual(sharedFixture.expected.memory);
    expect(decoded.summary).toEqual({
      ...sharedFixture.expected.summary,
      planningMs: 0,
    });
  });

  it("derives the same capacity and dynamic costs as the Python SDK", () => {
    const request = buildPythonStrategyRequest(
      "arena-hero-primary",
      4,
      state([core()], { resources: 7, population: 20 }),
      emptyPythonMemory(),
    );

    expect(request.state.resource_space).toBe(93);
    expect(request.state.unit_costs).toEqual({
      WORKER: 7,
      VANGUARD: 13,
      RANGER: 16,
    });
  });

  it("accepts cell-only shots, heals, and Core self destruction", () => {
    const request = buildPythonStrategyRequest(
      "arena-hero-primary",
      5,
      state([core(), unit(IDS.ranger, "RANGER", [0, 1])]),
      emptyPythonMemory(),
    );
    const response = {
      contract_version: "1",
      strategy_version: "python-economy-v1",
      config_version: 1,
      agent_id: "arena-hero-primary",
      tick: 5,
      plan: {
        tick: 5,
        unit_actions: {
          [IDS.ranger]: { type: "SHOOT", expected_cell: [0, 3] },
        },
        core_action: { type: "SELF_DESTRUCT" },
      },
      memory: { version: 12 },
      summary: {
        posture: "SURVIVAL",
        threatened: true,
        retreating: true,
        actions: { SHOOT: 1, SELF_DESTRUCT: 1 },
      },
      planning_ms: 4.5,
    };

    const decoded = decodePythonStrategyResponse(
      stableStringify(response),
      request,
    );

    expect(decoded.plan).toEqual(response.plan);
    expect(decoded.summary.posture).toBe("SURVIVAL");
    expect(decoded.summary.planningMs).toBe(4.5);
  });

  it("rejects shots without expected_cell and mismatched ticks", () => {
    const request = buildPythonStrategyRequest(
      "arena-hero-primary",
      6,
      state([core(), unit(IDS.ranger, "RANGER", [0, 1])]),
      emptyPythonMemory(),
    );
    const response = {
      contract_version: "1",
      strategy_version: "python-economy-v1",
      config_version: 1,
      agent_id: "arena-hero-primary",
      tick: 6,
      plan: {
        tick: 6,
        unit_actions: {
          [IDS.ranger]: { type: "SHOOT", target_id: IDS.enemyWorker },
        },
      },
      memory: { version: 12 },
      summary: {
        posture: "ECONOMY",
        threatened: false,
        retreating: false,
        actions: { SHOOT: 1 },
      },
      planning_ms: 1,
    };

    expect(() =>
      decodePythonStrategyResponse(stableStringify(response), request),
    ).toThrow(PythonStrategyServiceError);
    expect(() =>
      decodePythonStrategyResponse(
        stableStringify({
          ...response,
          tick: 7,
          plan: { ...response.plan, tick: 7 },
        }),
        request,
      ),
    ).toThrow("tick mismatch");
  });

  it("maps a slow binding call to a retryable timeout", async () => {
    const request = buildPythonStrategyRequest(
      "arena-hero-primary",
      7,
      state([core()]),
      emptyPythonMemory(),
    );
    const fetcher = {
      fetch: () => new Promise<Response>(() => undefined),
    };

    await expect(
      requestPythonStrategy(fetcher, request, 1),
    ).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
  });
});

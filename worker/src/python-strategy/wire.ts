import type {
  CommandPlan,
  CoreAction,
  PlayerState,
  Position,
  StrategyStatusSummary,
  UnitAction,
  UnitType,
} from "../contracts";
import {
  DEFAULT_PYTHON_STRATEGY_CONFIG,
  PYTHON_CONFIG_VERSION,
  type PythonStrategyConfig,
} from "./config";

export const PYTHON_CONTRACT_VERSION = "1";
export const PYTHON_STRATEGY_VERSION = "python-economy-v1";
export const PYTHON_MEMORY_VERSION = 12;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type PythonStrategyMemory = Record<string, unknown> & { version: 12 };

export interface PythonStrategyRequest {
  contract_version: typeof PYTHON_CONTRACT_VERSION;
  strategy_version: typeof PYTHON_STRATEGY_VERSION;
  config_version: typeof PYTHON_CONFIG_VERSION;
  agent_id: string;
  tick: number;
  state: PythonStrategyState;
  memory: PythonStrategyMemory;
  config: PythonStrategyConfig;
  options: {
    profile: "economy" | "balanced";
    safety_enabled: boolean;
    core_migration_enabled: boolean;
  };
}

export interface PythonStrategyState extends PlayerState {
  resource_space: number;
  unit_costs: Record<UnitType, number>;
}

export interface PythonStrategyResult {
  contractVersion: string;
  strategyVersion: string;
  configVersion: number;
  agentId: string;
  tick: number;
  plan: CommandPlan;
  memory: PythonStrategyMemory;
  summary: StrategyStatusSummary;
  planningMs: number;
  latencyMs?: number;
}

export class PythonStrategyServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PythonStrategyServiceError";
  }
}

export function emptyPythonMemory(): PythonStrategyMemory {
  return { version: PYTHON_MEMORY_VERSION };
}

export function isPythonStrategyMemory(
  value: unknown,
): value is PythonStrategyMemory {
  return isRecord(value) && value.version === PYTHON_MEMORY_VERSION;
}

function unitCost(unitType: UnitType, population: number): number {
  const base = { WORKER: 5, VANGUARD: 10, RANGER: 12 }[unitType];
  const exponent = population < 20 ? 0 : Math.floor((population - 20) / 5) + 1;
  const numerator = base * 13 ** exponent;
  const denominator = 10 ** exponent;
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

export function buildPythonStrategyRequest(
  agentId: string,
  tick: number,
  state: PlayerState,
  memory: PythonStrategyMemory,
  config: PythonStrategyConfig = DEFAULT_PYTHON_STRATEGY_CONFIG,
): PythonStrategyRequest {
  const capacity = Math.max(10, state.population * 5);
  return {
    contract_version: PYTHON_CONTRACT_VERSION,
    strategy_version: PYTHON_STRATEGY_VERSION,
    config_version: PYTHON_CONFIG_VERSION,
    agent_id: agentId,
    tick,
    state: {
      ...state,
      resource_space: Math.max(0, capacity - state.resources),
      unit_costs: {
        WORKER: unitCost("WORKER", state.population),
        VANGUARD: unitCost("VANGUARD", state.population),
        RANGER: unitCost("RANGER", state.population),
      },
    },
    memory,
    config,
    options: {
      profile: "economy",
      safety_enabled: true,
      core_migration_enabled: true,
    },
  };
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value)) ?? "undefined";
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

export function decodePythonStrategyResponse(
  raw: string,
  expected: Pick<PythonStrategyRequest, "agent_id" | "tick" | "config_version">,
): PythonStrategyResult {
  if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) {
    throw new PythonStrategyServiceError(
      "RESPONSE_TOO_LARGE",
      "Python strategy response exceeds the configured limit",
      false,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new PythonStrategyServiceError(
      "INVALID_JSON",
      "Python strategy returned invalid JSON",
      false,
    );
  }
  const data = record(parsed, "response");
  if (typeof data.error_code === "string") {
    if (
      typeof data.retryable !== "boolean" ||
      typeof data.detail !== "string"
    ) {
      throw new PythonStrategyServiceError(
        "INVALID_ERROR_RESPONSE",
        "Python strategy returned an invalid error response",
        false,
      );
    }
    throw new PythonStrategyServiceError(
      data.error_code,
      data.detail,
      data.retryable,
    );
  }
  exactKeys(
    data,
    [
      "contract_version",
      "strategy_version",
      "config_version",
      "agent_id",
      "tick",
      "plan",
      "memory",
      "summary",
      "planning_ms",
    ],
    "response",
  );
  if (data.contract_version !== PYTHON_CONTRACT_VERSION) {
    throw contractError("contract_version mismatch");
  }
  if (data.strategy_version !== PYTHON_STRATEGY_VERSION) {
    throw contractError("strategy_version mismatch");
  }
  if (data.config_version !== expected.config_version) {
    throw contractError("config_version mismatch");
  }
  if (data.agent_id !== expected.agent_id) {
    throw contractError("agent_id mismatch");
  }
  if (data.tick !== expected.tick) throw contractError("tick mismatch");
  const memory = record(data.memory, "memory");
  if (memory.version !== PYTHON_MEMORY_VERSION) {
    throw contractError("memory version mismatch");
  }
  const planningMs = finiteNumber(data.planning_ms, "planning_ms", 0);
  return {
    contractVersion: PYTHON_CONTRACT_VERSION,
    strategyVersion: PYTHON_STRATEGY_VERSION,
    configVersion: PYTHON_CONFIG_VERSION,
    agentId: expected.agent_id,
    tick: expected.tick,
    plan: decodePlan(data.plan, expected.tick),
    memory: memory as PythonStrategyMemory,
    summary: decodeSummary(data.summary, planningMs),
    planningMs,
  };
}

function decodeSummary(
  value: unknown,
  planningMs: number,
): StrategyStatusSummary {
  const data = record(value, "summary");
  if (
    !isPosture(data.posture) ||
    typeof data.threatened !== "boolean" ||
    typeof data.retreating !== "boolean"
  ) {
    throw contractError("summary fields are invalid");
  }
  const rawActions = record(data.actions, "summary.actions");
  const actions: Record<string, number> = {};
  for (const [name, count] of Object.entries(rawActions)) {
    actions[name] = finiteNumber(count, `summary.actions.${name}`, 0);
  }
  return {
    posture: data.posture,
    threatened: data.threatened,
    retreating: data.retreating,
    actions,
    planningMs,
  };
}

function decodePlan(value: unknown, tick: number): CommandPlan {
  const data = record(value, "plan");
  const allowed = new Set(["tick", "unit_actions", "core_action"]);
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) throw contractError(`unknown plan field: ${key}`);
  }
  if (data.tick !== tick) throw contractError("plan tick mismatch");
  const plan: CommandPlan = { tick };
  if (data.unit_actions !== undefined) {
    const rawActions = record(data.unit_actions, "plan.unit_actions");
    const unitActions: Record<string, UnitAction> = {};
    for (const [unitId, rawAction] of Object.entries(rawActions)) {
      if (!UUID.test(unitId))
        throw contractError("unit action key is not a UUID");
      unitActions[unitId] = decodeUnitAction(rawAction);
    }
    plan.unit_actions = unitActions;
  }
  if (data.core_action !== undefined && data.core_action !== null) {
    plan.core_action = decodeCoreAction(data.core_action);
  }
  return plan;
}

function decodeUnitAction(value: unknown): UnitAction {
  const data = record(value, "unit action");
  switch (data.type) {
    case "WAIT":
    case "HARVEST":
    case "DEPOSIT":
    case "HEAL":
    case "PICKUP_BEACON":
    case "DROP_BEACON":
    case "SELF_DESTRUCT":
      exactKeys(data, ["type"], "unit action");
      return { type: data.type };
    case "MOVE":
    case "SWEEP":
      exactKeys(data, ["type", "direction"], "unit action");
      return { type: data.type, direction: direction(data.direction) };
    case "SHOOT": {
      const allowed = new Set(["type", "target_id", "expected_cell"]);
      for (const key of Object.keys(data)) {
        if (!allowed.has(key))
          throw contractError(`unknown SHOOT field: ${key}`);
      }
      const targetId = data.target_id;
      if (
        targetId !== undefined &&
        (typeof targetId !== "string" || !UUID.test(targetId))
      ) {
        throw contractError("SHOOT target_id is invalid");
      }
      const expectedCell = position(data.expected_cell, "expected_cell");
      return {
        type: "SHOOT",
        expected_cell: expectedCell,
        ...(targetId === undefined ? {} : { target_id: targetId }),
      };
    }
    default:
      throw contractError("unknown unit action type");
  }
}

function decodeCoreAction(value: unknown): CoreAction {
  const data = record(value, "core action");
  switch (data.type) {
    case "WAIT":
    case "REPAIR_SHIELD":
    case "HEAL":
    case "CANCEL_MOVE":
    case "PICKUP_BEACON":
    case "DROP_BEACON":
    case "SELF_DESTRUCT":
      exactKeys(data, ["type"], "core action");
      return { type: data.type };
    case "START_MOVE":
      exactKeys(data, ["type", "direction"], "core action");
      return { type: "START_MOVE", direction: direction(data.direction) };
    case "SPAWN":
      exactKeys(data, ["type", "unit_type"], "core action");
      if (
        data.unit_type !== "WORKER" &&
        data.unit_type !== "VANGUARD" &&
        data.unit_type !== "RANGER"
      ) {
        throw contractError("SPAWN unit_type is invalid");
      }
      return { type: "SPAWN", unit_type: data.unit_type };
    default:
      throw contractError("unknown core action type");
  }
}

function direction(value: unknown): "UP" | "DOWN" | "LEFT" | "RIGHT" {
  if (
    value !== "UP" &&
    value !== "DOWN" &&
    value !== "LEFT" &&
    value !== "RIGHT"
  ) {
    throw contractError("direction is invalid");
  }
  return value;
}

function isPosture(value: unknown): value is StrategyStatusSummary["posture"] {
  return (
    value === "RECOVER" ||
    value === "ECONOMY" ||
    value === "HOLD" ||
    value === "CONTEST" ||
    value === "ATTACK" ||
    value === "REGROUP" ||
    value === "GUARDED" ||
    value === "SURVIVAL" ||
    value === "RESPAWNING"
  );
}

function position(value: unknown, name: string): Position {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isSafeInteger(value[0]) ||
    !Number.isSafeInteger(value[1])
  ) {
    throw contractError(`${name} is invalid`);
  }
  return [value[0] as number, value[1] as number];
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw contractError(`${name} must be an object`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const expected = new Set(keys);
  if (
    Object.keys(value).length !== expected.size ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    throw contractError(`${name} keys are invalid`);
  }
}

function finiteNumber(value: unknown, name: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw contractError(`${name} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contractError(message: string): PythonStrategyServiceError {
  return new PythonStrategyServiceError("CONTRACT_ERROR", message, false);
}

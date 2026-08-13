import type {
  CommandPlan,
  CoreAction,
  CoreObject,
  Direction,
  PlayerState,
  Position,
  UnitAction,
  UnitObject,
  UnitType,
} from "./contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL_VERSION = 1;
const COMMAND_TTL_TICKS = 2;

export type ManualControlTarget = "UNIT" | "CORE";
export type ManualControlAction =
  | "MOVE"
  | "WAIT"
  | "HARVEST"
  | "DEPOSIT"
  | "SWEEP"
  | "SHOOT"
  | "HEAL"
  | "PICKUP_BEACON"
  | "DROP_BEACON"
  | "SELF_DESTRUCT"
  | "SPAWN"
  | "REPAIR_SHIELD"
  | "START_MOVE"
  | "CANCEL_MOVE";

export interface ManualControlRequest {
  target_type: ManualControlTarget;
  target_id: string;
  action: ManualControlAction;
  direction?: Direction;
  unit_type?: UnitType;
  enemy_id?: string;
  expected_cell?: Position;
  observed_tick: number;
}

export interface StoredManualControl extends ManualControlRequest {
  version: typeof CONTROL_VERSION;
  command_id: string;
  created_at: string;
  expires_tick: number;
}

export interface ControlReceipt {
  command_id: string;
  target_type: ManualControlTarget;
  target_id: string;
  action: ManualControlAction;
  observed_tick: number;
  applied_tick: number;
  status: "applied" | "rejected" | "expired" | "superseded";
  message: string;
  updated_at: string;
}

export function parseManualControlRequest(
  value: unknown,
): ManualControlRequest {
  const data = record(value);
  const allowed = new Set([
    "target_type",
    "target_id",
    "action",
    "direction",
    "unit_type",
    "enemy_id",
    "expected_cell",
    "observed_tick",
  ]);
  if (Object.keys(data).some((key) => !allowed.has(key))) {
    throw new Error("unknown control fields");
  }
  if (data.target_type !== "UNIT" && data.target_type !== "CORE") {
    throw new Error("target_type must be UNIT or CORE");
  }
  const targetId = uuid(data.target_id, "target_id");
  const action = data.action;
  if (!isManualControlAction(action)) {
    throw new Error("unknown control action");
  }
  const observedTick = data.observed_tick;
  if (
    typeof observedTick !== "number" ||
    !Number.isSafeInteger(observedTick) ||
    observedTick < 1
  ) {
    throw new Error("observed_tick must be a positive integer");
  }
  const result: ManualControlRequest = {
    target_type: data.target_type,
    target_id: targetId,
    action,
    observed_tick: observedTick,
  };
  if (requiresDirection(action)) {
    if (!isDirection(data.direction)) {
      throw new Error("direction is required for this action");
    }
    result.direction = data.direction;
  } else if (data.direction !== undefined) {
    throw new Error("direction is not valid for this action");
  }
  if (action === "SPAWN") {
    if (data.target_type !== "CORE" || !isUnitType(data.unit_type)) {
      throw new Error("SPAWN requires a Core and valid unit_type");
    }
    result.unit_type = data.unit_type;
  } else if (data.unit_type !== undefined) {
    throw new Error("unit_type is only valid for SPAWN");
  }
  if (action === "SHOOT") {
    if (data.target_type !== "UNIT") {
      throw new Error("SHOOT requires a Unit target");
    }
    result.enemy_id = uuid(data.enemy_id, "enemy_id");
    result.expected_cell = position(data.expected_cell, "expected_cell");
  } else if (data.enemy_id !== undefined || data.expected_cell !== undefined) {
    throw new Error("shoot fields are only valid for SHOOT");
  }
  return result;
}

export function enqueueManualControl(
  value: unknown,
  commandId: string,
  createdAt = new Date().toISOString(),
): StoredManualControl {
  const request = parseManualControlRequest(value);
  if (!UUID.test(commandId)) throw new Error("command_id must be a UUID");
  return {
    ...request,
    version: CONTROL_VERSION,
    command_id: commandId,
    created_at: createdAt,
    expires_tick: request.observed_tick + COMMAND_TTL_TICKS,
  };
}

export function applyManualControls(
  tick: number,
  state: PlayerState,
  plan: CommandPlan,
  pending: readonly unknown[],
): { plan: CommandPlan; receipts: ControlReceipt[] } {
  const receipts: ControlReceipt[] = [];
  const eligible = new Map<string, StoredManualControl>();
  const commands = pending
    .map((value) => parseStoredManualControl(value))
    .filter((value): value is StoredManualControl => value !== undefined)
    .sort((left, right) =>
      `${left.created_at}:${left.command_id}`.localeCompare(
        `${right.created_at}:${right.command_id}`,
      ),
    );

  for (const command of commands) {
    if (tick > command.expires_tick) {
      receipts.push(receipt(command, tick, "expired", "command expired"));
      continue;
    }
    if (tick < command.observed_tick) continue;
    const key = `${command.target_type}:${command.target_id}`;
    const previous = eligible.get(key);
    if (previous) {
      receipts.push(
        receipt(previous, tick, "superseded", "superseded by a newer command"),
      );
    }
    eligible.set(key, command);
  }

  const nextPlan: CommandPlan = {
    ...plan,
    ...(plan.unit_actions ? { unit_actions: { ...plan.unit_actions } } : {}),
  };
  for (const command of eligible.values()) {
    const target = findTarget(state, command);
    const action = target ? commandAction(command, target) : undefined;
    if (!target || !action) {
      receipts.push(
        receipt(
          command,
          tick,
          "rejected",
          "target or action is no longer valid",
        ),
      );
      continue;
    }
    if (command.target_type === "CORE") {
      nextPlan.core_action = action as CoreAction;
    } else {
      nextPlan.unit_actions = {
        ...(nextPlan.unit_actions ?? {}),
        [command.target_id]: action as UnitAction,
      };
    }
    receipts.push(receipt(command, tick, "applied", "manual command applied"));
  }
  return { plan: nextPlan, receipts };
}

function commandAction(
  command: StoredManualControl,
  target: CoreObject | UnitObject,
): CoreAction | UnitAction | undefined {
  if (target.kind === "CORE") {
    if (
      target.state === "MOVING" &&
      !["WAIT", "CANCEL_MOVE"].includes(command.action)
    ) {
      return undefined;
    }
    if (command.target_type !== "CORE") return undefined;
    switch (command.action) {
      case "WAIT":
      case "REPAIR_SHIELD":
      case "HEAL":
      case "PICKUP_BEACON":
      case "DROP_BEACON":
      case "SELF_DESTRUCT":
      case "CANCEL_MOVE":
        return { type: command.action } as CoreAction;
      case "SPAWN":
        return command.unit_type
          ? { type: "SPAWN", unit_type: command.unit_type }
          : undefined;
      case "START_MOVE":
        return command.direction
          ? { type: "START_MOVE", direction: command.direction }
          : undefined;
      default:
        return undefined;
    }
  }
  if (command.target_type !== "UNIT") return undefined;
  const unitType = target.unit_type;
  switch (command.action) {
    case "WAIT":
    case "HEAL":
    case "PICKUP_BEACON":
    case "DROP_BEACON":
    case "SELF_DESTRUCT":
      return { type: command.action } as UnitAction;
    case "MOVE":
      return command.direction
        ? { type: "MOVE", direction: command.direction }
        : undefined;
    case "HARVEST":
    case "DEPOSIT":
      return unitType === "WORKER" ? { type: command.action } : undefined;
    case "SWEEP":
      return unitType === "VANGUARD" && command.direction
        ? { type: "SWEEP", direction: command.direction }
        : undefined;
    case "SHOOT":
      return unitType === "RANGER" && command.expected_cell
        ? {
            type: "SHOOT",
            ...(command.enemy_id ? { target_id: command.enemy_id } : {}),
            expected_cell: command.expected_cell,
          }
        : undefined;
    default:
      return undefined;
  }
}

function findTarget(
  state: PlayerState,
  command: StoredManualControl,
): CoreObject | UnitObject | undefined {
  return state.objects.find(
    (object): object is CoreObject | UnitObject =>
      (object.kind === "CORE" || object.kind === "UNIT") &&
      object.controlled &&
      object.id === command.target_id &&
      ((command.target_type === "CORE" && object.kind === "CORE") ||
        (command.target_type === "UNIT" && object.kind === "UNIT")),
  );
}

export function parseStoredManualControl(
  value: unknown,
): StoredManualControl | undefined {
  try {
    const data = record(value);
    if (
      data.version !== CONTROL_VERSION ||
      typeof data.command_id !== "string" ||
      !UUID.test(data.command_id)
    ) {
      return undefined;
    }
    const request = parseManualControlRequest({
      target_type: data.target_type,
      target_id: data.target_id,
      action: data.action,
      ...(data.direction === undefined ? {} : { direction: data.direction }),
      ...(data.unit_type === undefined ? {} : { unit_type: data.unit_type }),
      ...(data.enemy_id === undefined ? {} : { enemy_id: data.enemy_id }),
      ...(data.expected_cell === undefined
        ? {}
        : { expected_cell: data.expected_cell }),
      observed_tick: data.observed_tick,
    });
    const expiresTick = data.expires_tick;
    if (
      typeof data.created_at !== "string" ||
      !Number.isFinite(Date.parse(data.created_at)) ||
      typeof expiresTick !== "number" ||
      !Number.isSafeInteger(expiresTick)
    ) {
      return undefined;
    }
    return {
      ...request,
      version: CONTROL_VERSION,
      command_id: data.command_id,
      created_at: data.created_at,
      expires_tick: expiresTick,
    };
  } catch {
    return undefined;
  }
}

function receipt(
  command: StoredManualControl,
  tick: number,
  status: ControlReceipt["status"],
  message: string,
): ControlReceipt {
  return {
    command_id: command.command_id,
    target_type: command.target_type,
    target_id: command.target_id,
    action: command.action,
    observed_tick: command.observed_tick,
    applied_tick: tick,
    status,
    message,
    updated_at: new Date().toISOString(),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("control must be an object");
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error(`${field} must be a UUID`);
  }
  return value;
}

function position(value: unknown, field: string): Position {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((item) => Number.isSafeInteger(item))
  ) {
    throw new Error(`${field} must be a two-coordinate position`);
  }
  return [value[0] as number, value[1] as number];
}

function isManualControlAction(value: unknown): value is ManualControlAction {
  return (
    typeof value === "string" &&
    [
      "MOVE",
      "WAIT",
      "HARVEST",
      "DEPOSIT",
      "SWEEP",
      "SHOOT",
      "HEAL",
      "PICKUP_BEACON",
      "DROP_BEACON",
      "SELF_DESTRUCT",
      "SPAWN",
      "REPAIR_SHIELD",
      "START_MOVE",
      "CANCEL_MOVE",
    ].includes(value)
  );
}

function requiresDirection(
  value: ManualControlAction,
): value is "MOVE" | "SWEEP" | "START_MOVE" {
  return value === "MOVE" || value === "SWEEP" || value === "START_MOVE";
}

function isDirection(value: unknown): value is Direction {
  return (
    value === "UP" || value === "DOWN" || value === "LEFT" || value === "RIGHT"
  );
}

function isUnitType(value: unknown): value is UnitType {
  return value === "WORKER" || value === "VANGUARD" || value === "RANGER";
}

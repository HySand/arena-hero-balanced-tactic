import type {
  CommandPlan,
  CoreAction,
  CoreObject,
  PlayerState,
  Position,
  TerrainObject,
  StrategyRuntimeStatus,
  StrategyStatusSummary,
  UnitAction,
  UnitObject,
  WorldObject,
} from "./contracts";
import type { PythonStrategyConfig } from "./python-strategy/config";
import type { PythonStrategyMemory } from "./python-strategy/wire";

export interface DashboardStatusInput {
  desired: "running" | "stopped";
  phase: "idle" | "connecting" | "open" | "blocked";
  authBlocked: boolean;
  tick: number;
  updatedAt: string;
  state: PlayerState;
  plan: CommandPlan;
  memory: PythonStrategyMemory;
  config: PythonStrategyConfig;
  strategy: StrategyRuntimeStatus;
  summary?: StrategyStatusSummary;
  connection?: object;
  configUpdatedAt?: string;
}

export function projectDashboardStatus(
  input: DashboardStatusInput,
): Record<string, unknown> {
  const now = Date.now();
  const updatedAtMs = Date.parse(input.updatedAt);
  const ageSeconds = Number.isFinite(updatedAtMs)
    ? Math.max(0, (now - updatedAtMs) / 1000)
    : Number.POSITIVE_INFINITY;
  const stale = ageSeconds > 90;
  const core = controlledCore(input.state.objects);
  const units = controlledUnits(input.state.objects);
  const counts = unitCounts(units);
  const summary = input.summary;
  const strategyPhase = summary?.strategyPhase ?? "UNKNOWN";
  const resourceRadius = summary?.resourceRadius ?? null;
  const explorationRadius = summary?.explorationRadius ?? null;
  const offenseReady = summary?.offenseReady ?? false;
  const resourceSpace = summary?.resourceSpace ?? null;
  const visibleResources = input.state.objects
    .filter((object): object is TerrainObject => object.kind === "RESOURCE")
    .flatMap((object) => object.positions.map(positionDocument));
  const enemies = input.state.objects
    .filter(isEnemy)
    .map((object) => enemyDocument(object));

  return {
    desired: input.desired,
    phase: input.phase,
    connected: input.phase === "open",
    authBlocked: input.authBlocked,
    online: input.phase === "open" && !stale,
    stale,
    age_seconds: Number.isFinite(ageSeconds)
      ? Math.round(ageSeconds * 10) / 10
      : null,
    message: statusMessage(input, stale),
    accepted: input.strategy.submittedBackend === "python",
    tick: input.tick,
    updatedAt: input.updatedAt,
    updated_at: updatedAtMs / 1000,
    configUpdatedAt: input.configUpdatedAt,
    backend: input.strategy.backend,
    strategy: input.strategy,
    summary,
    connection: input.connection,
    profile: "economy",
    strategy_phase: strategyPhase,
    resource_radius: resourceRadius,
    resource_radius_limit: numberAt(input.memory, "resource_radius_limit"),
    effective_resource_radius: numberAt(
      input.memory,
      "effective_resource_radius",
    ),
    resource_candidate_count: numberAt(
      input.memory,
      "resource_candidate_count",
    ),
    resource_assignment_count: numberAt(
      input.memory,
      "resource_assignment_count",
    ),
    exploration_radius: explorationRadius,
    offense_ready: offenseReady,
    posture:
      input.summary?.posture ??
      stringAt(input.memory, "last_posture") ??
      "UNKNOWN",
    threat_score: rounded(numberAt(input.memory, "last_threat_score") ?? 0, 3),
    resources: input.state.resources,
    resource_capacity: summary?.resourceCapacity ?? null,
    resource_space: resourceSpace,
    population: input.state.population,
    counts,
    production_order: input.config.production.order.map((step) => ({
      unit_type: step.unit_type,
      target: step.target,
    })),
    core: core ? coreDocument(core, input.plan.core_action) : null,
    visible_enemy_count: enemies.length,
    visible_enemies: enemies,
    visible_resources: visibleResources,
    remembered_resources: positionsAt(input.memory, "resource_hints"),
    map_memory: {
      known_cells: positionsAt(input.memory, "known_cells").length,
      obstacles: positionsAt(input.memory, "obstacle_cells").length,
      visited_cells: arrayAt(input.memory, "visited_cells").length,
      bounds: positionBoundsAt(input.memory, "bounds"),
    },
    worker_losses: numberAt(input.memory, "worker_losses") ?? 0,
    planned_deposited: numberAt(input.memory, "planned_deposited") ?? 0,
    units: units.map((unit) => unitDocument(unit, input.plan, input.memory)),
    events: input.state.events,
    adaptive_economy: adaptiveEconomyDocument(input.memory, input.config),
  };
}

function statusMessage(input: DashboardStatusInput, stale: boolean): string {
  if (input.authBlocked) return "Arena Hero authentication is blocked";
  if (input.desired === "stopped") return "Agent is stopped";
  if (stale) return "Waiting for a fresh Arena Hero state";
  if (input.strategy.fallbackUsed) {
    return "Python strategy failed; the minimal safe fallback was submitted";
  }
  return "Python strategy is active";
}

function controlledCore(
  objects: readonly WorldObject[],
): CoreObject | undefined {
  return objects.find(
    (object): object is CoreObject =>
      object.kind === "CORE" && object.controlled,
  );
}

function controlledUnits(objects: readonly WorldObject[]): UnitObject[] {
  return objects.filter(
    (object): object is UnitObject =>
      object.kind === "UNIT" && object.controlled,
  );
}

function isEnemy(object: WorldObject): object is CoreObject | UnitObject {
  return (
    (object.kind === "CORE" || object.kind === "UNIT") && !object.controlled
  );
}

function enemyDocument(
  object: CoreObject | UnitObject,
): Record<string, unknown> {
  return {
    id: object.id,
    kind: object.kind,
    ...(object.kind === "UNIT" ? { unit_type: object.unit_type } : {}),
    position: positionDocument(object.position),
    hp: object.hp,
  };
}

function coreDocument(
  core: CoreObject,
  action: CoreAction | undefined,
): Record<string, unknown> {
  return {
    id: core.id,
    position: positionDocument(core.position),
    hp: core.hp,
    shield: core.shield,
    state: core.state,
    ...(core.destination
      ? { destination: positionDocument(core.destination) }
      : {}),
    ...(core.move_progress === undefined
      ? {}
      : { move_progress: core.move_progress }),
    ...(core.move_required_ticks === undefined
      ? {}
      : { move_required_ticks: core.move_required_ticks }),
    action: actionLabel(action),
  };
}

function unitDocument(
  unit: UnitObject,
  plan: CommandPlan,
  memory: PythonStrategyMemory,
): Record<string, unknown> {
  const workerTarget = positionForUnit(memory, "worker_targets", unit.id);
  const scoutTarget =
    positionForUnit(memory, "scout_targets", unit.id) ??
    positionForUnit(memory, "combat_targets", unit.id);
  return {
    id: unit.id,
    short_id: unit.id.slice(0, 8),
    unit_type: unit.unit_type,
    position: positionDocument(unit.position),
    hp: unit.hp,
    ...(unit.cargo === undefined ? {} : { cargo: unit.cargo }),
    role: unitRole(unit, workerTarget, scoutTarget),
    action: actionLabel(plan.unit_actions?.[unit.id]),
    ...(workerTarget
      ? { resource_target: positionDocument(workerTarget) }
      : {}),
    ...(scoutTarget ? { scout_target: positionDocument(scoutTarget) } : {}),
  };
}

function unitRole(
  unit: UnitObject,
  workerTarget: Position | undefined,
  scoutTarget: Position | undefined,
): string {
  if (unit.unit_type === "WORKER") {
    if ((unit.cargo ?? 0) > 0) return "Returning resources";
    if (workerTarget) return "Harvesting";
    if (scoutTarget) return "Scouting";
    return "Core rally";
  }
  if (unit.unit_type === "VANGUARD") {
    return scoutTarget ? "Combat advance" : "Combat support";
  }
  return scoutTarget ? "Outer patrol" : "Core guard";
}

function actionLabel(action: CoreAction | UnitAction | undefined): string {
  if (!action) return "WAIT";
  if ("direction" in action && action.direction) {
    return `${action.type}:${action.direction}`;
  }
  if ("unit_type" in action && action.unit_type) {
    return `${action.type}:${action.unit_type}`;
  }
  if ("expected_cell" in action) {
    return `${action.type}:${positionDocument(action.expected_cell).join(",")}`;
  }
  return action.type;
}

function unitCounts(units: readonly UnitObject[]): Record<string, number> {
  const counts = { WORKER: 0, VANGUARD: 0, RANGER: 0 };
  for (const unit of units) counts[unit.unit_type] += 1;
  return counts;
}

function adaptiveEconomyDocument(
  memory: PythonStrategyMemory,
  config: PythonStrategyConfig,
): Record<string, unknown> {
  return {
    enabled: config.adaptive_economy.enabled,
    action: stringAt(memory, "adaptive_action") ?? "WARMUP",
    reason: stringAt(memory, "adaptive_reason") ?? "collecting_samples",
    throughput_per_worker: rounded(
      numberAt(memory, "adaptive_throughput") ?? 0,
      4,
    ),
    utilization: rounded(numberAt(memory, "adaptive_utilization") ?? 0, 4),
    harvest_failure_rate: rounded(
      numberAt(memory, "adaptive_failure_rate") ?? 0,
      4,
    ),
    average_cycle_ticks: rounded(
      numberAt(memory, "adaptive_average_cycle_ticks") ?? 0,
      2,
    ),
    storage_full_ratio: rounded(
      numberAt(memory, "adaptive_storage_full_ratio") ?? 0,
      4,
    ),
    new_cells_per_scout: rounded(
      numberAt(memory, "adaptive_new_cells_per_scout") ?? 0,
      3,
    ),
    sample_count: numberAt(memory, "adaptive_sample_count") ?? 0,
    scarcity_streak: numberAt(memory, "adaptive_scarcity_streak") ?? 0,
    radius_delta: numberAt(memory, "adaptive_radius_delta") ?? 0,
    scout_bonus: numberAt(memory, "adaptive_scout_bonus") ?? 0,
    worker_target: numberAt(memory, "adaptive_worker_target"),
  };
}

function positionForUnit(
  memory: PythonStrategyMemory,
  key: string,
  unitId: string,
): Position | undefined {
  const mappings = recordAt(memory, key);
  return mappings ? positionAt(mappings[unitId]) : undefined;
}

function positionsAt(memory: PythonStrategyMemory, key: string): number[][] {
  return arrayAt(memory, key)
    .map(positionAt)
    .filter((value): value is Position => value !== undefined)
    .map(positionDocument);
}

function positionBoundsAt(
  memory: PythonStrategyMemory,
  key: string,
): number[] | null {
  const value = memory[key];
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((item) => Number.isSafeInteger(item))
  ) {
    return null;
  }
  return value as number[];
}

function arrayAt(memory: PythonStrategyMemory, key: string): unknown[] {
  const value = memory[key];
  return Array.isArray(value) ? value : [];
}

function recordAt(
  memory: PythonStrategyMemory,
  key: string,
): Record<string, unknown> | undefined {
  const value = memory[key];
  return isRecord(value) ? value : undefined;
}

function numberAt(
  memory: PythonStrategyMemory,
  key: string,
): number | undefined {
  const value = memory[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringAt(
  memory: PythonStrategyMemory,
  key: string,
): string | undefined {
  const value = memory[key];
  return typeof value === "string" ? value : undefined;
}

function positionAt(value: unknown): Position | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((item) => Number.isSafeInteger(item))
  ) {
    return undefined;
  }
  return [value[0] as number, value[1] as number];
}

function positionDocument(position: Position): number[] {
  return [position[0], position[1]];
}

function rounded(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

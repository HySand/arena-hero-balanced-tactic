export const API_VERSION = "0.1";
export const GAMEPLAY_VERSION = "0.7";

export type Position = readonly [number, number];
export type Direction = "UP" | "DOWN" | "LEFT" | "RIGHT";
export type UnitType = "WORKER" | "VANGUARD" | "RANGER";
export type Posture =
  | "RECOVER"
  | "ECONOMY"
  | "HOLD"
  | "CONTEST"
  | "ATTACK"
  | "REGROUP";

export interface TerrainObject {
  kind: "OBSTACLE" | "RESOURCE";
  positions: Position[];
}

export interface CoreObject {
  kind: "CORE";
  id: string;
  owner_username: string;
  controlled: boolean;
  position: Position;
  hp: number;
  shield: number;
  state: "NORMAL" | "MOVING";
  move_direction?: Direction;
  move_progress?: number;
  move_required_ticks?: number;
  destination?: Position;
}

export interface UnitObject {
  kind: "UNIT";
  id: string;
  controlled: boolean;
  position: Position;
  hp: number;
  unit_type: UnitType;
  cargo?: number;
}

export type WorldObject = TerrainObject | CoreObject | UnitObject;

export interface ChampionBeacon {
  position: Position;
  status?: "GROUND" | "CARRIED";
  carrier_id?: string;
}

export interface PlayerState {
  status: "ACTIVE" | "RESPAWNING";
  respawn_at_tick?: number;
  resources: number;
  population: number;
  population_tier: number;
  upkeep_next_tick: number;
  champion_beacon: ChampionBeacon;
  objects: WorldObject[];
  events: Array<Record<string, unknown>>;
}

export type UnitAction =
  | { type: "WAIT" }
  | { type: "MOVE"; direction: Direction }
  | { type: "HARVEST" }
  | { type: "DEPOSIT" }
  | { type: "SWEEP"; direction: Direction }
  | { type: "SHOOT"; target_id?: string; expected_cell: Position }
  | { type: "HEAL" }
  | { type: "PICKUP_BEACON" }
  | { type: "DROP_BEACON" }
  | { type: "SELF_DESTRUCT" };

export type CoreAction =
  | { type: "WAIT" }
  | { type: "SPAWN"; unit_type: UnitType }
  | { type: "REPAIR_SHIELD" }
  | { type: "HEAL" }
  | { type: "START_MOVE"; direction: Direction }
  | { type: "CANCEL_MOVE" }
  | { type: "PICKUP_BEACON" }
  | { type: "DROP_BEACON" }
  | { type: "SELF_DESTRUCT" };

export interface CommandPlan {
  tick: number;
  unit_actions?: Record<string, UnitAction>;
  core_action?: CoreAction;
}

export interface ReceivedData {
  tick: number;
  source: "AGENT" | "MANUAL";
  received_at: string;
  plan: CommandPlan;
}

export type GameMessage =
  | { type: "tick"; data: number }
  | { type: "state"; data: PlayerState }
  | { type: "received"; data: ReceivedData };

export interface ResourceObservation {
  position: Position;
  lastSeenTick: number;
  depletedAtTick?: number;
  contestedAtTick?: number;
}

export interface EnemyObservation {
  id: string;
  kind: "CORE" | "UNIT";
  unitType?: UnitType;
  position: Position;
  hp: number;
  lastSeenTick: number;
  lastMove?: Direction;
  movementStreak?: number;
}

export type RoleKind =
  | "RESERVE"
  | "CONTROL_RALLY"
  | "PATROL"
  | "OBSERVE"
  | "WATCH_POINT"
  | "HOLD_POINT"
  | "ESCORT"
  | "CORE_DEFENSE"
  | "RALLY"
  | "ADVANCE"
  | "ENGAGE"
  | "WITHDRAW";

export interface RoleMemory {
  kind: RoleKind;
  anchor: Position;
  sinceTick: number;
}

export interface StrategyMemory {
  obstacles: Record<string, Position>;
  explored: Record<string, Position>;
  workerExplored: Record<string, Position>;
  resources: Record<string, ResourceObservation>;
  enemies: Record<string, EnemyObservation>;
  patrolVisits: Record<string, number>;
  roles: Record<string, RoleMemory>;
  posture: Posture;
  postureSinceTick: number;
  previousPopulation: number;
  recentHarvestFailures: number;
  nearbyResourceDryTicks: number;
  safeExpansionTicks: number;
  previousCombatUnitIds: string[];
  recentCombatLosses: number;
  militaryPressureTicks: number;
  militaryCalmTicks: number;
  /** Sticky per-worker duty-scout deadlines (absolute tick). */
  workerDutyScoutUntil: Record<string, number>;
  /** Last worker move, used to break FOW / corridor reverse oscillation. */
  workerLastMove?: Record<
    string,
    { direction: Direction; from: Position; tick: number }
  >;
  /** Sticky visible/fog harvest goal while the worker is en route. */
  workerHarvestGoal?: Record<string, Position>;
  /** Cells already tried while approaching the current harvest goal. */
  workerHarvestVisited?: Record<string, { goal: string; cells: string[] }>;
  /** Committed step queue toward a visible/fog harvest goal. */
  workerHarvestPath?: Record<
    string,
    { goal: string; steps: Direction[]; expect: Position }
  >;
  /**
   * Sticky exploration/scout cell so frontier re-ranking cannot flip the
   * worker between two vision-rim targets every tick (UP/DOWN orbit).
   */
  workerScoutTarget?: Record<
    string,
    { position: Position; tick: number; goalKey?: string }
  >;
}

export interface DecisionSummary {
  posture: Posture;
  threatened: boolean;
  retreating: boolean;
  controlRadius: number;
  supportResponseTicks: number;
  reserveCount: number;
  reserve: number;
  militaryReady: boolean;
  minimumCombatCount: number;
  minimumCombatPower: number;
  combatCountDeficit: number;
  combatPowerDeficit: number;
  targetWorkerShare: number;
  recentCombatLosses: number;
  militaryPressureTicks: number;
  actions: Record<string, number>;
  planningMs: number;
}

export type StrategyBackend =
  | "typescript_primary"
  | "python_shadow"
  | "python_primary";

export type StrategyStatusPosture =
  | Posture
  | "GUARDED"
  | "SURVIVAL"
  | "RESPAWNING";

export interface StrategyStatusSummary {
  posture: StrategyStatusPosture;
  threatened: boolean;
  retreating: boolean;
  actions: Record<string, number>;
  planningMs: number;
}

export interface StrategyShadowStatus {
  matched: boolean;
  unitActionDifferences: number;
  coreActionDifferent: boolean;
  summaryDifferent: boolean;
  memoryMetadataDifferent: boolean;
  comparedTicks?: number;
  matchedTicks?: number;
  mismatchedTicks?: number;
  cumulativeUnitActionDifferences?: number;
  cumulativeCoreActionDifferences?: number;
  cumulativeSummaryDifferences?: number;
  cumulativeMemoryMetadataDifferences?: number;
  lastComparedTick?: number;
  lastDifferenceTick?: number;
}

export interface StrategyRuntimeStatus {
  backend: StrategyBackend;
  submittedBackend: "typescript" | "python" | "safe_fallback";
  strategyVersion: string;
  contractVersion: string;
  latencyMs?: number;
  lastSuccessTick?: number;
  lastError: string | null;
  fallbackUsed: boolean;
  consecutiveFailures: number;
  blocked: boolean;
  shadow?: StrategyShadowStatus;
}

export interface PlanResult {
  plan: CommandPlan;
  memory: StrategyMemory;
  summary: DecisionSummary;
}

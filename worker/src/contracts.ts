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
  strategyPhase?: "EARLY" | "MID" | "LATE" | "RESPAWNING";
  resourceRadius?: number | null;
  explorationRadius?: number;
  offenseReady?: boolean;
  resourceSpace?: number;
  resourceCapacity?: number;
}

export interface StrategyRuntimeStatus {
  backend: "python_primary";
  submittedBackend: "python" | "safe_fallback";
  strategyVersion: string;
  contractVersion: string;
  latencyMs?: number;
  lastSuccessTick?: number;
  lastError: string | null;
  fallbackUsed: boolean;
  consecutiveFailures: number;
  blocked: boolean;
}

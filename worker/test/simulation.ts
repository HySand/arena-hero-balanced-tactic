import type {
  CommandPlan,
  CoreObject,
  PlayerState,
  Position,
  Posture,
  RoleKind,
  StrategyMemory,
  UnitAction,
  UnitObject,
  UnitType,
  WorldObject,
} from "../src/contracts";
import {
  cellsWithin,
  distance,
  hasVision,
  key,
  lineClear,
  nextPosition,
} from "../src/strategy/geometry";
import { emptyMemory, planTick } from "../src/strategy/planner";
import { DEFAULT_CONFIG } from "../src/strategy/config";
import { validatePlan } from "../src/strategy/validation";

export type ScenarioKind =
  | "RESOURCE_RICH"
  | "RESOURCE_SCARCE"
  | "CHOKEPOINT_ECONOMY"
  | "WORKER_HARASSMENT"
  | "CORE_ASSAULT"
  | "RANGED_PRESSURE"
  | "FAVORABLE_ATTACK"
  | "OVERWHELMING_FORCE"
  | "MAP_CONTROL"
  | "MIXED_CAMPAIGN"
  | "RECURRING_RAIDS"
  | "STAGGERED_RANGED_WAVES"
  | "PURSUIT_THROUGH_RETREAT"
  | "POST_LOSS_REATTACK";

interface SimResource {
  position: Position;
  available: boolean;
  depletedAtTick?: number;
}

interface SimWorld {
  core: CoreObject;
  units: UnitObject[];
  enemyCore?: CoreObject;
  enemies: UnitObject[];
  obstacles: Set<string>;
  resources: Map<string, SimResource>;
  storedResources: number;
  beacon: Position;
  beaconCarrierId?: string;
  events: Array<Record<string, unknown>>;
  nextUnitId: number;
  mapPosition: (position: Position) => Position;
}

export interface SimulationMetrics {
  scenario: ScenarioKind;
  seed: number;
  ticks: number;
  invalidPlans: number;
  coreDeaths: number;
  resourcesHarvested: number;
  resourcesDeposited: number;
  deliveredOrInTransit: number;
  harvestAttempts: number;
  harvestFailures: number;
  depositAttempts: number;
  visibleResourceCellTicks: number;
  uncollectedVisibleResourceCellTicks: number;
  resourceResponseTicks: number;
  resourceResponseSamples: number;
  workerActions: number;
  productiveWorkerActions: number;
  workerWaitActions: number;
  emptyWorkerWaitTicks: number;
  workerMoveActions: number;
  workerMovesResolved: number;
  workerDistanceTicks: number;
  workerPositionSamples: number;
  cargoDistanceTicks: number;
  cargoWorkerSamples: number;
  harvestDistance: number;
  longHaulWorkerTicks: number;
  workerSectorCollisionTicks: number;
  distinctWorkerCells: number;
  maxWorkerDistance: number;
  exploredCells: number;
  frontierGrowthTicks: number;
  balancedFrontierSectors: number;
  frontierRadiusSpread: number;
  workerBalancedFrontierSectors: number;
  workerFrontierRadiusSpread: number;
  maxExploredDistance: number;
  attacks: number;
  attackHits: number;
  shootAttempts: number;
  shootHits: number;
  workerShootAttempts: number;
  workerShootHits: number;
  vanguardShootAttempts: number;
  vanguardShootHits: number;
  rangerShootAttempts: number;
  rangerShootHits: number;
  coreShootAttempts: number;
  coreShootHits: number;
  sweepAttempts: number;
  sweepHits: number;
  enemyUnitsDestroyed: number;
  enemyCoreDamage: number;
  enemyCoreKills: number;
  offenseCompletionTicks: number;
  offenseCompletionSamples: number;
  advanceAssignments: number;
  engageAssignments: number;
  defensiveResponses: number;
  withdrawals: number;
  mapControlAssignments: number;
  outerControlUnitTicks: number;
  combatCellTicks: number;
  distinctDefenderCells: number;
  maxCombatDistance: number;
  friendlyUnitsLost: number;
  friendlyCombatUnitsLost: number;
  threatObservationTicks: number;
  defenseResponseTicks: number;
  defenseResponseSamples: number;
  innerBreachTicks: number;
  minimumCoreEffectiveHealth: number;
  controlSectorTicks: number;
  controlVisionSectorTicks: number;
  supportedControlVisionSectorTicks: number;
  outerControlAssignmentTicks: number;
  supportedOuterControlAssignmentTicks: number;
  mapControlOpportunityTicks: number;
  mapControlEstablishmentTicks: number;
  mapControlEstablishmentSamples: number;
  unsupportedOuterControlTicks: number;
  coreDamageTaken: number;
  coreMovesCompleted: number;
  centerDistanceReduced: number;
  unitsSpawned: number;
  workerSpawns: number;
  vanguardSpawns: number;
  rangerSpawns: number;
  combatUnitTicks: number;
  combatPowerTicks: number;
  militaryReadinessTicks: number;
  militaryDeficitTicks: number;
  combatReplacementTicks: number;
  combatReplacementSamples: number;
  waveStarts: number;
  peakPopulation: number;
  endingResources: number;
  friendlyOverCapacity: number;
  endingCargo: number;
  postureTicks: Record<Posture, number>;
}

export interface SimulationReport {
  episodes: SimulationMetrics[];
  totals: Omit<SimulationMetrics, "scenario" | "seed" | "postureTicks">;
}

export interface SimulationTrace {
  tick: number;
  corePosition: Position;
  coreHp: number;
  coreShield: number;
  storedResources: number;
  friendlyUnits: Array<
    Pick<UnitObject, "id" | "unit_type" | "position" | "hp">
  >;
  enemies: Array<Pick<UnitObject, "id" | "unit_type" | "position" | "hp">>;
  enemyCore?: Pick<CoreObject, "id" | "position" | "hp" | "shield">;
  plan: CommandPlan;
  roles: StrategyMemory["roles"];
  posture: Posture;
  retreating: boolean;
  controlRadius: number;
  reserveCount: number;
}

const VISION: Record<UnitType | "CORE", number> = {
  CORE: 5,
  WORKER: 3,
  VANGUARD: 4,
  RANGER: 5,
};

const CONTROL_ROLES = new Set<RoleKind>([
  "PATROL",
  "OBSERVE",
  "WATCH_POINT",
  "HOLD_POINT",
]);
const SUPPORT_ROLES = new Set<RoleKind>(["RESERVE"]);
const DEFENSE_ROLES = new Set<RoleKind>(["CORE_DEFENSE", "ESCORT"]);
const THREAT_RESPONSE_ROLES = new Set<RoleKind>([...DEFENSE_ROLES, "WITHDRAW"]);

function uuid(group: number, index: number): string {
  return `${String(group).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function position(x: number, y: number): Position {
  return [x, y];
}

const ANALYSIS_SECTORS = 8;

function angularSector(
  origin: Position,
  target: Position,
  sectorCount = ANALYSIS_SECTORS,
): number {
  const raw = Math.atan2(target[1] - origin[1], target[0] - origin[0]);
  const angle = raw < 0 ? raw + Math.PI * 2 : raw;
  return Math.floor((angle / (Math.PI * 2)) * sectorCount) % sectorCount;
}

function frontierProfile(
  origin: Position,
  explored: Readonly<Record<string, Position>>,
): {
  balancedSectors: number;
  radiusSpread: number;
  maxDistance: number;
} {
  const radii = Array.from({ length: ANALYSIS_SECTORS }, () => 0);
  for (const cell of Object.values(explored)) {
    const sector = angularSector(origin, cell);
    radii[sector] = Math.max(radii[sector] ?? 0, distance(origin, cell));
  }
  const maxDistance = Math.max(...radii);
  const minDistance = Math.min(...radii);
  return {
    balancedSectors: radii.filter((radius) => radius >= maxDistance - 3).length,
    radiusSpread: maxDistance - minDistance,
    maxDistance,
  };
}

function makeUnit(
  id: string,
  unitType: UnitType,
  at: Position,
  controlled: boolean,
): UnitObject {
  return {
    kind: "UNIT",
    id,
    controlled,
    position: at,
    hp: unitType === "VANGUARD" ? 4 : 2,
    unit_type: unitType,
    ...(controlled && unitType === "WORKER" ? { cargo: 0 } : {}),
  };
}

function addResources(world: SimWorld, positions: readonly Position[]): void {
  for (const at of positions)
    world.resources.set(key(at), { position: at, available: true });
}

function addWall(world: SimWorld, cells: readonly Position[]): void {
  for (const cell of cells) world.obstacles.add(key(cell));
}

function addEnemyWave(
  world: SimWorld,
  units: ReadonlyArray<readonly [UnitType, Position]>,
): void {
  for (const [unitType, at] of units) {
    world.enemies.push(
      makeUnit(
        uuid(3, world.nextUnitId++),
        unitType,
        world.mapPosition(at),
        false,
      ),
    );
  }
}

function seeded(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function createWorld(scenario: ScenarioKind, seed: number): SimWorld {
  const random = seeded(seed * 7919 + scenario.length * 104729);
  const world: SimWorld = {
    core: {
      kind: "CORE",
      id: uuid(1, seed),
      owner_username: "simulation-agent",
      controlled: true,
      position: [0, 0],
      hp: 5,
      shield: 5,
      state: "NORMAL",
    },
    units: [],
    enemies: [],
    obstacles: new Set(),
    resources: new Map(),
    storedResources: 8,
    beacon: [10, 0],
    events: [],
    nextUnitId: 1000 + seed * 100,
    mapPosition: (at) => at,
  };
  const friendly = (type: UnitType, at: Position): void => {
    world.units.push(makeUnit(uuid(2, world.nextUnitId++), type, at, true));
  };
  const enemy = (type: UnitType, at: Position): void => {
    world.enemies.push(makeUnit(uuid(3, world.nextUnitId++), type, at, false));
  };

  friendly("WORKER", [-1, 0]);
  friendly("WORKER", [0, 1]);
  friendly("WORKER", [1, 0]);
  friendly("VANGUARD", [0, -1]);
  friendly("RANGER", [-1, -1]);

  const jitter = (): number => Math.floor(random() * 3) - 1;
  switch (scenario) {
    case "RESOURCE_RICH":
      world.storedResources = 20;
      addResources(world, [
        [-3, 0],
        [3, 0],
        [0, 3],
        [0, -3],
        [4, 2],
        [-4, -2],
      ]);
      break;
    case "RESOURCE_SCARCE":
      world.storedResources = 3;
      break;
    case "CHOKEPOINT_ECONOMY":
      addWall(world, [
        [3, -3],
        [3, -2],
        [3, 0],
        [3, 1],
        [3, 2],
        [3, 3],
      ]);
      addResources(world, [position(5, -1), position(-4, 2), position(-3, -2)]);
      enemy("WORKER", [6, -1]);
      break;
    case "WORKER_HARASSMENT":
      addResources(world, [
        [4, 0],
        [-4, 0],
        [0, 4],
      ]);
      enemy("WORKER", [4, 1]);
      enemy("WORKER", [-4, 1]);
      break;
    case "CORE_ASSAULT":
      friendly("VANGUARD", [1, -1]);
      friendly("RANGER", [1, 1]);
      enemy("VANGUARD", [7, jitter()]);
      enemy("VANGUARD", [8, 1 + jitter()]);
      enemy("RANGER", [9, -1 + jitter()]);
      break;
    case "RANGED_PRESSURE":
      addWall(world, [
        [2, -2],
        [2, 2],
        [5, -2],
        [5, 2],
      ]);
      friendly("VANGUARD", [1, 1]);
      enemy("RANGER", [7, 0]);
      enemy("RANGER", [7, 1]);
      enemy("VANGUARD", [6, -1]);
      break;
    case "FAVORABLE_ATTACK":
      friendly("VANGUARD", [1, -1]);
      friendly("VANGUARD", [1, 1]);
      friendly("RANGER", [-1, 1]);
      world.enemyCore = {
        kind: "CORE",
        id: uuid(4, seed),
        owner_username: "simulation-enemy",
        controlled: false,
        position: [11, 0],
        hp: 3,
        shield: 0,
        state: "NORMAL",
      };
      enemy("VANGUARD", [9, 1]);
      break;
    case "OVERWHELMING_FORCE":
      for (let index = 0; index < 7; index += 1)
        enemy("VANGUARD", [7 + Math.floor(index / 3), (index % 3) - 1]);
      enemy("RANGER", [9, 2]);
      break;
    case "MAP_CONTROL":
      friendly("VANGUARD", [1, -1]);
      friendly("VANGUARD", [1, 1]);
      friendly("RANGER", [-1, 1]);
      addWall(world, [
        [4, -3],
        [4, -2],
        [4, 0],
        [4, 1],
        [4, 2],
        [4, 3],
        [-4, -3],
        [-4, -2],
        [-4, 0],
        [-4, 1],
        [-4, 2],
        [-4, 3],
      ]);
      addResources(world, [
        [6, -1],
        [-6, -1],
        [0, 6],
      ]);
      break;
    case "MIXED_CAMPAIGN":
      friendly("VANGUARD", [1, -1]);
      friendly("RANGER", [1, 1]);
      addResources(world, [
        [4, 0],
        [-4, 0],
        [0, 4],
        [0, -4],
      ]);
      enemy("WORKER", [6, 0]);
      break;
    case "RECURRING_RAIDS":
      world.storedResources = 24;
      addResources(world, [
        [3, 0],
        [-3, 0],
        [0, 3],
        [0, -3],
      ]);
      break;
    case "STAGGERED_RANGED_WAVES":
      world.storedResources = 26;
      addResources(world, [
        [3, 0],
        [-3, 0],
        [0, 3],
        [0, -3],
      ]);
      addWall(world, [
        [3, -2],
        [3, 2],
        [6, -2],
        [6, 2],
      ]);
      break;
    case "PURSUIT_THROUGH_RETREAT":
      world.storedResources = 20;
      friendly("VANGUARD", [5, 0]);
      friendly("RANGER", [4, 1]);
      addResources(world, [
        [-3, 0],
        [0, 3],
        [0, -3],
      ]);
      break;
    case "POST_LOSS_REATTACK":
      world.storedResources = 28;
      friendly("VANGUARD", [2, 0]);
      addResources(world, [
        [3, 0],
        [-3, 0],
        [0, 3],
        [0, -3],
      ]);
      break;
  }
  orientWorld(world, seed);
  return world;
}

function orientWorld(world: SimWorld, seed: number): void {
  const turns = (seed - 1) % 4;
  const outerOffsets: readonly Position[] = [
    [40, 40],
    [-40, 40],
    [-40, -40],
    [40, -40],
  ];
  const offset = seed >= 5 ? (outerOffsets[(seed - 5) % 4] ?? [0, 0]) : [0, 0];
  const transform = (at: Position): Position => {
    let [x, y] = at;
    for (let turn = 0; turn < turns; turn += 1) [x, y] = [-y, x];
    if (seed >= 9) x = -x;
    return [x + offset[0], y + offset[1]];
  };
  world.mapPosition = transform;
  world.core.position = transform(world.core.position);
  for (const unit of [...world.units, ...world.enemies])
    unit.position = transform(unit.position);
  if (world.enemyCore)
    world.enemyCore.position = transform(world.enemyCore.position);
  world.beacon = transform(world.beacon);
  world.obstacles = new Set(
    [...world.obstacles].map((cell) =>
      key(transform(cell.split(",").map(Number) as unknown as Position)),
    ),
  );
  world.resources = new Map(
    [...world.resources.values()].map((resource) => {
      const at = transform(resource.position);
      return [key(at), { ...resource, position: at }];
    }),
  );
}

function population(world: SimWorld): number {
  return world.units.length;
}

function upkeep(count: number): number {
  const tier = Math.floor(count / 20);
  return (tier * (tier + 1)) / 2;
}

function simulationCombatPower(units: readonly UnitObject[]): number {
  return units.reduce(
    (sum, unit) =>
      sum +
      (unit.unit_type === "VANGUARD" ? 4 : unit.unit_type === "RANGER" ? 3 : 0),
    0,
  );
}

function simulationCombatFloor(units: readonly UnitObject[]): number {
  const workers = units.filter((unit) => unit.unit_type === "WORKER").length;
  return units.length <= 5 ? 2 : Math.max(3, Math.ceil(workers * 1.2));
}

function canSee(world: SimWorld, target: Position): boolean {
  const friendly: Array<CoreObject | UnitObject> = [world.core, ...world.units];
  return friendly.some((entity) =>
    hasVision(
      entity.position,
      target,
      entity.kind === "CORE" ? VISION.CORE : VISION[entity.unit_type],
      world.obstacles,
    ),
  );
}

function privateState(world: SimWorld): PlayerState {
  const objects: WorldObject[] = [
    structuredClone(world.core),
    ...structuredClone(world.units),
  ];
  const visibleObstacles = [...world.obstacles]
    .map((value) => value.split(",").map(Number) as unknown as Position)
    .filter((cell) => canSee(world, cell));
  const visibleResources = [...world.resources.values()]
    .filter(
      (resource) => resource.available && canSee(world, resource.position),
    )
    .map((resource) => resource.position);
  const visibleEnemies: Array<CoreObject | UnitObject> = [];
  if (world.enemyCore && canSee(world, world.enemyCore.position))
    visibleEnemies.push(structuredClone(world.enemyCore));
  visibleEnemies.push(
    ...world.enemies
      .filter((enemy) => canSee(world, enemy.position))
      .map((enemy) => structuredClone(enemy)),
  );
  objects.push(...visibleEnemies);
  if (visibleObstacles.length > 0)
    objects.push({ kind: "OBSTACLE", positions: visibleObstacles });
  if (visibleResources.length > 0)
    objects.push({ kind: "RESOURCE", positions: visibleResources });
  const count = population(world);
  return {
    status: "ACTIVE",
    resources: world.storedResources,
    population: count,
    population_tier: Math.floor(count / 20),
    upkeep_next_tick: upkeep(count),
    champion_beacon: {
      position: world.beacon,
      status: world.beaconCarrierId ? "CARRIED" : "GROUND",
      ...(world.beaconCarrierId ? { carrier_id: world.beaconCarrierId } : {}),
    },
    objects,
    events: world.events,
  };
}

function nearestTarget(
  from: Position,
  targets: readonly Position[],
): Position | undefined {
  return [...targets].sort(
    (a, b) =>
      Math.abs(from[0] - a[0]) +
        Math.abs(from[1] - a[1]) -
        (Math.abs(from[0] - b[0]) + Math.abs(from[1] - b[1])) ||
      key(a).localeCompare(key(b)),
  )[0];
}

function stepToward(
  from: Position,
  target: Position,
  obstacles: ReadonlySet<string>,
): Position {
  const candidates = (["UP", "RIGHT", "DOWN", "LEFT"] as const)
    .map((direction) => nextPosition(from, direction))
    .filter((candidate) => !obstacles.has(key(candidate)))
    .sort(
      (a, b) =>
        Math.abs(a[0] - target[0]) +
          Math.abs(a[1] - target[1]) -
          (Math.abs(b[0] - target[0]) + Math.abs(b[1] - target[1])) ||
        key(a).localeCompare(key(b)),
    );
  return candidates[0] ?? from;
}

function enemyActions(
  world: SimWorld,
  scenario: ScenarioKind,
): Map<string, UnitAction> {
  const result = new Map<string, UnitAction>();
  const aggressive =
    scenario !== "FAVORABLE_ATTACK" && scenario !== "MAP_CONTROL";
  const pursuesCombat =
    scenario === "PURSUIT_THROUGH_RETREAT" || scenario === "POST_LOSS_REATTACK";
  for (const enemy of world.enemies) {
    const combatTargets = world.units.filter(
      (unit) => unit.unit_type !== "WORKER",
    );
    const pursued = pursuesCombat
      ? combatTargets.sort(
          (a, b) =>
            distance(enemy.position, a.position) -
              distance(enemy.position, b.position) || a.id.localeCompare(b.id),
        )[0]
      : undefined;
    const targetObject = pursued ?? world.core;
    const targetDistance = distance(enemy.position, targetObject.position);
    if (enemy.unit_type === "VANGUARD" && targetDistance === 1) {
      const direction = (["UP", "RIGHT", "DOWN", "LEFT"] as const).find(
        (candidate) =>
          key(nextPosition(enemy.position, candidate)) ===
          key(targetObject.position),
      );
      result.set(
        enemy.id,
        direction ? { type: "SWEEP", direction } : { type: "WAIT" },
      );
      continue;
    }
    if (
      enemy.unit_type === "RANGER" &&
      distance(enemy.position, targetObject.position) <= 3 &&
      lineClear(enemy.position, targetObject.position, world.obstacles)
    ) {
      result.set(enemy.id, {
        type: "SHOOT",
        target_id: targetObject.id,
        expected_cell: targetObject.position,
      });
      continue;
    }
    if (!aggressive) {
      result.set(enemy.id, { type: "WAIT" });
      continue;
    }
    const target =
      enemy.unit_type === "WORKER"
        ? (nearestTarget(
            enemy.position,
            [...world.resources.values()]
              .filter((item) => item.available)
              .map((item) => item.position),
          ) ?? world.core.position)
        : targetObject.position;
    const next = stepToward(enemy.position, target, world.obstacles);
    const direction = (["UP", "RIGHT", "DOWN", "LEFT"] as const).find(
      (candidate) => key(nextPosition(enemy.position, candidate)) === key(next),
    );
    result.set(
      enemy.id,
      direction ? { type: "MOVE", direction } : { type: "WAIT" },
    );
  }
  return result;
}

function applyDamage(core: CoreObject, damage: number): void {
  const shieldDamage = Math.min(core.shield, damage);
  core.shield -= shieldDamage;
  core.hp -= damage - shieldDamage;
}

function roleCount(
  memory: StrategyMemory,
  kinds: ReadonlySet<RoleKind>,
  activeIds?: ReadonlySet<string>,
): number {
  return Object.entries(memory.roles).filter(
    ([id, role]) => (!activeIds || activeIds.has(id)) && kinds.has(role.kind),
  ).length;
}

function resolveTick(
  tick: number,
  scenario: ScenarioKind,
  world: SimWorld,
  plan: CommandPlan,
  metrics: SimulationMetrics,
): void {
  const coreEffectiveBefore = world.core.hp + world.core.shield;
  const corePositionBefore: Position = [...world.core.position];
  const enemyUnitsBefore = world.enemies.length;
  const enemyCoreBefore = world.enemyCore?.hp;
  world.events = [];
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const enemyById = new Map(world.enemies.map((unit) => [unit.id, unit]));
  for (const [id, action] of Object.entries(plan.unit_actions ?? {})) {
    if (action.type === "SELF_DESTRUCT") {
      const index = world.units.findIndex((unit) => unit.id === id);
      if (index >= 0) world.units.splice(index, 1);
    }
  }
  const due = upkeep(population(world));
  if (world.storedResources >= due) world.storedResources -= due;
  else {
    applyDamage(world.core, due - world.storedResources);
    world.storedResources = 0;
  }

  const enemyPlan = enemyActions(world, scenario);
  const moves: Array<{
    entity: UnitObject;
    destination: Position;
    owner: "FRIEND" | "ENEMY";
  }> = [];
  for (const [id, action] of Object.entries(plan.unit_actions ?? {})) {
    const entity = unitById.get(id);
    if (entity && action.type === "MOVE")
      moves.push({
        entity,
        destination: nextPosition(entity.position, action.direction),
        owner: "FRIEND",
      });
  }
  for (const [id, action] of enemyPlan) {
    const entity = enemyById.get(id);
    if (entity && action.type === "MOVE")
      moves.push({
        entity,
        destination: nextPosition(entity.position, action.direction),
        owner: "ENEMY",
      });
  }
  const destinationOwners = new Map<string, Set<string>>();
  for (const move of moves) {
    const owners =
      destinationOwners.get(key(move.destination)) ?? new Set<string>();
    owners.add(move.owner);
    destinationOwners.set(key(move.destination), owners);
  }
  for (const move of moves.sort((a, b) =>
    a.entity.id.localeCompare(b.entity.id),
  )) {
    if (world.obstacles.has(key(move.destination))) continue;
    if ((destinationOwners.get(key(move.destination))?.size ?? 0) > 1) continue;
    const friendOccupants = world.units.filter(
      (unit) => key(unit.position) === key(move.destination),
    );
    const enemyOccupants = world.enemies.filter(
      (unit) => key(unit.position) === key(move.destination),
    );
    if (move.owner === "FRIEND" && enemyOccupants.length > 0) continue;
    if (
      move.owner === "ENEMY" &&
      (friendOccupants.length > 0 ||
        key(world.core.position) === key(move.destination))
    )
      continue;
    const sameOwnerOccupants =
      move.owner === "FRIEND" ? friendOccupants : enemyOccupants;
    if (sameOwnerOccupants.length >= 2) continue;
    move.entity.position = move.destination;
    if (move.owner === "FRIEND" && move.entity.unit_type === "WORKER")
      metrics.workerMovesResolved += 1;
  }

  for (const [id, action] of Object.entries(plan.unit_actions ?? {})) {
    const unit = unitById.get(id);
    if (!unit) continue;
    if (
      unit.unit_type === "WORKER" &&
      action.type === "HARVEST" &&
      (unit.cargo ?? 0) === 0
    ) {
      const resource = world.resources.get(key(unit.position));
      if (resource?.available) {
        resource.available = false;
        resource.depletedAtTick = tick;
        unit.cargo = 1;
        metrics.resourcesHarvested += 1;
        metrics.harvestDistance += distance(world.core.position, unit.position);
      } else {
        metrics.harvestFailures += 1;
        world.events.push({ event_type: "HARVEST_FAILED" });
      }
    }
    if (
      unit.unit_type === "WORKER" &&
      action.type === "DEPOSIT" &&
      key(unit.position) === key(world.core.position) &&
      world.core.state === "NORMAL"
    ) {
      const capacity = Math.max(10, population(world) * 5);
      const amount = Math.min(
        unit.cargo ?? 0,
        capacity - world.storedResources,
      );
      world.storedResources += amount;
      unit.cargo = (unit.cargo ?? 0) - amount;
      metrics.resourcesDeposited += amount;
    }
  }

  const coreAction = plan.core_action;
  if (world.core.state === "MOVING") {
    if (coreAction?.type === "CANCEL_MOVE") {
      world.core = { ...world.core, state: "NORMAL" };
      delete world.core.move_direction;
      delete world.core.move_progress;
      delete world.core.move_required_ticks;
      delete world.core.destination;
    } else {
      const progress = (world.core.move_progress ?? 1) + 1;
      if (
        progress >= 4 &&
        world.core.destination &&
        !world.obstacles.has(key(world.core.destination))
      ) {
        world.core.position = world.core.destination;
        world.core = { ...world.core, state: "NORMAL" };
        delete world.core.move_direction;
        delete world.core.move_progress;
        delete world.core.move_required_ticks;
        delete world.core.destination;
      } else world.core.move_progress = progress;
    }
  } else if (coreAction?.type === "START_MOVE") {
    const destination = nextPosition(world.core.position, coreAction.direction);
    if (
      !world.obstacles.has(key(destination)) &&
      !world.resources.get(key(destination))?.available
    ) {
      world.core.state = "MOVING";
      world.core.move_direction = coreAction.direction;
      world.core.move_progress = 1;
      world.core.move_required_ticks = 4;
      world.core.destination = destination;
    }
  } else if (
    coreAction?.type === "REPAIR_SHIELD" &&
    world.storedResources > 0 &&
    world.core.shield < 5
  ) {
    world.storedResources -= 1;
    world.core.shield += 1;
  } else if (coreAction?.type === "SPAWN") {
    const costs: Record<UnitType, number> = {
      WORKER: 5,
      VANGUARD: 10,
      RANGER: 12,
    };
    const occupants = world.units.filter(
      (unit) => key(unit.position) === key(world.core.position),
    ).length;
    if (world.storedResources >= costs[coreAction.unit_type] && occupants < 1) {
      world.storedResources -= costs[coreAction.unit_type];
      world.units.push(
        makeUnit(
          uuid(2, world.nextUnitId++),
          coreAction.unit_type,
          world.core.position,
          true,
        ),
      );
      metrics.unitsSpawned += 1;
      if (coreAction.unit_type === "WORKER") metrics.workerSpawns += 1;
      if (coreAction.unit_type === "VANGUARD") metrics.vanguardSpawns += 1;
      if (coreAction.unit_type === "RANGER") metrics.rangerSpawns += 1;
    }
  }

  if (!world.beaconCarrierId) {
    const picker = Object.entries(plan.unit_actions ?? {})
      .filter(([, action]) => action.type === "PICKUP_BEACON")
      .map(([id]) => unitById.get(id))
      .filter(
        (unit): unit is UnitObject =>
          unit !== undefined && key(unit.position) === key(world.beacon),
      )
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    if (picker) world.beaconCarrierId = picker.id;
    else if (
      coreAction?.type === "PICKUP_BEACON" &&
      key(world.core.position) === key(world.beacon)
    ) {
      world.beaconCarrierId = world.core.id;
    }
  }
  const beaconCarrier =
    world.beaconCarrierId === world.core.id
      ? world.core
      : world.units.find((unit) => unit.id === world.beaconCarrierId);
  if (beaconCarrier) world.beacon = beaconCarrier.position;

  const friendlyBeforeCombat = new Map(
    world.units.map((unit) => [unit.id, unit.unit_type] as const),
  );
  const damage = new Map<string, number>();
  const addDamage = (id: string, amount: number): void => {
    damage.set(id, (damage.get(id) ?? 0) + amount);
  };
  const combatObjects: Array<CoreObject | UnitObject> = [
    world.core,
    ...world.units,
    ...world.enemies,
  ];
  if (world.enemyCore) combatObjects.push(world.enemyCore);
  for (const [id, action] of Object.entries(plan.unit_actions ?? {})) {
    const attacker = unitById.get(id);
    if (!attacker) continue;
    if (action.type === "SWEEP") {
      metrics.sweepAttempts += 1;
      const hitCell = nextPosition(attacker.position, action.direction);
      let hit = false;
      for (const target of combatObjects)
        if (!target.controlled && key(target.position) === key(hitCell)) {
          addDamage(target.id, 1);
          hit = true;
        }
      if (hit) metrics.sweepHits += 1;
    }
    if (action.type === "SHOOT") {
      metrics.shootAttempts += 1;
      const target = combatObjects.find(
        (object) => object.id === action.target_id && !object.controlled,
      );
      const targetType =
        target?.kind === "CORE" ? "core" : target?.unit_type.toLowerCase();
      if (targetType === "worker") metrics.workerShootAttempts += 1;
      if (targetType === "vanguard") metrics.vanguardShootAttempts += 1;
      if (targetType === "ranger") metrics.rangerShootAttempts += 1;
      if (targetType === "core") metrics.coreShootAttempts += 1;
      if (
        target &&
        key(target.position) === key(action.expected_cell) &&
        lineClear(attacker.position, target.position, world.obstacles)
      ) {
        addDamage(target.id, 1);
        metrics.attackHits += 1;
        metrics.shootHits += 1;
        if (targetType === "worker") metrics.workerShootHits += 1;
        if (targetType === "vanguard") metrics.vanguardShootHits += 1;
        if (targetType === "ranger") metrics.rangerShootHits += 1;
        if (targetType === "core") metrics.coreShootHits += 1;
      }
    }
  }
  for (const [id, action] of enemyPlan) {
    const attacker = enemyById.get(id);
    if (!attacker) continue;
    if (action.type === "SWEEP") {
      const hitCell = nextPosition(attacker.position, action.direction);
      for (const target of [world.core, ...world.units])
        if (key(target.position) === key(hitCell)) addDamage(target.id, 1);
    }
    if (action.type === "SHOOT") {
      const target = combatObjects.find(
        (object) => object.controlled && object.id === action.target_id,
      );
      if (
        target &&
        key(target.position) === key(action.expected_cell) &&
        distance(attacker.position, target.position) <= 3 &&
        lineClear(attacker.position, target.position, world.obstacles)
      ) {
        addDamage(target.id, 1);
      }
    }
  }
  for (const target of combatObjects) {
    const amount = damage.get(target.id) ?? 0;
    if (amount === 0) continue;
    if (target.kind === "CORE") applyDamage(target, amount);
    else target.hp -= amount;
  }
  world.units = world.units.filter((unit) => unit.hp > 0);
  world.enemies = world.enemies.filter((unit) => unit.hp > 0);
  const survivingFriendlyIds = new Set(world.units.map((unit) => unit.id));
  for (const [id, unitType] of friendlyBeforeCombat) {
    if (survivingFriendlyIds.has(id)) continue;
    metrics.friendlyUnitsLost += 1;
    if (unitType !== "WORKER") metrics.friendlyCombatUnitsLost += 1;
  }
  if (
    world.beaconCarrierId !== world.core.id &&
    !world.units.some((unit) => unit.id === world.beaconCarrierId)
  ) {
    const fallenCarrier = combatObjects.find(
      (object) => object.id === world.beaconCarrierId,
    );
    if (fallenCarrier) world.beacon = fallenCarrier.position;
    delete world.beaconCarrierId;
  }
  if (world.enemyCore && world.enemyCore.hp <= 0) delete world.enemyCore;
  metrics.enemyUnitsDestroyed += enemyUnitsBefore - world.enemies.length;
  if (enemyCoreBefore !== undefined) {
    metrics.enemyCoreDamage += Math.max(
      0,
      enemyCoreBefore - (world.enemyCore?.hp ?? 0),
    );
    if (!world.enemyCore) metrics.enemyCoreKills += 1;
  }
  metrics.coreDamageTaken += Math.max(
    0,
    coreEffectiveBefore - (world.core.hp + world.core.shield),
  );
  if (key(corePositionBefore) !== key(world.core.position)) {
    metrics.coreMovesCompleted += 1;
    metrics.centerDistanceReduced += Math.max(
      0,
      distance(corePositionBefore, [0, 0]) -
        distance(world.core.position, [0, 0]),
    );
  }

  for (const resource of world.resources.values()) {
    if (
      !resource.available &&
      resource.depletedAtTick !== undefined &&
      tick - resource.depletedAtTick >= 4
    ) {
      resource.available = true;
      delete resource.depletedAtTick;
    }
  }
  if (scenario === "RESOURCE_SCARCE" && tick === 24)
    addResources(world, [
      world.mapPosition([8, 0]),
      world.mapPosition([-8, 0]),
      world.mapPosition([0, 8]),
    ]);
  if (scenario === "MIXED_CAMPAIGN" && tick === 10) {
    world.enemies.push(
      makeUnit(
        uuid(3, world.nextUnitId++),
        "VANGUARD",
        world.mapPosition([8, 0]),
        false,
      ),
    );
    world.enemies.push(
      makeUnit(
        uuid(3, world.nextUnitId++),
        "RANGER",
        world.mapPosition([9, 1]),
        false,
      ),
    );
  }
  if (scenario === "MIXED_CAMPAIGN" && tick === 20) {
    world.enemyCore = {
      kind: "CORE",
      id: uuid(4, world.nextUnitId++),
      owner_username: "simulation-enemy",
      controlled: false,
      position: world.mapPosition([11, 0]),
      hp: 3,
      shield: 0,
      state: "NORMAL",
    };
  }
  if (scenario === "RECURRING_RAIDS") {
    if (tick === 10) {
      addEnemyWave(world, [
        ["VANGUARD", [8, -1]],
        ["VANGUARD", [8, 1]],
      ]);
      metrics.waveStarts += 1;
    }
    if (tick === 22) {
      addEnemyWave(world, [
        ["VANGUARD", [8, -1]],
        ["VANGUARD", [8, 1]],
        ["RANGER", [9, 0]],
      ]);
      metrics.waveStarts += 1;
    }
    if (tick === 36) {
      addEnemyWave(world, [
        ["VANGUARD", [8, -1]],
        ["VANGUARD", [8, 0]],
        ["VANGUARD", [8, 1]],
        ["RANGER", [9, 2]],
      ]);
      metrics.waveStarts += 1;
    }
  }
  if (scenario === "STAGGERED_RANGED_WAVES") {
    if (tick === 10) {
      addEnemyWave(world, [
        ["RANGER", [8, -1]],
        ["RANGER", [8, 1]],
      ]);
      metrics.waveStarts += 1;
    }
    if (tick === 13) {
      addEnemyWave(world, [
        ["VANGUARD", [7, -1]],
        ["VANGUARD", [7, 1]],
      ]);
    }
    if (tick === 26) {
      addEnemyWave(world, [
        ["VANGUARD", [7, 0]],
        ["RANGER", [8, -1]],
        ["RANGER", [8, 1]],
      ]);
      metrics.waveStarts += 1;
    }
    if (tick === 40) {
      addEnemyWave(world, [
        ["VANGUARD", [7, -1]],
        ["VANGUARD", [7, 1]],
        ["RANGER", [8, -1]],
        ["RANGER", [8, 1]],
      ]);
      metrics.waveStarts += 1;
    }
  }
  if (scenario === "PURSUIT_THROUGH_RETREAT") {
    if (tick === 6) {
      addEnemyWave(world, [
        ["VANGUARD", [9, -1]],
        ["VANGUARD", [9, 0]],
        ["VANGUARD", [9, 1]],
        ["RANGER", [10, 2]],
      ]);
      metrics.waveStarts += 1;
    }
    if (tick === 24) {
      addEnemyWave(world, [
        ["VANGUARD", [8, -1]],
        ["VANGUARD", [8, 0]],
        ["VANGUARD", [8, 1]],
        ["RANGER", [9, -2]],
      ]);
      metrics.waveStarts += 1;
    }
  }
  if (scenario === "POST_LOSS_REATTACK") {
    if (tick === 8) {
      addEnemyWave(world, [
        ["VANGUARD", [8, -1]],
        ["VANGUARD", [8, 0]],
        ["VANGUARD", [8, 1]],
        ["RANGER", [9, 2]],
      ]);
      metrics.waveStarts += 1;
    }
    if (tick === 26) {
      addEnemyWave(world, [
        ["VANGUARD", [8, -1]],
        ["VANGUARD", [8, 1]],
        ["RANGER", [9, -1]],
        ["RANGER", [9, 1]],
      ]);
      metrics.waveStarts += 1;
    }
    if (tick === 42) {
      addEnemyWave(world, [
        ["VANGUARD", [8, -1]],
        ["VANGUARD", [8, 0]],
        ["VANGUARD", [8, 1]],
        ["RANGER", [9, 0]],
      ]);
      metrics.waveStarts += 1;
    }
  }
}

export function runEpisode(
  scenario: ScenarioKind,
  seed: number,
  tickCount = 48,
  trace?: (entry: SimulationTrace) => void,
): SimulationMetrics {
  const world = createWorld(scenario, seed);
  let memory = emptyMemory();
  const workerCells = new Set<string>();
  const workerFrontier: Record<string, Position> = {};
  const defenderCells = new Set<string>();
  let firstVisibleResourceTick: number | undefined;
  let responseRecorded = false;
  let firstVisibleThreatTick: number | undefined;
  let defenseResponseRecorded = false;
  let firstVisibleEnemyCoreTick: number | undefined;
  let offenseCompletionRecorded = false;
  let controlOpportunityStartedAt: number | undefined;
  let controlEstablishmentRecorded = false;
  let combatDeficitStartedAt: number | undefined;
  const metrics: SimulationMetrics = {
    scenario,
    seed,
    ticks: 0,
    invalidPlans: 0,
    coreDeaths: 0,
    resourcesHarvested: 0,
    resourcesDeposited: 0,
    deliveredOrInTransit: 0,
    harvestAttempts: 0,
    harvestFailures: 0,
    depositAttempts: 0,
    visibleResourceCellTicks: 0,
    uncollectedVisibleResourceCellTicks: 0,
    resourceResponseTicks: 0,
    resourceResponseSamples: 0,
    workerActions: 0,
    productiveWorkerActions: 0,
    workerWaitActions: 0,
    emptyWorkerWaitTicks: 0,
    workerMoveActions: 0,
    workerMovesResolved: 0,
    workerDistanceTicks: 0,
    workerPositionSamples: 0,
    cargoDistanceTicks: 0,
    cargoWorkerSamples: 0,
    harvestDistance: 0,
    longHaulWorkerTicks: 0,
    workerSectorCollisionTicks: 0,
    distinctWorkerCells: 0,
    maxWorkerDistance: 0,
    exploredCells: 0,
    frontierGrowthTicks: 0,
    balancedFrontierSectors: 0,
    frontierRadiusSpread: 0,
    workerBalancedFrontierSectors: 0,
    workerFrontierRadiusSpread: 0,
    maxExploredDistance: 0,
    attacks: 0,
    attackHits: 0,
    shootAttempts: 0,
    shootHits: 0,
    workerShootAttempts: 0,
    workerShootHits: 0,
    vanguardShootAttempts: 0,
    vanguardShootHits: 0,
    rangerShootAttempts: 0,
    rangerShootHits: 0,
    coreShootAttempts: 0,
    coreShootHits: 0,
    sweepAttempts: 0,
    sweepHits: 0,
    enemyUnitsDestroyed: 0,
    enemyCoreDamage: 0,
    enemyCoreKills: 0,
    offenseCompletionTicks: 0,
    offenseCompletionSamples: 0,
    advanceAssignments: 0,
    engageAssignments: 0,
    defensiveResponses: 0,
    withdrawals: 0,
    mapControlAssignments: 0,
    outerControlUnitTicks: 0,
    combatCellTicks: 0,
    distinctDefenderCells: 0,
    maxCombatDistance: 0,
    friendlyUnitsLost: 0,
    friendlyCombatUnitsLost: 0,
    threatObservationTicks: 0,
    defenseResponseTicks: 0,
    defenseResponseSamples: 0,
    innerBreachTicks: 0,
    minimumCoreEffectiveHealth: world.core.hp + world.core.shield,
    controlSectorTicks: 0,
    controlVisionSectorTicks: 0,
    supportedControlVisionSectorTicks: 0,
    outerControlAssignmentTicks: 0,
    supportedOuterControlAssignmentTicks: 0,
    mapControlOpportunityTicks: 0,
    mapControlEstablishmentTicks: 0,
    mapControlEstablishmentSamples: 0,
    unsupportedOuterControlTicks: 0,
    coreDamageTaken: 0,
    coreMovesCompleted: 0,
    centerDistanceReduced: 0,
    unitsSpawned: 0,
    workerSpawns: 0,
    vanguardSpawns: 0,
    rangerSpawns: 0,
    combatUnitTicks: 0,
    combatPowerTicks: 0,
    militaryReadinessTicks: 0,
    militaryDeficitTicks: 0,
    combatReplacementTicks: 0,
    combatReplacementSamples: 0,
    waveStarts: 0,
    peakPopulation: world.units.length,
    endingResources: world.storedResources,
    friendlyOverCapacity: 0,
    endingCargo: 0,
    postureTicks: {
      RECOVER: 0,
      ECONOMY: 0,
      HOLD: 0,
      CONTEST: 0,
      ATTACK: 0,
      REGROUP: 0,
    },
  };
  for (let tick = 1; tick <= tickCount; tick += 1) {
    const startingCombatUnits = world.units.filter(
      (unit) => unit.unit_type !== "WORKER",
    );
    const startingCombatFloor = simulationCombatFloor(world.units);
    metrics.combatUnitTicks += startingCombatUnits.length;
    metrics.combatPowerTicks += simulationCombatPower(startingCombatUnits);
    if (startingCombatUnits.length >= startingCombatFloor) {
      metrics.militaryReadinessTicks += 1;
      if (combatDeficitStartedAt !== undefined) {
        metrics.combatReplacementTicks += tick - combatDeficitStartedAt;
        metrics.combatReplacementSamples += 1;
        combatDeficitStartedAt = undefined;
      }
    } else {
      metrics.militaryDeficitTicks += 1;
      if (metrics.waveStarts > 0) combatDeficitStartedAt ??= tick;
    }
    const state = privateState(world);
    const visibleCombatThreats = state.objects.filter(
      (object): object is UnitObject =>
        object.kind === "UNIT" &&
        !object.controlled &&
        object.unit_type !== "WORKER",
    );
    const credibleCoreThreats = visibleCombatThreats.filter(
      (enemy) =>
        distance(enemy.position, world.core.position) <=
          DEFAULT_CONFIG.threatCoreRadius ||
        (enemy.unit_type === "RANGER" &&
          lineClear(enemy.position, world.core.position, world.obstacles)),
    );
    if (visibleCombatThreats.length > 0) {
      metrics.threatObservationTicks += 1;
    }
    if (credibleCoreThreats.length > 0) {
      firstVisibleThreatTick ??= tick;
    }
    if (
      firstVisibleEnemyCoreTick === undefined &&
      state.objects.some(
        (object) => object.kind === "CORE" && !object.controlled,
      )
    ) {
      firstVisibleEnemyCoreTick = tick;
    }
    const visibleResources = state.objects.flatMap((object) =>
      object.kind === "RESOURCE" ? object.positions : [],
    );
    metrics.visibleResourceCellTicks += visibleResources.length;
    metrics.uncollectedVisibleResourceCellTicks += visibleResources.filter(
      (resource) =>
        !world.units.some(
          (unit) =>
            unit.unit_type === "WORKER" &&
            (unit.cargo ?? 0) === 0 &&
            key(unit.position) === key(resource),
        ),
    ).length;
    if (visibleResources.length > 0 && firstVisibleResourceTick === undefined)
      firstVisibleResourceTick = tick;
    const exploredBefore = Object.keys(memory.explored).length;
    const result = planTick(tick, state, memory, undefined, () => 0);
    memory = result.memory;
    if (Object.keys(memory.explored).length > exploredBefore)
      metrics.frontierGrowthTicks += 1;
    trace?.({
      tick,
      corePosition: world.core.position,
      coreHp: world.core.hp,
      coreShield: world.core.shield,
      storedResources: world.storedResources,
      friendlyUnits: world.units.map(({ id, unit_type, position: at, hp }) => ({
        id,
        unit_type,
        position: at,
        hp,
      })),
      enemies: world.enemies.map(({ id, unit_type, position: at, hp }) => ({
        id,
        unit_type,
        position: at,
        hp,
      })),
      ...(world.enemyCore
        ? {
            enemyCore: {
              id: world.enemyCore.id,
              position: world.enemyCore.position,
              hp: world.enemyCore.hp,
              shield: world.enemyCore.shield,
            },
          }
        : {}),
      plan: result.plan,
      roles: structuredClone(memory.roles),
      posture: result.summary.posture,
      retreating: result.summary.retreating,
      controlRadius: result.summary.controlRadius,
      reserveCount: result.summary.reserveCount,
    });
    metrics.ticks += 1;
    metrics.postureTicks[result.summary.posture] += 1;
    if (!validatePlan(result.plan, state)) metrics.invalidPlans += 1;
    const actions = Object.entries(result.plan.unit_actions ?? {});
    let combatActions = 0;
    for (const [id, action] of actions) {
      const unit = world.units.find((candidate) => candidate.id === id);
      if (unit?.unit_type === "WORKER") {
        metrics.workerActions += 1;
        if (action.type === "WAIT") {
          metrics.workerWaitActions += 1;
          if ((unit.cargo ?? 0) === 0) metrics.emptyWorkerWaitTicks += 1;
        }
        if (action.type === "MOVE") metrics.workerMoveActions += 1;
        if (action.type === "HARVEST") {
          metrics.harvestAttempts += 1;
          metrics.productiveWorkerActions += 1;
        }
        if (action.type === "DEPOSIT") {
          metrics.depositAttempts += 1;
          metrics.productiveWorkerActions += 1;
        }
      }
      if (action.type === "SWEEP" || action.type === "SHOOT") {
        metrics.attacks += 1;
        combatActions += 1;
      }
    }
    const activeIds = new Set(world.units.map((unit) => unit.id));
    const defensiveRoleCount = roleCount(memory, DEFENSE_ROLES, activeIds);
    const threatResponseRoleCount = roleCount(
      memory,
      THREAT_RESPONSE_ROLES,
      activeIds,
    );
    metrics.defensiveResponses += defensiveRoleCount;
    if (
      !defenseResponseRecorded &&
      firstVisibleThreatTick !== undefined &&
      (threatResponseRoleCount > 0 || combatActions > 0)
    ) {
      metrics.defenseResponseTicks += tick - firstVisibleThreatTick;
      metrics.defenseResponseSamples += 1;
      defenseResponseRecorded = true;
    }
    metrics.withdrawals += roleCount(
      memory,
      new Set<RoleKind>(["WITHDRAW"]),
      activeIds,
    );
    metrics.advanceAssignments += roleCount(
      memory,
      new Set<RoleKind>(["RALLY", "ADVANCE"]),
      activeIds,
    );
    metrics.engageAssignments += roleCount(
      memory,
      new Set<RoleKind>(["ENGAGE"]),
      activeIds,
    );
    metrics.mapControlAssignments += roleCount(
      memory,
      CONTROL_ROLES,
      activeIds,
    );
    const combatUnits = world.units.filter(
      (unit) => unit.unit_type !== "WORKER",
    );
    const plannedCombatPositions = new Map(
      combatUnits.map((unit) => {
        const action = result.plan.unit_actions?.[unit.id];
        return [
          unit.id,
          action?.type === "MOVE"
            ? nextPosition(unit.position, action.direction)
            : unit.position,
        ] as const;
      }),
    );
    const supportUnits = combatUnits.filter((unit) => {
      const role = memory.roles[unit.id];
      return role && SUPPORT_ROLES.has(role.kind);
    });
    const supportPositions = supportUnits.map(
      (unit) => plannedCombatPositions.get(unit.id) ?? unit.position,
    );
    metrics.combatCellTicks += new Set(
      combatUnits.map((unit) =>
        key(plannedCombatPositions.get(unit.id) ?? unit.position),
      ),
    ).size;
    const controlSectors = new Set<number>();
    const controlVisionSectors = new Set<number>();
    const supportedControlVisionSectors = new Set<number>();
    const controlOpportunity =
      combatUnits.length >= 2 &&
      visibleCombatThreats.length === 0 &&
      result.summary.posture !== "ATTACK" &&
      result.summary.posture !== "REGROUP" &&
      result.summary.posture !== "RECOVER";
    if (controlOpportunity) {
      metrics.mapControlOpportunityTicks += 1;
      controlOpportunityStartedAt ??= tick;
    } else {
      controlOpportunityStartedAt = undefined;
      controlEstablishmentRecorded = false;
    }
    for (const unit of world.units) {
      const metricPosition =
        unit.unit_type === "WORKER"
          ? unit.position
          : (plannedCombatPositions.get(unit.id) ?? unit.position);
      const coreDistance = distance(world.core.position, metricPosition);
      if (unit.unit_type === "WORKER") {
        workerCells.add(key(unit.position));
        workerFrontier[key(unit.position)] = unit.position;
        metrics.workerDistanceTicks += coreDistance;
        metrics.workerPositionSamples += 1;
        if ((unit.cargo ?? 0) > 0) {
          metrics.cargoDistanceTicks += coreDistance;
          metrics.cargoWorkerSamples += 1;
        }
        if (
          coreDistance >
          result.summary.controlRadius +
            DEFAULT_CONFIG.resourceScarcityScoutExtension
        ) {
          metrics.longHaulWorkerTicks += 1;
        }
        metrics.maxWorkerDistance = Math.max(
          metrics.maxWorkerDistance,
          coreDistance,
        );
      } else {
        metrics.maxCombatDistance = Math.max(
          metrics.maxCombatDistance,
          coreDistance,
        );
        const role = memory.roles[unit.id];
        if (role && CONTROL_ROLES.has(role.kind)) {
          const established = hasVision(
            metricPosition,
            role.anchor,
            VISION[unit.unit_type],
            world.obstacles,
          );
          if (!established) continue;
          defenderCells.add(key(metricPosition));
          const supported = supportPositions.some(
            (supportPosition) =>
              distance(supportPosition, metricPosition) <=
              result.summary.supportResponseTicks,
          );
          for (const visionCell of cellsWithin(
            metricPosition,
            VISION[unit.unit_type],
          )) {
            if (
              distance(world.core.position, visionCell) < 3 ||
              !hasVision(
                metricPosition,
                visionCell,
                VISION[unit.unit_type],
                world.obstacles,
              )
            ) {
              continue;
            }
            const sector = angularSector(world.core.position, visionCell);
            controlVisionSectors.add(sector);
            if (supported) supportedControlVisionSectors.add(sector);
          }
          if (coreDistance >= 3) {
            metrics.outerControlAssignmentTicks += 1;
            controlSectors.add(
              angularSector(world.core.position, metricPosition),
            );
            if (supported) {
              metrics.supportedOuterControlAssignmentTicks += 1;
            } else {
              metrics.unsupportedOuterControlTicks += 1;
            }
          }
        }
        if (
          coreDistance >= Math.max(3, result.summary.controlRadius - 2) &&
          coreDistance <= result.summary.controlRadius + 1
        )
          metrics.outerControlUnitTicks += 1;
      }
    }
    metrics.controlSectorTicks += controlSectors.size;
    metrics.controlVisionSectorTicks += controlVisionSectors.size;
    metrics.supportedControlVisionSectorTicks +=
      supportedControlVisionSectors.size;
    if (
      controlOpportunity &&
      !controlEstablishmentRecorded &&
      supportedControlVisionSectors.size >= 2 &&
      controlOpportunityStartedAt !== undefined
    ) {
      metrics.mapControlEstablishmentTicks +=
        tick - controlOpportunityStartedAt;
      metrics.mapControlEstablishmentSamples += 1;
      controlEstablishmentRecorded = true;
    }
    const outerScouts = world.units.filter(
      (unit) =>
        unit.unit_type === "WORKER" &&
        (unit.cargo ?? 0) === 0 &&
        distance(world.core.position, unit.position) >= 4,
    );
    metrics.workerSectorCollisionTicks += Math.max(
      0,
      outerScouts.length -
        new Set(
          outerScouts.map((unit) =>
            angularSector(world.core.position, unit.position),
          ),
        ).size,
    );
    const harvestedBefore = metrics.resourcesHarvested;
    resolveTick(tick, scenario, world, result.plan, metrics);
    metrics.minimumCoreEffectiveHealth = Math.min(
      metrics.minimumCoreEffectiveHealth,
      world.core.hp + world.core.shield,
    );
    if (
      world.enemies.some(
        (enemy) =>
          enemy.unit_type !== "WORKER" &&
          distance(enemy.position, world.core.position) <= 3,
      )
    ) {
      metrics.innerBreachTicks += 1;
    }
    if (
      !offenseCompletionRecorded &&
      firstVisibleEnemyCoreTick !== undefined &&
      !world.enemyCore
    ) {
      metrics.offenseCompletionTicks += tick - firstVisibleEnemyCoreTick;
      metrics.offenseCompletionSamples += 1;
      offenseCompletionRecorded = true;
    }
    metrics.peakPopulation = Math.max(
      metrics.peakPopulation,
      world.units.length,
    );
    if (
      !responseRecorded &&
      metrics.resourcesHarvested > harvestedBefore &&
      firstVisibleResourceTick !== undefined
    ) {
      metrics.resourceResponseTicks += tick - firstVisibleResourceTick;
      metrics.resourceResponseSamples += 1;
      responseRecorded = true;
    }
    const counts = new Map<string, number>();
    for (const unit of world.units)
      counts.set(key(unit.position), (counts.get(key(unit.position)) ?? 0) + 1);
    metrics.friendlyOverCapacity += [...counts.values()].filter(
      (count) => count > 2,
    ).length;
    if (world.core.hp <= 0) {
      metrics.coreDeaths += 1;
      break;
    }
  }
  if (combatDeficitStartedAt !== undefined) {
    metrics.combatReplacementTicks +=
      metrics.ticks - combatDeficitStartedAt + 1;
    metrics.combatReplacementSamples += 1;
  }
  metrics.exploredCells = Object.keys(memory.explored).length;
  const frontier = frontierProfile(world.core.position, memory.explored);
  metrics.balancedFrontierSectors = frontier.balancedSectors;
  metrics.frontierRadiusSpread = frontier.radiusSpread;
  metrics.maxExploredDistance = frontier.maxDistance;
  const workerProfile = frontierProfile(world.core.position, workerFrontier);
  metrics.workerBalancedFrontierSectors = workerProfile.balancedSectors;
  metrics.workerFrontierRadiusSpread = workerProfile.radiusSpread;
  metrics.distinctWorkerCells = workerCells.size;
  metrics.distinctDefenderCells = defenderCells.size;
  metrics.endingResources = world.storedResources;
  metrics.endingCargo = world.units.reduce(
    (sum, unit) => sum + (unit.cargo ?? 0),
    0,
  );
  metrics.deliveredOrInTransit =
    metrics.resourcesDeposited + metrics.endingCargo;
  return metrics;
}

export const SCENARIOS: readonly ScenarioKind[] = [
  "RESOURCE_RICH",
  "RESOURCE_SCARCE",
  "CHOKEPOINT_ECONOMY",
  "WORKER_HARASSMENT",
  "CORE_ASSAULT",
  "RANGED_PRESSURE",
  "FAVORABLE_ATTACK",
  "OVERWHELMING_FORCE",
  "MAP_CONTROL",
  "MIXED_CAMPAIGN",
  "RECURRING_RAIDS",
  "STAGGERED_RANGED_WAVES",
  "PURSUIT_THROUGH_RETREAT",
  "POST_LOSS_REATTACK",
];

const MULTI_WAVE_SCENARIOS = new Set<ScenarioKind>([
  "RECURRING_RAIDS",
  "STAGGERED_RANGED_WAVES",
  "PURSUIT_THROUGH_RETREAT",
  "POST_LOSS_REATTACK",
]);

export function runComprehensiveSimulation(): SimulationReport {
  const episodes = SCENARIOS.flatMap((scenario) =>
    Array.from({ length: 10 }, (_, index) =>
      runEpisode(
        scenario,
        index + 1,
        MULTI_WAVE_SCENARIOS.has(scenario) ? 64 : 48,
      ),
    ),
  );
  const totals = episodes.reduce(
    (sum, episode) => {
      for (const metric of Object.keys(sum) as Array<keyof typeof sum>)
        sum[metric] += episode[metric];
      return sum;
    },
    {
      ticks: 0,
      invalidPlans: 0,
      coreDeaths: 0,
      resourcesHarvested: 0,
      resourcesDeposited: 0,
      deliveredOrInTransit: 0,
      harvestAttempts: 0,
      harvestFailures: 0,
      depositAttempts: 0,
      visibleResourceCellTicks: 0,
      uncollectedVisibleResourceCellTicks: 0,
      resourceResponseTicks: 0,
      resourceResponseSamples: 0,
      workerActions: 0,
      productiveWorkerActions: 0,
      workerWaitActions: 0,
      emptyWorkerWaitTicks: 0,
      workerMoveActions: 0,
      workerMovesResolved: 0,
      workerDistanceTicks: 0,
      workerPositionSamples: 0,
      cargoDistanceTicks: 0,
      cargoWorkerSamples: 0,
      harvestDistance: 0,
      longHaulWorkerTicks: 0,
      workerSectorCollisionTicks: 0,
      distinctWorkerCells: 0,
      maxWorkerDistance: 0,
      exploredCells: 0,
      frontierGrowthTicks: 0,
      balancedFrontierSectors: 0,
      frontierRadiusSpread: 0,
      workerBalancedFrontierSectors: 0,
      workerFrontierRadiusSpread: 0,
      maxExploredDistance: 0,
      attacks: 0,
      attackHits: 0,
      shootAttempts: 0,
      shootHits: 0,
      workerShootAttempts: 0,
      workerShootHits: 0,
      vanguardShootAttempts: 0,
      vanguardShootHits: 0,
      rangerShootAttempts: 0,
      rangerShootHits: 0,
      coreShootAttempts: 0,
      coreShootHits: 0,
      sweepAttempts: 0,
      sweepHits: 0,
      enemyUnitsDestroyed: 0,
      enemyCoreDamage: 0,
      enemyCoreKills: 0,
      offenseCompletionTicks: 0,
      offenseCompletionSamples: 0,
      advanceAssignments: 0,
      engageAssignments: 0,
      defensiveResponses: 0,
      withdrawals: 0,
      mapControlAssignments: 0,
      outerControlUnitTicks: 0,
      combatCellTicks: 0,
      distinctDefenderCells: 0,
      maxCombatDistance: 0,
      friendlyUnitsLost: 0,
      friendlyCombatUnitsLost: 0,
      threatObservationTicks: 0,
      defenseResponseTicks: 0,
      defenseResponseSamples: 0,
      innerBreachTicks: 0,
      minimumCoreEffectiveHealth: 0,
      controlSectorTicks: 0,
      controlVisionSectorTicks: 0,
      supportedControlVisionSectorTicks: 0,
      outerControlAssignmentTicks: 0,
      supportedOuterControlAssignmentTicks: 0,
      mapControlOpportunityTicks: 0,
      mapControlEstablishmentTicks: 0,
      mapControlEstablishmentSamples: 0,
      unsupportedOuterControlTicks: 0,
      coreDamageTaken: 0,
      coreMovesCompleted: 0,
      centerDistanceReduced: 0,
      unitsSpawned: 0,
      workerSpawns: 0,
      vanguardSpawns: 0,
      rangerSpawns: 0,
      combatUnitTicks: 0,
      combatPowerTicks: 0,
      militaryReadinessTicks: 0,
      militaryDeficitTicks: 0,
      combatReplacementTicks: 0,
      combatReplacementSamples: 0,
      waveStarts: 0,
      peakPopulation: 0,
      endingResources: 0,
      friendlyOverCapacity: 0,
      endingCargo: 0,
    },
  );
  return { episodes, totals };
}

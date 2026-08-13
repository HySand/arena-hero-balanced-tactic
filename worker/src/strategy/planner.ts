import type {
  CommandPlan,
  ChampionBeacon,
  CoreAction,
  CoreObject,
  DecisionSummary,
  Direction,
  EnemyObservation,
  PlanResult,
  PlayerState,
  Position,
  Posture,
  RoleMemory,
  StrategyMemory,
  UnitAction,
  UnitObject,
  UnitType,
} from "../contracts";
import { DEFAULT_CONFIG, type StrategyConfig } from "./config";
import {
  DIRECTIONS,
  cellsWithin,
  directionBetween,
  distance,
  findPathWithOptions,
  findWeightedPath,
  findStep,
  hasVision,
  key,
  lineClear,
  nextPosition,
} from "./geometry";

interface Snapshot {
  core?: CoreObject;
  units: UnitObject[];
  enemies: Array<CoreObject | UnitObject>;
  obstacles: Set<string>;
  resources: Set<string>;
  occupied: Set<string>;
}

interface Assessment {
  threatened: boolean;
  visibleEnemyPower: number;
  tacticalEnemyPower: number;
  friendlyCombatPower: number;
  materialLoss: boolean;
  retreatRequired: boolean;
  workerCount: number;
  combatCount: number;
  reserveIds: Set<string>;
  controlIds: Set<string>;
  responseIds: Set<string>;
  chokepoints: Position[];
  observationPosts: Position[];
  controlRadius: number;
  supportResponseTicks: number;
  supportAnchor: Position;
  supportPositions: Position[];
  reserveAnchors: Record<string, Position>;
  responseThreat?: UnitObject;
  posture: Posture;
}

interface CombatFormationOrder {
  objective: Position;
  formationCell: Position;
  phase: "RALLY" | "ADVANCE";
}

interface MilitaryReadiness {
  targetWorkerShare: number;
  minimumCombatCount: number;
  minimumCombatPower: number;
  combatCountDeficit: number;
  combatPowerDeficit: number;
  desiredVanguards: number;
  desiredRangers: number;
  formationIncomplete: boolean;
  rebuilding: boolean;
}

const SPAWN_COSTS: Readonly<Record<UnitType, number>> = {
  WORKER: 5,
  VANGUARD: 10,
  RANGER: 12,
};

export function emptyMemory(): StrategyMemory {
  return {
    obstacles: {},
    explored: {},
    workerExplored: {},
    resources: {},
    enemies: {},
    patrolVisits: {},
    roles: {},
    posture: "RECOVER",
    postureSinceTick: 0,
    previousPopulation: 0,
    recentHarvestFailures: 0,
    nearbyResourceDryTicks: 0,
    safeExpansionTicks: 0,
    previousCombatUnitIds: [],
    recentCombatLosses: 0,
    militaryPressureTicks: 0,
    militaryCalmTicks: 0,
    workerDutyScoutUntil: {},
    workerLastMove: {},
    workerHarvestGoal: {},
    workerHarvestVisited: {},
    workerHarvestPath: {},
    workerScoutTarget: {},
  };
}

function snapshot(state: PlayerState): Snapshot {
  const result: Snapshot = {
    units: [],
    enemies: [],
    obstacles: new Set<string>(),
    resources: new Set<string>(),
    occupied: new Set<string>(),
  };
  for (const object of state.objects) {
    if ("positions" in object && object.kind === "OBSTACLE") {
      for (const position of object.positions) {
        result.obstacles.add(key(position));
      }
      continue;
    }
    if ("positions" in object && object.kind === "RESOURCE") {
      for (const position of object.positions)
        result.resources.add(key(position));
      continue;
    }
    if ("positions" in object) continue;
    result.occupied.add(key(object.position));
    if (!object.controlled) result.enemies.push(object);
    else if (object.kind === "CORE") result.core = object;
    else result.units.push(object);
  }
  result.units.sort((a, b) => a.id.localeCompare(b.id));
  result.enemies.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

function visibilityRadius(unit: UnitObject | CoreObject): number {
  if (unit.kind === "CORE") return 5;
  if (unit.unit_type === "WORKER") return 3;
  if (unit.unit_type === "VANGUARD") return 4;
  return 5;
}

function visibleToFriendly(
  position: Position,
  view: Snapshot,
  obstacles: ReadonlySet<string>,
): boolean {
  const friendly: Array<UnitObject | CoreObject> = [...view.units];
  if (view.core) friendly.push(view.core);
  return friendly.some((entity) =>
    hasVision(entity.position, position, visibilityRadius(entity), obstacles),
  );
}

function updateMemory(
  tick: number,
  state: PlayerState,
  view: Snapshot,
  previous: StrategyMemory,
  config: StrategyConfig,
): StrategyMemory {
  const memory: StrategyMemory = structuredClone(previous);
  memory.workerExplored ??= {};
  memory.workerDutyScoutUntil ??= {};
  memory.workerLastMove ??= {};
  memory.workerHarvestGoal ??= {};
  memory.workerHarvestVisited ??= {};
  memory.workerHarvestPath ??= {};
  memory.workerScoutTarget ??= {};
  memory.previousCombatUnitIds ??= [];
  memory.recentCombatLosses ??= 0;
  memory.militaryPressureTicks ??= 0;
  memory.militaryCalmTicks ??= 0;
  for (const obstacle of view.obstacles) {
    const parsed = parseKey(obstacle);
    if (parsed) memory.obstacles[obstacle] = parsed;
  }

  const visibleCells = new Set<string>();
  const knownObstacles = new Set(Object.keys(memory.obstacles));
  const friendly: Array<UnitObject | CoreObject> = [...view.units];
  if (view.core) friendly.push(view.core);
  for (const entity of friendly) {
    for (const position of cellsWithin(
      entity.position,
      visibilityRadius(entity),
    )) {
      if (
        hasVision(
          entity.position,
          position,
          visibilityRadius(entity),
          knownObstacles,
        )
      ) {
        visibleCells.add(key(position));
        if (!knownObstacles.has(key(position)))
          memory.explored[key(position)] = position;
      }
    }
  }
  for (const worker of view.units.filter(
    (unit) => unit.unit_type === "WORKER",
  )) {
    memory.workerExplored[key(worker.position)] = worker.position;
  }
  for (const visible of visibleCells) {
    const resource = memory.resources[visible];
    if (!view.resources.has(visible) && resource) {
      if (resource.depletedAtTick === undefined) resource.depletedAtTick = tick;
    }
  }
  for (const resource of view.resources) {
    const parsed = parseKey(resource);
    if (parsed) {
      memory.resources[resource] = { position: parsed, lastSeenTick: tick };
    }
  }
  for (const enemy of view.enemies) {
    for (const resource of Object.values(memory.resources)) {
      if (distance(enemy.position, resource.position) <= 3) {
        resource.contestedAtTick = tick;
      }
    }
  }
  for (const [resourceKey, resource] of Object.entries(memory.resources)) {
    if (
      resource.contestedAtTick !== undefined &&
      tick - resource.contestedAtTick > config.resourceMemoryTicks
    ) {
      delete memory.resources[resourceKey];
    }
  }

  for (const enemy of view.enemies) {
    const previousEnemy = memory.enemies[enemy.id];
    const observedMove = previousEnemy
      ? directionBetween(previousEnemy.position, enemy.position)
      : undefined;
    const observation: EnemyObservation = {
      id: enemy.id,
      kind: enemy.kind,
      position: enemy.position,
      hp: enemy.hp,
      lastSeenTick: tick,
    };
    if (
      observedMove &&
      distance(previousEnemy?.position ?? enemy.position, enemy.position) === 1
    ) {
      observation.lastMove = observedMove;
      observation.movementStreak =
        previousEnemy?.lastMove === observedMove
          ? (previousEnemy.movementStreak ?? 1) + 1
          : 1;
    }
    if (enemy.kind === "UNIT") observation.unitType = enemy.unit_type;
    memory.enemies[enemy.id] = observation;
  }
  const visibleEnemyIds = new Set(view.enemies.map((enemy) => enemy.id));
  for (const [id, enemy] of Object.entries(memory.enemies)) {
    if (
      (!visibleEnemyIds.has(id) && visibleCells.has(key(enemy.position))) ||
      tick - enemy.lastSeenTick > config.enemyLocalizedTicks * 4
    ) {
      delete memory.enemies[id];
    }
  }

  const crediblePressure = Object.values(memory.enemies).some(
    (enemy) =>
      enemy.unitType !== "WORKER" &&
      tick - enemy.lastSeenTick <= config.enemyLocalizedTicks,
  );
  const currentCombatIds = new Set(
    view.units
      .filter((unit) => unit.unit_type !== "WORKER")
      .map((unit) => unit.id),
  );
  const confirmedCombatLosses = memory.previousCombatUnitIds.filter(
    (id) => !currentCombatIds.has(id),
  ).length;
  const coreEffectiveHealth = view.core
    ? view.core.hp + view.core.shield
    : Number.POSITIVE_INFINITY;
  const severeCoreDamage = coreEffectiveHealth <= 5;
  const militaryPressure =
    crediblePressure || confirmedCombatLosses > 0 || severeCoreDamage;
  memory.militaryPressureTicks = militaryPressure
    ? config.militaryPressureHorizonTicks
    : Math.max(0, memory.militaryPressureTicks - 1);
  if (confirmedCombatLosses > 0) {
    memory.recentCombatLosses = Math.min(
      config.combatLossMemoryCap,
      memory.recentCombatLosses + confirmedCombatLosses,
    );
  }
  if (militaryPressure || memory.militaryPressureTicks > 0) {
    memory.militaryCalmTicks = 0;
  } else {
    memory.militaryCalmTicks += 1;
    if (
      memory.militaryCalmTicks >= config.combatLossDecayTicks &&
      memory.recentCombatLosses > 0
    ) {
      memory.recentCombatLosses -= 1;
      memory.militaryCalmTicks = 0;
    }
  }
  memory.safeExpansionTicks = crediblePressure
    ? 0
    : Math.min(
        config.safeExpansionInterval * 4,
        (previous.safeExpansionTicks ?? 0) + 1,
      );

  memory.recentHarvestFailures = state.events.filter(
    (event) => event.event_type === "HARVEST_FAILED",
  ).length;
  if (view.core) {
    const nearbyResources = Object.values(memory.resources).filter(
      (resource) =>
        distance(resource.position, view.core?.position ?? resource.position) <=
        6,
    );
    const availableNearby = nearbyResources.some((resource) =>
      view.resources.has(key(resource.position)),
    );
    const ordinaryReplenishment = nearbyResources.some(
      (resource) =>
        resource.depletedAtTick !== undefined &&
        tick - resource.depletedAtTick < config.resourceReplenishTicks,
    );
    memory.nearbyResourceDryTicks = availableNearby
      ? 0
      : ordinaryReplenishment
        ? Math.max(0, memory.nearbyResourceDryTicks - 1)
        : memory.nearbyResourceDryTicks + 1;
  }
  return memory;
}

function unitPower(unit: UnitObject | EnemyObservation): number {
  const type = "unit_type" in unit ? unit.unit_type : unit.unitType;
  if (type === "VANGUARD") return 4;
  if (type === "RANGER") return 3;
  return 0.5;
}

function parseKey(value: string): Position | undefined {
  const parts = value.split(",");
  if (parts.length !== 2) return undefined;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  return Number.isSafeInteger(x) && Number.isSafeInteger(y)
    ? [x, y]
    : undefined;
}

function enemyPower(enemy: CoreObject | UnitObject): number {
  return enemy.kind === "CORE" ? 5 : unitPower(enemy);
}

function strongestEnemyCluster(enemies: readonly UnitObject[]): number {
  return enemies.reduce((strongest, anchor) => {
    const cluster = enemies
      .filter((enemy) => distance(anchor.position, enemy.position) <= 4)
      .reduce((sum, enemy) => sum + unitPower(enemy), 0);
    return Math.max(strongest, cluster);
  }, 0);
}

function isEnemyWorker(
  enemy: CoreObject | UnitObject,
): enemy is UnitObject & { unit_type: "WORKER" } {
  return enemy.kind === "UNIT" && enemy.unit_type === "WORKER";
}

function nearbyGuardPower(
  target: UnitObject,
  enemies: readonly (CoreObject | UnitObject)[],
): number {
  return enemies
    .filter(
      (enemy): enemy is UnitObject =>
        enemy.kind === "UNIT" &&
        enemy.unit_type !== "WORKER" &&
        distance(enemy.position, target.position) <= 4,
    )
    .reduce((sum, enemy) => sum + unitPower(enemy), 0);
}

function nearbyFriendlyPower(
  target: Position,
  units: readonly UnitObject[],
): number {
  return units
    .filter(
      (unit) =>
        unit.unit_type !== "WORKER" && distance(unit.position, target) <= 5,
    )
    .reduce((sum, unit) => sum + unitPower(unit), 0);
}

function valuableWorkerIntrusion(
  worker: UnitObject,
  core: CoreObject,
  resources: Readonly<Record<string, { position: Position }>>,
  controlRadius: number,
): boolean {
  const contestsResource = Object.values(resources).some(
    (resource) => distance(resource.position, worker.position) <= 2,
  );
  const blocksReturnCorridor = Object.values(resources).some(
    (resource) =>
      distance(core.position, worker.position) <
        distance(core.position, resource.position) &&
      distance(worker.position, resource.position) <= 4,
  );
  return (
    contestsResource ||
    blocksReturnCorridor ||
    distance(core.position, worker.position) <= controlRadius
  );
}

function buildDanger(
  tick: number,
  view: Snapshot,
  memory: StrategyMemory,
  config: StrategyConfig,
): Map<string, number> {
  const danger = new Map<string, number>();
  const visibleEnemyIds = new Set(view.enemies.map((enemy) => enemy.id));
  const addDanger = (position: Position, value: number): void => {
    const positionKey = key(position);
    danger.set(positionKey, (danger.get(positionKey) ?? 0) + value);
  };
  for (const enemy of Object.values(memory.enemies)) {
    if (visibleEnemyIds.has(enemy.id)) continue;
    const age = tick - enemy.lastSeenTick;
    const radius = Math.min(config.enemyLocalizedTicks, Math.max(1, age + 1));
    const value =
      unitPower(enemy) *
      Math.max(0.2, 1 - age / (config.enemyLocalizedTicks * 4));
    for (const position of cellsWithin(enemy.position, radius))
      addDanger(position, value);
  }
  for (const enemy of view.enemies) {
    if (enemy.kind === "UNIT" && enemy.unit_type === "RANGER") {
      for (const [, delta] of DIRECTIONS) {
        for (let range = 1; range <= 3; range += 1) {
          const position: Position = [
            enemy.position[0] + delta[0] * range,
            enemy.position[1] + delta[1] * range,
          ];
          if (view.obstacles.has(key(position))) break;
          addDanger(position, enemyPower(enemy));
        }
      }
      continue;
    }
    for (const position of cellsWithin(enemy.position, 1))
      addDanger(position, enemyPower(enemy));
  }
  return danger;
}

function knownChokepoints(
  core: CoreObject,
  obstacles: Set<string>,
  explored: Readonly<Record<string, Position>>,
  resources: Readonly<Record<string, { position: Position }>>,
  enemies: Readonly<Record<string, EnemyObservation>>,
  radius: number,
): Position[] {
  const candidates: Array<{ position: Position; score: number }> = [];
  for (const position of cellsWithin(core.position, radius)) {
    if (
      obstacles.has(key(position)) ||
      !explored[key(position)] ||
      distance(position, core.position) < 2
    )
      continue;
    const neighbors = DIRECTIONS.map(([, delta]) => {
      const neighbor: Position = [
        position[0] + delta[0],
        position[1] + delta[1],
      ];
      return {
        delta,
        known: Boolean(explored[key(neighbor)]) || obstacles.has(key(neighbor)),
        open: Boolean(explored[key(neighbor)]) && !obstacles.has(key(neighbor)),
      };
    });
    if (!neighbors.every(({ known }) => known)) continue;
    const exits = neighbors.filter(({ open }) => open);
    const isStraightPassage =
      exits.length === 2 &&
      exits[0]?.delta[0] === -(exits[1]?.delta[0] ?? 0) &&
      exits[0]?.delta[1] === -(exits[1]?.delta[1] ?? 0);
    if (!isStraightPassage) continue;

    const resourceValue = Object.values(resources).filter(
      (resource) => distance(position, resource.position) <= 3,
    ).length;
    const pressureValue = Object.values(enemies).filter(
      (enemy) => distance(position, enemy.position) <= radius,
    ).length;
    candidates.push({
      position,
      score:
        30 -
        distance(position, core.position) * 2 +
        Math.min(3, resourceValue) * 3 +
        Math.min(2, pressureValue) * 2,
    });
  }
  const selected: Position[] = [];
  for (const candidate of candidates.sort(
    (a, b) =>
      b.score - a.score || key(a.position).localeCompare(key(b.position)),
  )) {
    if (
      selected.some((position) => distance(position, candidate.position) <= 2)
    )
      continue;
    selected.push(candidate.position);
    if (selected.length === 6) break;
  }
  return selected;
}

function rawPosture(
  tick: number,
  state: PlayerState,
  view: Snapshot,
  memory: StrategyMemory,
  threatened: boolean,
  retreatRequired: boolean,
  friendlyCombatPower: number,
  visibleEnemyPower: number,
  config: StrategyConfig,
): Posture {
  if (state.status === "RESPAWNING" || !view.core) return "RECOVER";
  const populationLoss = Math.max(
    0,
    memory.previousPopulation - state.population,
  );
  if (populationLoss >= Math.max(2, Math.ceil(memory.previousPopulation * 0.3)))
    return "REGROUP";
  if (retreatRequired) return "REGROUP";
  if (view.core.hp <= 2 || (view.core.shield === 0 && threatened))
    return "RECOVER";
  if (threatened) return "HOLD";
  const workers = view.units.filter(
    (unit) => unit.unit_type === "WORKER",
  ).length;
  const enemyCore = view.enemies.find((enemy) => enemy.kind === "CORE");
  const recentEnemyCore = Object.values(memory.enemies).find(
    (enemy) =>
      enemy.kind === "CORE" &&
      tick - enemy.lastSeenTick <= config.enemyLocalizedTicks * 4,
  );
  const combatUnits = view.units.filter((unit) => unit.unit_type !== "WORKER");
  const visibleCombatContact = view.enemies.some(
    (enemy) => !isEnemyWorker(enemy),
  );
  // While CONTEST/ATTACK, allow the field army to hold the approach lane out to
  // the posture reach. Using safeControlRadius here caused CONTEST闂佹剚鍋呴幗鐛稧ROUP
  // thrash after cleared waves and blocked MIXED enemy-Core vision.
  const pressureRecallRadius =
    memory.posture === "ATTACK"
      ? config.attackRadius
      : memory.posture === "CONTEST"
        ? config.contestRadius
        : config.safeControlRadius;
  const pressureRegroup =
    memory.militaryPressureTicks > 0 &&
    !visibleCombatContact &&
    combatUnits.some(
      (unit) =>
        distance(view.core?.position ?? unit.position, unit.position) >
        pressureRecallRadius,
    );
  const completedAttack =
    memory.posture === "ATTACK" && !enemyCore && !recentEnemyCore;
  const regroupIncomplete =
    memory.posture === "REGROUP" &&
    (combatUnits.length <
      Math.max(
        config.minimumCombatCount,
        Math.ceil(workers * config.combatCountPerWorker),
      ) ||
      combatUnits.some(
        (unit) =>
          distance(view.core?.position ?? unit.position, unit.position) >
          config.safeControlRadius,
      ));
  const visibleNonCoreCombatPower = view.enemies
    .filter(
      (enemy): enemy is UnitObject =>
        enemy.kind === "UNIT" && !isEnemyWorker(enemy),
    )
    .reduce((sum, enemy) => sum + unitPower(enemy), 0);
  const offenseOpportunity =
    (Boolean(enemyCore) || Boolean(recentEnemyCore)) &&
    friendlyCombatPower >= 6 &&
    (friendlyCombatPower >= visibleEnemyPower * 1.25 ||
      (visibleNonCoreCombatPower === 0 && friendlyCombatPower >= 6) ||
      friendlyCombatPower >= visibleNonCoreCombatPower * 1.5 + 3);
  // Favorable Core pressure interrupts recovery stickiness so mixed campaigns
  // do not thrash in REGROUP while an exposed enemy Core is available.
  if (offenseOpportunity) return "ATTACK";
  if (completedAttack || pressureRegroup || regroupIncomplete) return "REGROUP";
  const friendlyBeaconCarrier = state.champion_beacon.carrier_id
    ? view.units.some((unit) => unit.id === state.champion_beacon.carrier_id) ||
      view.core?.id === state.champion_beacon.carrier_id
    : false;
  if (
    !friendlyBeaconCarrier &&
    friendlyCombatPower >= 6 &&
    (distance(view.core.position, state.champion_beacon.position) <= 10 ||
      view.enemies.length > 0)
  ) {
    return "CONTEST";
  }
  // Between multiwave contacts: keep HOLD while pressure memory remains and no
  // enemy Core is on the table. A visible/recent enemy Core still allows ECONOMY
  // or ATTACK selection above; this only stops peacetime scatter after raids.
  if (
    memory.militaryPressureTicks > 0 &&
    !visibleCombatContact &&
    !enemyCore &&
    !recentEnemyCore
  ) {
    return "HOLD";
  }
  if (
    workers < 3 ||
    state.resources < 5 ||
    Object.keys(memory.resources).length < workers
  ) {
    return "ECONOMY";
  }
  void tick;
  return "HOLD";
}

function dynamicControlRadius(
  state: PlayerState,
  posture: Posture,
  workerCount: number,
  combatCount: number,
  safeExpansionTicks: number,
  pressured: boolean,
  config: StrategyConfig,
): number {
  const contracted =
    posture === "RECOVER" || posture === "REGROUP" || pressured;
  if (contracted) {
    return Math.min(
      config.maxControlRadius,
      config.minControlRadius + Math.floor(combatCount / 4),
    );
  }
  const baseRadius = config.safeControlRadius;
  const forceReach = Math.ceil(combatCount / 2);
  const economyReach = Math.floor(workerCount / 3);
  const reserveReach =
    state.resources >= state.upkeep_next_tick * 3 + 5 ? 1 : 0;
  const postureReach =
    posture === "ATTACK"
      ? 2
      : posture === "CONTEST" || posture === "HOLD" || posture === "ECONOMY"
        ? 1
        : 0;
  const safeReach = Math.min(
    4,
    Math.floor(safeExpansionTicks / config.safeExpansionInterval),
  );
  return Math.max(
    config.minControlRadius,
    Math.min(
      config.maxControlRadius,
      baseRadius +
        forceReach +
        economyReach +
        reserveReach +
        postureReach +
        safeReach,
    ),
  );
}

function nearestSupportDistance(
  position: Position,
  supports: readonly Position[],
): number {
  return supports.reduce(
    (best, support) => Math.min(best, distance(position, support)),
    Number.POSITIVE_INFINITY,
  );
}

function supportAnchor(
  core: CoreObject,
  target: Position | undefined,
  explored: Readonly<Record<string, Position>>,
  obstacles: ReadonlySet<string>,
  danger: ReadonlyMap<string, number>,
  controlRadius: number,
  contracted: boolean,
  capBehindTarget: boolean,
): Position {
  const unconstrainedDepth = contracted
    ? 1
    : Math.max(2, controlRadius - Math.max(2, Math.floor(controlRadius / 3)));
  const desiredDepth =
    target && capBehindTarget
      ? Math.min(
          unconstrainedDepth,
          Math.max(1, distance(core.position, target) - 1),
        )
      : unconstrainedDepth;
  return (
    Object.values(explored)
      .filter(
        (candidate) =>
          !obstacles.has(key(candidate)) &&
          distance(core.position, candidate) >= Math.max(1, desiredDepth - 1) &&
          distance(core.position, candidate) <= desiredDepth + 1 &&
          (danger.get(key(candidate)) ?? 0) <= 0.5,
      )
      .map((candidate) => ({
        candidate,
        score:
          Math.abs(distance(core.position, candidate) - desiredDepth) * 6 +
          (target ? distance(candidate, target) : 0) +
          (danger.get(key(candidate)) ?? 0) * 8,
      }))
      .sort(
        (a, b) =>
          a.score - b.score || key(a.candidate).localeCompare(key(b.candidate)),
      )[0]?.candidate ?? core.position
  );
}

function knownObservationPosts(
  core: CoreObject,
  explored: Readonly<Record<string, Position>>,
  obstacles: ReadonlySet<string>,
  resources: Readonly<Record<string, { position: Position }>>,
  patrolVisits: Readonly<Record<string, number>>,
  danger: ReadonlyMap<string, number>,
  controlRadius: number,
  supports: readonly Position[],
  supportResponseTicks: number,
): Position[] {
  const candidates = Object.values(explored)
    .filter((position) => {
      const coreDistance = distance(core.position, position);
      return (
        coreDistance >= Math.max(3, controlRadius - 2) &&
        coreDistance <= controlRadius &&
        nearestSupportDistance(position, supports) <= supportResponseTicks &&
        !obstacles.has(key(position)) &&
        (danger.get(key(position)) ?? 0) <= 0.5
      );
    })
    .map((position) => ({
      position,
      score:
        distance(core.position, position) * 4 +
        Object.values(resources).filter(
          (resource) => distance(resource.position, position) <= 3,
        ).length *
          5 -
        Math.max(0, patrolVisits[key(position)] ?? 0) * 0.01,
    }))
    .sort(
      (a, b) =>
        b.score - a.score || key(a.position).localeCompare(key(b.position)),
    );
  const selected: Position[] = [];
  for (const candidate of candidates) {
    if (selected.some((position) => distance(position, candidate.position) < 4))
      continue;
    selected.push(candidate.position);
    if (selected.length === 4) break;
  }
  return selected;
}

function assess(
  tick: number,
  state: PlayerState,
  view: Snapshot,
  memory: StrategyMemory,
  danger: Map<string, number>,
  config: StrategyConfig,
): Assessment {
  const workerCount = view.units.filter(
    (unit) => unit.unit_type === "WORKER",
  ).length;
  const combatUnits = view.units.filter((unit) => unit.unit_type !== "WORKER");
  const friendlyCombatPower = combatUnits.reduce(
    (sum, unit) => sum + unitPower(unit),
    0,
  );
  const visibleEnemyPower = view.enemies.reduce(
    (sum, enemy) => sum + (enemy.kind === "CORE" ? 5 : unitPower(enemy)),
    0,
  );
  const tacticalEnemies = view.core
    ? view.enemies.filter(
        (enemy): enemy is UnitObject =>
          enemy.kind === "UNIT" &&
          distance(enemy.position, view.core?.position ?? enemy.position) <=
            config.maxControlRadius + 2,
      )
    : [];
  const tacticalEnemyPower = strongestEnemyCluster(
    tacticalEnemies.filter((enemy) => !isEnemyWorker(enemy)),
  );
  const responsiveFriendlyPower = view.core
    ? combatUnits
        .filter(
          (unit) =>
            distance(unit.position, view.core?.position ?? unit.position) <=
              config.safeControlRadius ||
            tacticalEnemies.some(
              (enemy) =>
                !isEnemyWorker(enemy) &&
                distance(unit.position, enemy.position) <=
                  config.baseSupportResponseTicks,
            ),
        )
        .reduce((sum, unit) => sum + unitPower(unit), 0)
    : friendlyCombatPower;
  const retreatRequired =
    friendlyCombatPower > 0 &&
    tacticalEnemyPower > 0 &&
    tacticalEnemyPower > responsiveFriendlyPower * config.retreatPowerRatio;
  const threatened = Boolean(
    view.core &&
      view.enemies.some(
        (enemy) =>
          !isEnemyWorker(enemy) &&
          distance(enemy.position, view.core?.position ?? enemy.position) <=
            config.threatCoreRadius,
      ),
  );
  const desired = rawPosture(
    tick,
    state,
    view,
    memory,
    threatened,
    retreatRequired,
    friendlyCombatPower,
    visibleEnemyPower,
    config,
  );
  // ATTACK from offenseOpportunity must break RECOVER/REGROUP stickiness so a
  // visible or freshly remembered enemy Core is not ignored for postureMinTicks.
  const emergency =
    desired === "RECOVER" ||
    desired === "ATTACK" ||
    (desired === "HOLD" && threatened) ||
    (desired === "REGROUP" && retreatRequired);
  const posture =
    emergency || tick - memory.postureSinceTick >= config.postureMinTicks
      ? desired
      : memory.posture;
  const pressureFraction =
    friendlyCombatPower > 0
      ? Math.min(0.25, (tacticalEnemyPower / friendlyCombatPower) * 0.2)
      : 0;
  const rawReserveCount =
    combatUnits.length === 0
      ? 0
      : Math.max(
          1,
          Math.ceil(
            combatUnits.length * (config.reserveFraction + pressureFraction),
          ),
        );
  // Keep a single reaction reserve during committed attacks so the rest of the
  // field army can close. Larger peacetime reserves were stranding the push.
  const reserveCount =
    posture === "ATTACK" && !threatened
      ? Math.min(1, rawReserveCount)
      : rawReserveCount;
  const controlKinds = new Set<RoleMemory["kind"]>([
    "CONTROL_RALLY",
    "PATROL",
    "OBSERVE",
    "WATCH_POINT",
    "HOLD_POINT",
  ]);
  const controlRetentionScore = (
    kind: RoleMemory["kind"] | undefined,
  ): number => {
    if (!kind || !controlKinds.has(kind)) return 0;
    return posture === "CONTEST" &&
      (kind === "WATCH_POINT" || kind === "HOLD_POINT")
      ? 2
      : 1;
  };
  const reserveScore = (
    unit: UnitObject,
    priorKind: RoleMemory["kind"] | undefined,
  ): number =>
    distance(unit.position, view.core?.position ?? unit.position) +
    (unit.unit_type === "RANGER" ? 2 : 0) +
    (priorKind === "RESERVE" ? -5 : 0) +
    (priorKind && controlKinds.has(priorKind) ? 5 : 0);
  const reserveIds = new Set(
    [...combatUnits]
      .sort((a, b) => {
        const aKind = memory.roles[a.id]?.kind;
        const bKind = memory.roles[b.id]?.kind;
        return (
          reserveScore(a, aKind) - reserveScore(b, bKind) ||
          a.id.localeCompare(b.id)
        );
      })
      .slice(0, reserveCount)
      .map((unit) => unit.id),
  );
  // Residual multiwave pressure: do not hand the field army to far CONTROL_RALLY
  // seats the instant a wave dies. STAGGERED seed 8 scattered east under ECONOMY
  // control and met the second wave out of position.
  const controlCount =
    !threatened &&
    posture !== "ATTACK" &&
    posture !== "REGROUP" &&
    view.enemies.length === 0 &&
    memory.militaryPressureTicks === 0 &&
    combatUnits.length >= 2
      ? Math.max(
          1,
          Math.min(
            Math.max(1, combatUnits.length - reserveIds.size - 1),
            posture === "HOLD" || posture === "ECONOMY"
              ? Math.ceil(combatUnits.length * 0.4)
              : Math.floor(combatUnits.length * 0.3),
          ),
        )
      : 0;
  let controlIds = new Set(
    combatUnits
      .filter((unit) => !reserveIds.has(unit.id))
      .sort((a, b) => {
        const aKind = memory.roles[a.id]?.kind;
        const bKind = memory.roles[b.id]?.kind;
        return (
          controlRetentionScore(bKind) - controlRetentionScore(aKind) ||
          distance(b.position, view.core?.position ?? b.position) -
            distance(a.position, view.core?.position ?? a.position) ||
          a.id.localeCompare(b.id)
        );
      })
      .slice(0, controlCount)
      .map((unit) => unit.id),
  );
  const desiredControlRadius = dynamicControlRadius(
    state,
    posture,
    workerCount,
    combatUnits.length,
    memory.safeExpansionTicks,
    tacticalEnemyPower > friendlyCombatPower * 0.75,
    config,
  );
  const knownReach = view.core
    ? Object.values(memory.explored).reduce(
        (outer, position) =>
          Math.max(outer, distance(view.core?.position ?? position, position)),
        0,
      )
    : config.minControlRadius;
  const controlRadius = Math.max(
    config.minControlRadius,
    Math.min(desiredControlRadius, knownReach + 1),
  );
  const responseCore = view.core;
  const suppressWorkerResponse =
    posture === "ATTACK" || view.enemies.some((enemy) => enemy.kind === "CORE");
  const responseCandidates = responseCore
    ? tacticalEnemies.filter((enemy) => {
        const insideControl =
          distance(enemy.position, responseCore.position) <= controlRadius;
        if (!insideControl) return false;
        if (!isEnemyWorker(enemy)) return true;
        if (suppressWorkerResponse) return false;
        return (
          valuableWorkerIntrusion(
            enemy,
            responseCore,
            memory.resources,
            controlRadius,
          ) &&
          nearbyFriendlyPower(enemy.position, combatUnits) >=
            Math.max(1, nearbyGuardPower(enemy, view.enemies) * 1.25)
        );
      })
    : [];
  const responseThreat = responseCore
    ? (nearest(
        responseCore.position,
        responseCandidates.filter((enemy) => !isEnemyWorker(enemy)),
      ) ?? nearest(responseCore.position, responseCandidates))
    : undefined;
  const approachingThreat = responseCore
    ? nearest(
        responseCore.position,
        tacticalEnemies.filter((enemy) => !isEnemyWorker(enemy)),
      )
    : undefined;
  const supportThreat = responseThreat ?? approachingThreat;
  const responseIds = new Set<string>();
  if (responseThreat) {
    const responsePower =
      responseThreat.unit_type === "WORKER"
        ? 1
        : Math.max(1, unitPower(responseThreat) * 1.25);
    let committed = 0;
    for (const responder of [...combatUnits].sort(
      (a, b) =>
        distance(a.position, responseThreat.position) -
          distance(b.position, responseThreat.position) ||
        a.id.localeCompare(b.id),
    )) {
      responseIds.add(responder.id);
      committed += unitPower(responder);
      if (committed >= responsePower) break;
    }
  }
  for (const responderId of responseIds) {
    if (!reserveIds.has(responderId)) continue;
    const replacement = combatUnits
      .filter((unit) => !responseIds.has(unit.id) && !reserveIds.has(unit.id))
      .sort((a, b) => {
        const aKind = memory.roles[a.id]?.kind;
        const bKind = memory.roles[b.id]?.kind;
        return (
          reserveScore(a, aKind) - reserveScore(b, bKind) ||
          a.id.localeCompare(b.id)
        );
      })[0];
    if (replacement) reserveIds.add(replacement.id);
  }
  const eligibleControlUnits = combatUnits
    .filter((unit) => !reserveIds.has(unit.id) && !responseIds.has(unit.id))
    .sort((a, b) => {
      const aKind = memory.roles[a.id]?.kind;
      const bKind = memory.roles[b.id]?.kind;
      return (
        controlRetentionScore(bKind) - controlRetentionScore(aKind) ||
        distance(b.position, view.core?.position ?? b.position) -
          distance(a.position, view.core?.position ?? a.position) ||
        a.id.localeCompare(b.id)
      );
    });
  controlIds = new Set(
    eligibleControlUnits
      .slice(0, Math.min(controlCount, eligibleControlUnits.length))
      .map((unit) => unit.id),
  );
  const supportTarget =
    supportThreat?.position ??
    (view.core
      ? nearest(
          view.core.position,
          Object.values(memory.resources).filter(
            (resource) =>
              resource.depletedAtTick === undefined &&
              (danger.get(key(resource.position)) ?? 0) <=
                config.workerEscapeDanger &&
              knownSafeStep(
                view.core?.position ?? resource.position,
                resource.position,
                memory,
                danger,
                config.workerEscapeDanger,
              ),
          ),
        )?.position
      : undefined);
  const constrainedWorkerDenial = Boolean(
    responseThreat &&
      isEnemyWorker(responseThreat) &&
      [...view.obstacles].some((cell) => {
        const obstacle = parseKey(cell);
        return (
          obstacle !== undefined &&
          distance(obstacle, responseThreat.position) <= 2
        );
      }),
  );
  const rally = view.core
    ? supportAnchor(
        view.core,
        supportTarget,
        memory.explored,
        view.obstacles,
        danger,
        controlRadius,
        threatened || posture === "RECOVER" || posture === "REGROUP",
        constrainedWorkerDenial,
      )
    : ([0, 0] as const);
  const supportResponseTicks = Math.min(
    controlRadius,
    config.baseSupportResponseTicks + Math.floor(combatUnits.length / 4),
  );
  const reserveAnchors: Record<string, Position> = {};
  const supportAssignments = new Set<string>();
  if (view.core) {
    const supportDepth = Math.max(2, distance(view.core.position, rally));
    // Between waves (pressure memory, no live contact) keep reserves in a tight
    // Core ring. Live contact keeps normal support geometry for reorientation.
    const betweenWavePressure =
      memory.militaryPressureTicks > 0 &&
      !view.enemies.some((enemy) => !isEnemyWorker(enemy));
    const reserveDepth = betweenWavePressure
      ? Math.min(supportDepth, Math.max(2, config.reserveResponseRadius - 1))
      : supportDepth;
    const reserves = combatUnits.filter((unit) => reserveIds.has(unit.id));
    for (const reserve of reserves) {
      const priorRole = memory.roles[reserve.id];
      const retainedAnchor =
        priorRole?.kind === "RESERVE" &&
        key(priorRole.anchor) !== key(view.core.position) &&
        memory.explored[key(priorRole.anchor)] &&
        !view.obstacles.has(key(priorRole.anchor)) &&
        (danger.get(key(priorRole.anchor)) ?? 0) <= 0.5 &&
        distance(view.core.position, priorRole.anchor) <= reserveDepth + 1 &&
        distance(view.core.position, priorRole.anchor) >= 1 &&
        (!supportThreat ||
          distance(priorRole.anchor, supportThreat.position) <=
            supportResponseTicks)
          ? priorRole.anchor
          : undefined;
      let anchor =
        retainedAnchor ??
        (reserves.length === 1 ||
        (supportThreat && !responseIds.has(reserve.id))
          ? betweenWavePressure
            ? patrolTarget(
                reserve,
                view.core,
                reserveDepth,
                memory,
                danger,
                supportAssignments,
              )
            : rally
          : patrolTarget(
              reserve,
              view.core,
              reserveDepth,
              memory,
              danger,
              supportAssignments,
            ));
      // Core counts as a friendly occupant; never stage RESERVE on the Core cell.
      if (key(anchor) === key(view.core.position)) {
        anchor = approachCorePerimeter(
          reserve,
          view.core,
          view,
          memory,
          danger,
          supportAssignments,
          Math.max(1, Math.min(reserveDepth, 2)),
        );
      }
      reserveAnchors[reserve.id] = anchor;
      supportAssignments.add(key(anchor));
    }
  }
  const supportPositions = combatUnits
    .filter((unit) => reserveIds.has(unit.id))
    .map((unit) => unit.position);
  if (supportPositions.length === 0) supportPositions.push(rally);
  const chokepoints = view.core
    ? knownChokepoints(
        view.core,
        view.obstacles,
        memory.explored,
        memory.resources,
        memory.enemies,
        controlRadius,
      )
    : [];
  return {
    threatened,
    visibleEnemyPower,
    tacticalEnemyPower,
    friendlyCombatPower,
    materialLoss: desired === "REGROUP",
    retreatRequired,
    workerCount,
    combatCount: combatUnits.length,
    reserveIds,
    controlIds,
    responseIds,
    chokepoints,
    observationPosts: view.core
      ? knownObservationPosts(
          view.core,
          memory.explored,
          view.obstacles,
          memory.resources,
          memory.patrolVisits,
          danger,
          controlRadius,
          supportPositions,
          supportResponseTicks,
        )
      : [],
    controlRadius,
    supportResponseTicks,
    supportAnchor: rally,
    supportPositions,
    reserveAnchors,
    ...(responseThreat ? { responseThreat } : {}),
    posture,
  };
}

function deriveMilitaryReadiness(
  tick: number,
  view: Snapshot,
  assessment: Assessment,
  memory: StrategyMemory,
  config: StrategyConfig,
): MilitaryReadiness {
  const combatUnits = view.units.filter((unit) => unit.unit_type !== "WORKER");
  const vanguards = combatUnits.filter(
    (unit) => unit.unit_type === "VANGUARD",
  ).length;
  const rangers = combatUnits.length - vanguards;
  const openingComplete =
    assessment.workerCount >= 3 && vanguards >= 1 && rangers >= 1;
  const liveHostileCombat = view.enemies.some((enemy) => !isEnemyWorker(enemy));
  const pressureActive =
    assessment.threatened ||
    assessment.retreatRequired ||
    memory.militaryPressureTicks > 0 ||
    memory.recentCombatLosses > 0;
  const recentEnemyPower = Object.values(memory.enemies)
    .filter(
      (enemy) =>
        enemy.kind === "UNIT" &&
        enemy.unitType !== "WORKER" &&
        tick - enemy.lastSeenTick <= config.militaryPressureHorizonTicks,
    )
    .reduce((sum, enemy) => sum + unitPower(enemy), 0);
  const scaledCombatCount = Math.max(
    config.minimumCombatCount,
    Math.ceil(assessment.workerCount * config.combatCountPerWorker),
    Math.ceil(assessment.controlRadius / config.controlRadiusPerCombatUnit),
  );
  const reinforceNow =
    assessment.threatened ||
    assessment.retreatRequired ||
    liveHostileCombat ||
    memory.recentCombatLosses > 0;
  const pressureBonus = reinforceNow
    ? Math.min(2, Math.max(1, memory.recentCombatLosses))
    : 0;
  const minimumCombatCount = openingComplete
    ? scaledCombatCount + pressureBonus
    : 2;
  const minimumCombatPower = Math.max(
    minimumCombatCount * config.minimumCombatPowerPerUnit,
    Math.ceil(
      Math.max(assessment.tacticalEnemyPower, recentEnemyPower) *
        (pressureActive ? config.retreatPowerRatio : 1),
    ),
  );
  const desiredVanguards = Math.max(1, Math.ceil(minimumCombatCount / 2));
  const desiredRangers = Math.max(1, Math.floor(minimumCombatCount / 3));
  const combatCountDeficit = Math.max(
    0,
    minimumCombatCount - assessment.combatCount,
  );
  const combatPowerDeficit = Math.max(
    0,
    minimumCombatPower - assessment.friendlyCombatPower,
  );
  const formationIncomplete =
    openingComplete &&
    (vanguards < desiredVanguards || rangers < desiredRangers);
  const rebuilding =
    pressureActive ||
    combatCountDeficit > 0 ||
    combatPowerDeficit > 0 ||
    formationIncomplete;
  return {
    targetWorkerShare: rebuilding
      ? config.pressuredWorkerShare
      : config.safeWorkerShare,
    minimumCombatCount,
    minimumCombatPower,
    combatCountDeficit,
    combatPowerDeficit,
    desiredVanguards,
    desiredRangers,
    formationIncomplete,
    rebuilding,
  };
}

function survivalReserve(
  state: PlayerState,
  core: CoreObject | undefined,
  threatened: boolean,
): number {
  if (!core) return 0;
  // Bank only critical shield repair, not a full top-off. Full shield targets
  // were starving combat replacement under multi-wave pressure.
  const shieldCost =
    core.shield === 0
      ? 1
      : threatened && core.hp + core.shield <= 3
        ? Math.max(0, 2 - core.shield)
        : 0;
  return (threatened ? 3 : 2) * state.upkeep_next_tick + shieldCost;
}

function economicReserve(
  state: PlayerState,
  core: CoreObject | undefined,
  emergency: boolean,
): number {
  return survivalReserve(state, core, emergency);
}

function blockedCells(view: Snapshot, movingId?: string): Set<string> {
  const blocked = new Set(view.obstacles);
  for (const enemy of view.enemies) blocked.add(key(enemy.position));

  const friendlyCapacity = new Map<string, number>();
  for (const unit of view.units) {
    if (unit.id === movingId) continue;
    const positionKey = key(unit.position);
    friendlyCapacity.set(
      positionKey,
      (friendlyCapacity.get(positionKey) ?? 0) + 1,
    );
  }
  if (view.core) {
    const coreKey = key(view.core.position);
    // Core counts as one friendly occupant of its cell (capacity 2 total).
    friendlyCapacity.set(coreKey, (friendlyCapacity.get(coreKey) ?? 0) + 1);
  }
  for (const [positionKey, occupants] of friendlyCapacity) {
    if (occupants >= 2) blocked.add(positionKey);
  }
  return blocked;
}

function emptyWorkerTrafficCells(
  view: Snapshot,
  movingId: string,
): Set<string> {
  return new Set(
    view.units
      .filter(
        (unit) =>
          unit.id !== movingId &&
          unit.unit_type === "WORKER" &&
          (unit.cargo ?? 0) === 0,
      )
      .map((unit) => key(unit.position)),
  );
}

function workerCrowdingPenalty(
  position: Position,
  unit: UnitObject,
  view: Snapshot,
): number {
  return view.units.reduce((penalty, candidate) => {
    if (candidate.id === unit.id || candidate.unit_type !== "WORKER")
      return penalty;
    const separation = distance(position, candidate.position);
    return penalty + (separation === 0 ? 12 : separation === 1 ? 2 : 0);
  }, 0);
}

function nearAssignedTarget(
  position: Position,
  assignedTargets: ReadonlySet<string>,
  spacing: number,
): boolean {
  return [...assignedTargets].some((target) => {
    const assigned = parseKey(target);
    return assigned ? distance(position, assigned) < spacing : false;
  });
}

function nearest<T extends { position: Position }>(
  from: Position,
  values: readonly T[],
): T | undefined {
  return [...values].sort(
    (a, b) =>
      distance(from, a.position) - distance(from, b.position) ||
      key(a.position).localeCompare(key(b.position)),
  )[0];
}

function knownSafeDirection(
  from: Position,
  target: Position,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
  maxDanger: number,
  blocked: ReadonlySet<string> = new Set(),
): Direction | undefined {
  const queue: Array<{ position: Position; first?: Direction }> = [
    { position: from },
  ];
  const visited = new Set([key(from)]);
  const maxNodes = Math.max(512, Object.keys(memory.explored).length + 1);
  for (let index = 0; index < queue.length && index < maxNodes; index += 1) {
    const current = queue[index];
    if (!current) break;
    const preferredDirection = directionBetween(current.position, target);
    const targetDirectedSteps = [...DIRECTIONS].sort(
      ([aDirection, a], [bDirection, b]) => {
        const aPosition: Position = [
          current.position[0] + a[0],
          current.position[1] + a[1],
        ];
        const bPosition: Position = [
          current.position[0] + b[0],
          current.position[1] + b[1],
        ];
        return (
          distance(aPosition, target) - distance(bPosition, target) ||
          Number(bDirection === preferredDirection) -
            Number(aDirection === preferredDirection)
        );
      },
    );
    for (const [direction, delta] of targetDirectedSteps) {
      const candidate: Position = [
        current.position[0] + delta[0],
        current.position[1] + delta[1],
      ];
      const candidateKey = key(candidate);
      if (
        visited.has(candidateKey) ||
        (candidateKey !== key(target) && !memory.explored[candidateKey]) ||
        memory.obstacles[candidateKey] ||
        blocked.has(candidateKey) ||
        (danger.get(candidateKey) ?? 0) > maxDanger
      ) {
        continue;
      }
      const first = current.first ?? direction;
      if (candidateKey === key(target)) return first;
      visited.add(candidateKey);
      queue.push({ position: candidate, first });
    }
  }
  return undefined;
}

function knownSafeDistances(
  from: Position,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
  maxDanger: number,
): Map<string, number> {
  const distances = new Map([[key(from), 0]]);
  const queue: Position[] = [from];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current) break;
    const currentDistance = distances.get(key(current)) ?? 0;
    for (const [, delta] of DIRECTIONS) {
      const candidate: Position = [
        current[0] + delta[0],
        current[1] + delta[1],
      ];
      const candidateKey = key(candidate);
      if (
        distances.has(candidateKey) ||
        !memory.explored[candidateKey] ||
        memory.obstacles[candidateKey] ||
        (danger.get(candidateKey) ?? 0) > maxDanger
      ) {
        continue;
      }
      distances.set(candidateKey, currentDistance + 1);
      queue.push(candidate);
    }
  }
  return distances;
}

function knownSafeReachable(
  from: Position,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
  maxDanger: number,
): Set<string> {
  return new Set(knownSafeDistances(from, memory, danger, maxDanger).keys());
}

interface FlowEdge {
  to: number;
  reverse: number;
  capacity: number;
  cost: number;
}

function addFlowEdge(
  graph: FlowEdge[][],
  from: number,
  to: number,
  cost: number,
): FlowEdge {
  const forward: FlowEdge = {
    to,
    reverse: graph[to]?.length ?? 0,
    capacity: 1,
    cost,
  };
  const backward: FlowEdge = {
    to: from,
    reverse: graph[from]?.length ?? 0,
    capacity: 0,
    cost: -cost,
  };
  graph[from]?.push(forward);
  graph[to]?.push(backward);
  return forward;
}

function minimumCostResourceAssignments(
  workers: readonly UnitObject[],
  resources: readonly Position[],
  routeDistances: ReadonlyMap<string, ReadonlyMap<string, number>>,
): Map<string, Position> {
  const source = 0;
  const firstWorker = 1;
  const firstResource = firstWorker + workers.length;
  const sink = firstResource + resources.length;
  const graph: FlowEdge[][] = Array.from({ length: sink + 1 }, () => []);
  const candidateEdges: Array<{
    workerId: string;
    resource: Position;
    edge: FlowEdge;
  }> = [];

  workers.forEach((worker, workerIndex) => {
    const workerNode = firstWorker + workerIndex;
    addFlowEdge(graph, source, workerNode, 0);
    resources.forEach((resource, resourceIndex) => {
      const routeDistance = routeDistances.get(worker.id)?.get(key(resource));
      if (routeDistance === undefined) return;
      const edge = addFlowEdge(
        graph,
        workerNode,
        firstResource + resourceIndex,
        routeDistance,
      );
      candidateEdges.push({ workerId: worker.id, resource, edge });
    });
  });
  resources.forEach((_, resourceIndex) => {
    addFlowEdge(graph, firstResource + resourceIndex, sink, 0);
  });

  // Successive shortest augmenting paths maximize filled harvest slots first,
  // then minimize their total safe-route distance.
  while (true) {
    const costs = Array<number>(graph.length).fill(Number.POSITIVE_INFINITY);
    const previousNode = Array<number>(graph.length).fill(-1);
    const previousEdge = Array<number>(graph.length).fill(-1);
    costs[source] = 0;
    for (let pass = 0; pass < graph.length - 1; pass += 1) {
      let changed = false;
      for (let from = 0; from < graph.length; from += 1) {
        const fromCost = costs[from];
        if (fromCost === undefined || !Number.isFinite(fromCost)) continue;
        graph[from]?.forEach((edge, edgeIndex) => {
          const existingCost = costs[edge.to];
          if (existingCost === undefined) return;
          const nextCost = fromCost + edge.cost;
          if (edge.capacity <= 0 || nextCost >= existingCost) return;
          costs[edge.to] = nextCost;
          previousNode[edge.to] = from;
          previousEdge[edge.to] = edgeIndex;
          changed = true;
        });
      }
      if (!changed) break;
    }
    const sinkPrevious = previousNode[sink];
    if (sinkPrevious === undefined || sinkPrevious < 0) break;
    for (let node = sink; node !== source; ) {
      const from = previousNode[node];
      const edgeIndex = previousEdge[node];
      if (
        from === undefined ||
        edgeIndex === undefined ||
        from < 0 ||
        edgeIndex < 0
      ) {
        break;
      }
      const edge = graph[from]?.[edgeIndex];
      if (!edge) break;
      edge.capacity -= 1;
      const reverse = graph[node]?.[edge.reverse];
      if (reverse) reverse.capacity += 1;
      node = from;
    }
  }

  return new Map(
    candidateEdges
      .filter((candidate) => candidate.edge.capacity === 0)
      .map((candidate) => [candidate.workerId, candidate.resource]),
  );
}

function visibleResourceAssignments(
  view: Snapshot,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
  config: StrategyConfig,
): Map<string, Position> {
  const resources = [...view.resources]
    .map(parseKey)
    .filter((position): position is Position => position !== undefined)
    .filter(
      (position) =>
        !view.enemies.some((enemy) => distance(enemy.position, position) <= 1),
    )
    .sort((a, b) => key(a).localeCompare(key(b)));
  const workers = view.units.filter(
    (unit) =>
      unit.unit_type === "WORKER" &&
      (unit.cargo ?? 0) === 0 &&
      (danger.get(key(unit.position)) ?? 0) <= config.workerEscapeDanger,
  );
  // Visible crystals use known/explored walks first (fog is never a free
  // shortcut). Unreachable nodes use raw manhattan (not 10000+ offset) so a
  // local seer keeps the target and explores toward it instead of vision-rim
  // orbiting while a far scout "owns" the node on paper.
  const routeDistances = new Map(
    workers.map((worker) => {
      const distances = openWalkDistances(
        worker.position,
        view,
        memory,
        danger,
        config.workerEscapeDanger,
        worker.id,
      );
      const blocked = blockedCells(view, worker.id);
      for (const obstacle of Object.keys(memory.obstacles))
        blocked.add(obstacle);
      // Boxed-in workers must not optimistic-claim; mobile seers may.
      const mobile = DIRECTIONS.some(([, delta]) => {
        const neighbor: Position = [
          worker.position[0] + delta[0],
          worker.position[1] + delta[1],
        ];
        const neighborKey = key(neighbor);
        return (
          !blocked.has(neighborKey) &&
          !memory.obstacles[neighborKey] &&
          (danger.get(neighborKey) ?? 0) <= config.workerEscapeDanger
        );
      });
      for (const resource of resources) {
        const resourceKey = key(resource);
        if (distances.has(resourceKey)) continue;
        // Approach via a known neighbor of the crystal (reference Pathfinder).
        let bestApproach: number | undefined;
        for (const [, delta] of DIRECTIONS) {
          const neighbor: Position = [
            resource[0] + delta[0],
            resource[1] + delta[1],
          ];
          const neighborDistance = distances.get(key(neighbor));
          if (neighborDistance === undefined) continue;
          const approach = neighborDistance + 1;
          if (bestApproach === undefined || approach < bestApproach) {
            bestApproach = approach;
          }
        }
        distances.set(
          resourceKey,
          bestApproach ??
            (mobile
              ? distance(worker.position, resource)
              : 50_000 + distance(worker.position, resource)),
        );
      }
      return [worker.id, distances] as const;
    }),
  );
  return minimumCostResourceAssignments(workers, resources, routeDistances);
}

function openWalkDistances(
  from: Position,
  view: Snapshot,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
  maxDanger: number,
  movingId: string,
): Map<string, number> {
  // Only walk explored (or currently visible via memory.explored) cells.
  // Treating unseen fog as empty created phantom paths that reverse every
  // tick when hidden rocks appear — workers bob UP/DOWN in rock pockets.
  const blocked = blockedCells(view, movingId);
  for (const obstacle of Object.keys(memory.obstacles)) blocked.add(obstacle);
  const distances = new Map([[key(from), 0]]);
  const queue: Position[] = [from];
  const maxNodes = 1024;
  const maxDistance = 48;
  // Bound BFS to explored bbox + small margin so FOW cannot runaway-expand.
  let minX = from[0];
  let maxX = from[0];
  let minY = from[1];
  let maxY = from[1];
  for (const cell of Object.values(memory.explored)) {
    minX = Math.min(minX, cell[0]);
    maxX = Math.max(maxX, cell[0]);
    minY = Math.min(minY, cell[1]);
    maxY = Math.max(maxY, cell[1]);
  }
  const margin = 2;
  minX -= margin;
  maxX += margin;
  minY -= margin;
  maxY += margin;
  for (let index = 0; index < queue.length && index < maxNodes; index += 1) {
    const current = queue[index];
    if (!current) break;
    const currentDistance = distances.get(key(current)) ?? 0;
    if (currentDistance >= maxDistance) continue;
    for (const [, delta] of DIRECTIONS) {
      const candidate: Position = [
        current[0] + delta[0],
        current[1] + delta[1],
      ];
      const candidateKey = key(candidate);
      if (
        distances.has(candidateKey) ||
        candidate[0] < minX ||
        candidate[0] > maxX ||
        candidate[1] < minY ||
        candidate[1] > maxY ||
        (candidateKey !== key(from) && blocked.has(candidateKey)) ||
        (candidateKey !== key(from) && !memory.explored[candidateKey]) ||
        (danger.get(candidateKey) ?? 0) > maxDanger
      ) {
        continue;
      }
      distances.set(candidateKey, currentDistance + 1);
      queue.push(candidate);
    }
  }
  return distances;
}

function knownSafeStep(
  from: Position,
  target: Position,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
  maxDanger: number,
): boolean {
  return (
    key(from) === key(target) ||
    knownSafeDirection(from, target, memory, danger, maxDanger) !== undefined
  );
}

function oppositeDirection(direction: Direction): Direction {
  if (direction === "UP") return "DOWN";
  if (direction === "DOWN") return "UP";
  if (direction === "LEFT") return "RIGHT";
  return "LEFT";
}

function recordWorkerMove(
  memory: StrategyMemory,
  unitId: string,
  from: Position,
  direction: Direction,
  tick: number,
): void {
  memory.workerLastMove ??= {};
  memory.workerLastMove[unitId] = { direction, from, tick };
}

function knownWalkAllowed(
  memory: StrategyMemory,
): (position: Position) => boolean {
  return (position) =>
    Boolean(memory.explored[key(position)]) && !memory.obstacles[key(position)];
}

function exploredBounds(
  memory: StrategyMemory,
  origin: Position,
  margin = 3,
): { inBounds: (position: Position) => boolean } {
  let minX = origin[0];
  let maxX = origin[0];
  let minY = origin[1];
  let maxY = origin[1];
  for (const cell of Object.values(memory.explored)) {
    minX = Math.min(minX, cell[0]);
    maxX = Math.max(maxX, cell[0]);
    minY = Math.min(minY, cell[1]);
    maxY = Math.max(maxY, cell[1]);
  }
  minX -= margin;
  maxX += margin;
  minY -= margin;
  maxY += margin;
  return {
    inBounds: (position) =>
      position[0] >= minX &&
      position[0] <= maxX &&
      position[1] >= minY &&
      position[1] <= maxY,
  };
}

function moveTowardVisibleResource(
  tick: number,
  unit: UnitObject,
  target: Position,
  view: Snapshot,
  memory: StrategyMemory,
  danger: Map<string, number>,
  reserved: Set<string>,
): UnitAction {
  const targetKey = key(target);
  memory.workerHarvestPath ??= {};
  memory.workerLastMove ??= {};
  memory.workerScoutTarget ??= {};

  if (key(unit.position) === targetKey) {
    delete memory.workerHarvestPath[unit.id];
    delete memory.workerHarvestVisited?.[unit.id];
    delete memory.workerScoutTarget[unit.id];
    return { type: "HARVEST" };
  }

  const buildBlocked = (traffic: boolean): Set<string> => {
    const blocked = blockedCells(view, unit.id);
    for (const obstacle of Object.keys(memory.obstacles)) blocked.add(obstacle);
    for (const cell of reserved) blocked.add(cell);
    if (traffic) {
      for (const cell of emptyWorkerTrafficCells(view, unit.id))
        blocked.add(cell);
    }
    blocked.delete(targetKey);
    return blocked;
  };

  const last = memory.workerLastMove[unit.id];
  const bannedFirst =
    last && tick - last.tick <= 1
      ? oppositeDirection(last.direction)
      : undefined;
  const allowed = knownWalkAllowed(memory);
  const { inBounds } = exploredBounds(memory, unit.position, 4);

  const computeKnownPath = (): Direction[] | undefined => {
    const strict = buildBlocked(true);
    const loose = buildBlocked(false);
    const attempts: Array<{
      blocked: Set<string>;
      ban?: Direction | undefined;
    }> = [
      { blocked: strict, ban: bannedFirst },
      { blocked: strict },
      { blocked: loose, ban: bannedFirst },
      { blocked: loose },
    ];
    for (const attempt of attempts) {
      const path = findPathWithOptions(
        unit.position,
        target,
        attempt.blocked,
        {
          maxNodes: 2048,
          maxDistance: 64,
          bannedFirst: attempt.ban,
          allowed,
          inBounds,
        },
        danger,
      );
      if (path && path.length > 0) return path;
    }
    return undefined;
  };

  // When no all-known route exists, allow fog cells at a premium so the worker
  // can detour (RIGHT around a pocket) instead of WAIT/orbit. Known cells stay
  // cheap, so phantom FOW shortcuts lose to real explored corridors.
  const computeDetourPath = (): Direction[] | undefined => {
    const strict = buildBlocked(true);
    const loose = buildBlocked(false);
    const attempts: Array<{
      blocked: Set<string>;
      ban?: Direction | undefined;
    }> = [
      { blocked: strict, ban: bannedFirst },
      { blocked: strict },
      { blocked: loose, ban: bannedFirst },
      { blocked: loose },
    ];
    const costFor = (to: Position): number | undefined => {
      const toKey = key(to);
      if (memory.obstacles[toKey] && toKey !== targetKey) return undefined;
      if ((danger.get(toKey) ?? 0) > 1.5 && toKey !== targetKey)
        return undefined;
      if (toKey === targetKey || memory.explored[toKey]) return 1;
      // Unexplored fog: expensive but finite.
      return 5;
    };
    for (const attempt of attempts) {
      const path = findWeightedPath(
        unit.position,
        target,
        attempt.blocked,
        (_from, to) => costFor(to),
        {
          maxNodes: 2048,
          maxDistance: 72,
          bannedFirst: attempt.ban,
          inBounds: exploredBounds(memory, unit.position, 8).inBounds,
        },
      );
      if (path && path.length > 0) return path;
    }
    return undefined;
  };

  // Reuse committed known path only when still on track and next step is legal.
  const committed = memory.workerHarvestPath[unit.id];
  if (
    committed &&
    committed.goal === targetKey &&
    key(committed.expect) === key(unit.position) &&
    committed.steps.length > 0
  ) {
    const nextDir = committed.steps[0]!;
    if (!(bannedFirst && nextDir === bannedFirst)) {
      const next = nextPosition(unit.position, nextDir);
      const nextKey = key(next);
      const blockedNow = buildBlocked(true);
      const nextKnown =
        nextKey === targetKey ||
        (Boolean(memory.explored[nextKey]) && !memory.obstacles[nextKey]);
      if ((!blockedNow.has(nextKey) || nextKey === targetKey) && nextKnown) {
        committed.steps = committed.steps.slice(1);
        committed.expect = next;
        reserved.add(nextKey);
        recordWorkerMove(memory, unit.id, unit.position, nextDir, tick);
        return { type: "MOVE", direction: nextDir };
      }
    }
  }

  const path = computeKnownPath() ?? computeDetourPath();
  if (path && path.length > 0) {
    const direction = path[0]!;
    const next = nextPosition(unit.position, direction);
    memory.workerHarvestPath[unit.id] = {
      goal: targetKey,
      steps: path.slice(1),
      expect: next,
    };
    // Clear any scout peel — harvest owns the unit.
    delete memory.workerScoutTarget[unit.id];
    reserved.add(key(next));
    recordWorkerMove(memory, unit.id, unit.position, direction, tick);
    return { type: "MOVE", direction };
  }

  // No known path yet. Explore toward the crystal by stepping onto the best
  // progress cell: prefer unexplored frontier closer to the goal, never pure
  // reverse bob, never alphabetical farther flee.
  delete memory.workerHarvestPath[unit.id];
  const blocked = buildBlocked(true);
  const currentDistance = distance(unit.position, target);
  type Candidate = {
    dir: Direction;
    position: Position;
    nextDistance: number;
    unexplored: boolean;
    progress: number;
  };
  const candidates: Candidate[] = [];
  for (const [dir, delta] of DIRECTIONS) {
    if (bannedFirst && dir === bannedFirst) continue;
    const position: Position = [
      unit.position[0] + delta[0],
      unit.position[1] + delta[1],
    ];
    const positionKey = key(position);
    if (blocked.has(positionKey) && positionKey !== targetKey) continue;
    if (memory.obstacles[positionKey] && positionKey !== targetKey) continue;
    if ((danger.get(positionKey) ?? 0) > 1.5) continue;
    // May step into unexplored (vision expand) or known free cells only.
    const unexplored = !memory.explored[positionKey];
    const nextDistance = distance(position, target);
    candidates.push({
      dir,
      position,
      nextDistance,
      unexplored,
      progress: currentDistance - nextDistance,
    });
  }

  // 1) Strictly closer known or unexplored step.
  const closer = candidates
    .filter((entry) => entry.progress > 0)
    .sort(
      (a, b) =>
        b.progress - a.progress ||
        Number(b.unexplored) - Number(a.unexplored) ||
        a.nextDistance - b.nextDistance ||
        a.dir.localeCompare(b.dir),
    )[0];
  if (closer) {
    reserved.add(key(closer.position));
    recordWorkerMove(memory, unit.id, unit.position, closer.dir, tick);
    return { type: "MOVE", direction: closer.dir };
  }

  // 2) Unexplored side-step that does not increase distance (vision peel).
  const peel = candidates
    .filter((entry) => entry.unexplored && entry.progress >= 0)
    .sort(
      (a, b) => a.nextDistance - b.nextDistance || a.dir.localeCompare(b.dir),
    )[0];
  if (peel) {
    reserved.add(key(peel.position));
    recordWorkerMove(memory, unit.id, unit.position, peel.dir, tick);
    return { type: "MOVE", direction: peel.dir };
  }

  // 3) Path toward the known cell closest to the crystal (expand from there).
  const approach = Object.values(memory.explored)
    .filter(
      (cell) =>
        !memory.obstacles[key(cell)] &&
        !blocked.has(key(cell)) &&
        (danger.get(key(cell)) ?? 0) <= 1.5,
    )
    .sort(
      (a, b) =>
        distance(a, target) - distance(b, target) ||
        distance(unit.position, a) - distance(unit.position, b) ||
        key(a).localeCompare(key(b)),
    )[0];
  if (approach && key(approach) !== key(unit.position)) {
    const approachPath = findPathWithOptions(
      unit.position,
      approach,
      blocked,
      {
        maxNodes: 1024,
        maxDistance: 48,
        bannedFirst,
        allowed,
        inBounds,
      },
      danger,
    );
    if (approachPath && approachPath.length > 0) {
      const direction = approachPath[0]!;
      const next = nextPosition(unit.position, direction);
      memory.workerHarvestPath[unit.id] = {
        goal: targetKey,
        steps: approachPath.slice(1),
        expect: next,
      };
      reserved.add(key(next));
      recordWorkerMove(memory, unit.id, unit.position, direction, tick);
      return { type: "MOVE", direction };
    }
  }

  // 4) Detour step: accept non-improving moves so pockets can open (RIGHT around
  // NW crystal when UP/LEFT are walled). Still ban reverse and never prefer a
  // strictly worse reverse bob pair.
  const detourStep = candidates
    .slice()
    .sort(
      (a, b) =>
        a.nextDistance - b.nextDistance ||
        Number(b.unexplored) - Number(a.unexplored) ||
        a.dir.localeCompare(b.dir),
    )[0];
  if (detourStep) {
    reserved.add(key(detourStep.position));
    recordWorkerMove(memory, unit.id, unit.position, detourStep.dir, tick);
    return { type: "MOVE", direction: detourStep.dir };
  }

  // Sealed: WAIT. Do NOT frontier-orbit while harvest goal set.
  return { type: "WAIT" };
}

function moveTowardWorkerFrontier(
  unit: UnitObject,
  target: Position,
  view: Snapshot,
  memory: StrategyMemory,
  danger: Map<string, number>,
  reserved: Set<string>,
  maxDanger: number,
  tick = 0,
): UnitAction {
  const blocked = blockedCells(view, unit.id);
  for (const cell of emptyWorkerTrafficCells(view, unit.id)) blocked.add(cell);
  for (const cell of reserved) blocked.add(cell);
  const last = memory.workerLastMove?.[unit.id];
  const bannedFirst =
    last && tick > 0 && tick - last.tick <= 1
      ? oppositeDirection(last.direction)
      : undefined;

  const pickKnown = (
    extraBlocked: ReadonlySet<string>,
  ): Direction | undefined => {
    const direction = knownSafeDirection(
      unit.position,
      target,
      memory,
      danger,
      maxDanger,
      extraBlocked,
    );
    if (!direction) return undefined;
    if (bannedFirst && direction === bannedFirst) {
      // Try again with the reverse edge banned inside a one-step filter.
      const next = nextPosition(unit.position, direction);
      // Fall through to alternate search below.
      void next;
      return undefined;
    }
    return direction;
  };

  let direction =
    pickKnown(blocked) ??
    knownSafeDirection(
      unit.position,
      target,
      memory,
      danger,
      maxDanger,
      blocked,
    );
  if (direction && bannedFirst && direction === bannedFirst) {
    direction = undefined;
  }
  const relaxedDirection =
    direction ??
    (() => {
      const relaxedBlocked = new Set([
        ...blockedCells(view, unit.id),
        ...reserved,
      ]);
      const raw = knownSafeDirection(
        unit.position,
        target,
        memory,
        danger,
        maxDanger,
        relaxedBlocked,
      );
      if (raw && bannedFirst && raw === bannedFirst) return undefined;
      return raw;
    })();

  if (!relaxedDirection) {
    // Prefer a progress-making safe sidestep over idle WAIT, but never pick a
    // pure reverse or equal-score vertical bob when a non-reverse exists.
    const sidestepBlocked = new Set([
      ...blockedCells(view, unit.id),
      ...reserved,
    ]);
    const currentDistance = distance(unit.position, target);
    const sidestep = DIRECTIONS.map(([dir, delta]) => {
      const position: Position = [
        unit.position[0] + delta[0],
        unit.position[1] + delta[1],
      ];
      const nextDistance = distance(position, target);
      return {
        dir,
        position,
        ok:
          !sidestepBlocked.has(key(position)) &&
          Boolean(memory.explored[key(position)]) &&
          !memory.obstacles[key(position)] &&
          (danger.get(key(position)) ?? 0) <= maxDanger &&
          !(bannedFirst && dir === bannedFirst),
        progress: currentDistance - nextDistance,
        score: nextDistance + (danger.get(key(position)) ?? 0) * 4,
      };
    })
      .filter((entry) => entry.ok)
      .sort(
        (a, b) =>
          // Prefer real progress first so equal-distance UP/DOWN cannot thrash.
          b.progress - a.progress ||
          a.score - b.score ||
          a.dir.localeCompare(b.dir),
      )[0];
    if (!sidestep || sidestep.progress < 0) {
      // No non-worsening step: WAIT rather than orbit the vision rim.
      return { type: "WAIT" };
    }
    reserved.add(key(sidestep.position));
    if (tick > 0) {
      recordWorkerMove(memory, unit.id, unit.position, sidestep.dir, tick);
    }
    return { type: "MOVE", direction: sidestep.dir };
  }
  reserved.add(key(nextPosition(unit.position, relaxedDirection)));
  if (tick > 0) {
    recordWorkerMove(memory, unit.id, unit.position, relaxedDirection, tick);
  }
  return { type: "MOVE", direction: relaxedDirection };
}

function moveToward(
  unit: UnitObject,
  target: Position,
  view: Snapshot,
  danger: Map<string, number>,
  reserved: Set<string>,
  allowOccupiedGoal = false,
  avoidEmptyWorkers = false,
  requireGoal = false,
): UnitAction {
  const blocked = blockedCells(view, unit.id);
  if (avoidEmptyWorkers) {
    for (const cell of emptyWorkerTrafficCells(view, unit.id))
      blocked.add(cell);
  }
  for (const cell of reserved) blocked.add(cell);
  if (allowOccupiedGoal) blocked.delete(key(target));
  // Combat units may transit near Core, but must not choose the Core cell as a
  // standing goal — that seat is the only free stack slot for DEPOSIT/SPAWN.
  if (
    unit.unit_type !== "WORKER" &&
    view.core &&
    key(target) === key(view.core.position)
  ) {
    blocked.add(key(view.core.position));
  }
  let direction = findStep(
    unit.position,
    target,
    blocked,
    danger,
    2048,
    requireGoal,
  );
  // Single-file chokepoints cannot keep empty Workers perfectly spaced. If the
  // spacing ban yields no step, retry without it so harvest/deposit still flow.
  if (!direction && avoidEmptyWorkers) {
    const relaxed = blockedCells(view, unit.id);
    for (const cell of reserved) relaxed.add(cell);
    if (allowOccupiedGoal) relaxed.delete(key(target));
    if (
      unit.unit_type !== "WORKER" &&
      view.core &&
      key(target) === key(view.core.position)
    ) {
      relaxed.add(key(view.core.position));
    }
    direction = findStep(
      unit.position,
      target,
      relaxed,
      danger,
      2048,
      requireGoal,
    );
  }
  if (!direction) {
    const sidestepBlocked = blockedCells(view, unit.id);
    for (const cell of reserved) sidestepBlocked.add(cell);
    if (unit.unit_type !== "WORKER" && view.core) {
      // Sidesteps may still leave Core free when the unit is already adjacent.
      if (key(unit.position) === key(view.core.position)) {
        sidestepBlocked.add(key(view.core.position));
      }
    }
    const sidestep = DIRECTIONS.map(([dir, delta]) => {
      const position: Position = [
        unit.position[0] + delta[0],
        unit.position[1] + delta[1],
      ];
      return {
        dir,
        position,
        ok:
          !sidestepBlocked.has(key(position)) &&
          (danger.get(key(position)) ?? 0) <= 1.5,
        score:
          distance(position, target) + (danger.get(key(position)) ?? 0) * 4,
      };
    })
      .filter((entry) => entry.ok)
      .sort((a, b) => a.score - b.score || a.dir.localeCompare(b.dir))[0];
    if (!sidestep) return { type: "WAIT" };
    reserved.add(key(sidestep.position));
    return { type: "MOVE", direction: sidestep.dir };
  }
  reserved.add(key(nextPosition(unit.position, direction)));
  return { type: "MOVE", direction };
}

function actionPosition(unit: UnitObject, action: UnitAction): Position {
  return action.type === "MOVE"
    ? nextPosition(unit.position, action.direction)
    : unit.position;
}

function supportGatedControlAction(
  unit: UnitObject,
  proposed: UnitAction,
  view: Snapshot,
  assessment: Assessment,
  danger: Map<string, number>,
  reserved: Set<string>,
): UnitAction {
  if (proposed.type !== "MOVE") return proposed;
  const destination = actionPosition(unit, proposed);
  const currentSupport = nearestSupportDistance(
    unit.position,
    assessment.supportPositions,
  );
  const destinationSupport = nearestSupportDistance(
    destination,
    assessment.supportPositions,
  );
  if (destinationSupport <= assessment.supportResponseTicks) return proposed;

  reserved.delete(key(destination));
  if (currentSupport <= assessment.supportResponseTicks)
    return { type: "WAIT" };
  const nearestSupport = [...assessment.supportPositions].sort(
    (a, b) =>
      distance(unit.position, a) - distance(unit.position, b) ||
      key(a).localeCompare(key(b)),
  )[0];
  return nearestSupport
    ? moveToward(unit, nearestSupport, view, danger, reserved)
    : { type: "WAIT" };
}

function evasiveWorkerMove(
  unit: UnitObject,
  retreatAnchor: Position,
  view: Snapshot,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
  reserved: Set<string>,
): UnitAction {
  const blocked = blockedCells(view, unit.id);
  for (const cell of reserved) blocked.add(cell);
  const candidate = DIRECTIONS.map(([direction, delta]) => {
    const position: Position = [
      unit.position[0] + delta[0],
      unit.position[1] + delta[1],
    ];
    return {
      direction,
      position,
      blocked: blocked.has(key(position)),
      score:
        (danger.get(key(position)) ?? 0) * 20 +
        distance(position, retreatAnchor) +
        (memory.explored[key(position)] ? 0 : 4) +
        workerCrowdingPenalty(position, unit, view),
    };
  })
    .filter((entry) => !entry.blocked)
    .sort(
      (a, b) => a.score - b.score || a.direction.localeCompare(b.direction),
    )[0];
  if (!candidate) return { type: "WAIT" };
  reserved.add(key(candidate.position));
  return { type: "MOVE", direction: candidate.direction };
}

function approachCorePerimeter(
  unit: UnitObject,
  core: CoreObject,
  view: Snapshot,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
  reserved: ReadonlySet<string>,
  desiredDistance: number,
): Position {
  // Core counts as one friendly occupant, so the Core cell itself only has room
  // for one unit. Combat staging must never claim that slot — leave it for
  // cargo DEPOSIT / SPAWN clearance.
  const minDistance = 1;
  const maxDistance = Math.max(minDistance, desiredDistance);
  const occupied = blockedCells(view, unit.id);
  const scorePosition = (position: Position): number =>
    Math.abs(distance(core.position, position) - desiredDistance) * 5 +
    distance(unit.position, position) +
    (danger.get(key(position)) ?? 0) * 4;

  const freeCandidates = cellsWithin(core.position, maxDistance)
    .filter((position) => {
      const coreDistance = distance(core.position, position);
      if (coreDistance < minDistance || coreDistance > maxDistance)
        return false;
      const positionKey = key(position);
      if (positionKey === key(unit.position)) return true;
      if (!memory.explored[positionKey] && !view.obstacles.has(positionKey)) {
        // Require explored seats when available; geometric fallback handles fog.
      }
      if (!memory.explored[positionKey]) return false;
      if (view.obstacles.has(positionKey) || memory.obstacles[positionKey])
        return false;
      if (occupied.has(positionKey) || reserved.has(positionKey)) return false;
      if ((danger.get(positionKey) ?? 0) > Math.max(0.5, unitPower(unit)))
        return false;
      return true;
    })
    .map((position) => ({ position, score: scorePosition(position) }))
    .sort(
      (a, b) =>
        a.score - b.score || key(a.position).localeCompare(key(b.position)),
    );
  if (freeCandidates[0]) return freeCandidates[0].position;

  // Prefer any explored adjacent seat even if currently crowded — pathing can
  // still walk toward Core instead of WAIT-idling far away.
  const adjacentExplored = DIRECTIONS.map(([, delta]) => {
    const position: Position = [
      core.position[0] + delta[0],
      core.position[1] + delta[1],
    ];
    const positionKey = key(position);
    return {
      position,
      legal:
        Boolean(memory.explored[positionKey]) &&
        !view.obstacles.has(positionKey) &&
        !memory.obstacles[positionKey],
      score: scorePosition(position),
    };
  })
    .filter((candidate) => candidate.legal)
    .sort(
      (a, b) =>
        a.score - b.score || key(a.position).localeCompare(key(b.position)),
    );
  if (adjacentExplored[0]) return adjacentExplored[0].position;

  // Absolute geometric neighbor closest to the unit (ignore fog/reservation).
  const geometric = DIRECTIONS.map(([, delta]) => {
    const position: Position = [
      core.position[0] + delta[0],
      core.position[1] + delta[1],
    ];
    return {
      position,
      legal: !view.obstacles.has(key(position)),
      score: distance(unit.position, position),
    };
  })
    .filter((candidate) => candidate.legal)
    .sort(
      (a, b) =>
        a.score - b.score || key(a.position).localeCompare(key(b.position)),
    );
  return geometric[0]?.position ?? unit.position;
}

function approachCoreCell(
  unit: UnitObject,
  core: CoreObject,
  view: Snapshot,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
  reserved: ReadonlySet<string>,
  allowCoreCell = true,
): Position {
  // Only cargo workers may stand on the Core cell. Core already consumes one of
  // the two same-team stack slots, so a parked Vanguard blocks DEPOSIT/SPAWN.
  if (allowCoreCell) {
    const coreOccupied = view.units.some(
      (candidate) =>
        candidate.id !== unit.id &&
        key(candidate.position) === key(core.position),
    );
    if (!coreOccupied && !reserved.has(key(core.position)))
      return core.position;
  }

  return approachCorePerimeter(unit, core, view, memory, danger, reserved, 1);
}

function moveTowardCore(
  unit: UnitObject,
  core: CoreObject,
  view: Snapshot,
  memory: StrategyMemory,
  danger: Map<string, number>,
  reserved: Set<string>,
  options?: { allowCoreCell?: boolean; desiredDistance?: number },
): UnitAction {
  // Cargo workers may enter the Core cell for DEPOSIT. Combat units only stage
  // on the perimeter so they do not consume Core's single free stack slot.
  const allowCoreCell = options?.allowCoreCell ?? unit.unit_type === "WORKER";
  const desiredDistance = Math.max(1, options?.desiredDistance ?? 1);
  if (!allowCoreCell && key(unit.position) === key(core.position)) {
    // Step off immediately via any free neighbor; do not WAIT on the DEPOSIT seat.
    const forced = approachCorePerimeter(
      unit,
      core,
      view,
      memory,
      danger,
      reserved,
      desiredDistance,
    );
    if (key(forced) !== key(unit.position)) {
      return moveToward(unit, forced, view, danger, reserved, true);
    }
  }
  const target = allowCoreCell
    ? approachCoreCell(unit, core, view, memory, danger, reserved, true)
    : approachCorePerimeter(
        unit,
        core,
        view,
        memory,
        danger,
        reserved,
        desiredDistance,
      );
  if (key(target) === key(unit.position)) return { type: "WAIT" };
  return moveToward(
    unit,
    target,
    view,
    danger,
    reserved,
    // Allow the goal cell even if currently occupied so pathing can close; stack
    // rules still reject illegal final occupancy at resolution time.
    true,
  );
}

function axisVector(from: Position, to: Position): Position {
  const direction = directionBetween(from, to);
  return (
    DIRECTIONS.find(([candidate]) => candidate === direction)?.[1] ?? [1, 0]
  );
}

function offsetPosition(
  origin: Position,
  axis: Position,
  forward: number,
  lateral: number,
): Position {
  const side: Position = [-axis[1], axis[0]];
  return [
    origin[0] + axis[0] * forward + side[0] * lateral,
    origin[1] + axis[1] * forward + side[1] * lateral,
  ];
}

function formationCandidates(
  anchor: Position,
  axis: Position,
  unitType: UnitType,
  contact: boolean,
): Position[] {
  if (unitType === "VANGUARD") {
    return contact
      ? [
          offsetPosition(anchor, axis, -1, 0),
          offsetPosition(anchor, axis, 0, -1),
          offsetPosition(anchor, axis, 0, 1),
          offsetPosition(anchor, axis, 1, 0),
        ]
      : [0, -1, 1, -2, 2].map((side) => offsetPosition(anchor, axis, 1, side));
  }
  if (contact) {
    return [
      offsetPosition(anchor, axis, -3, 0),
      offsetPosition(anchor, axis, 0, -2),
      offsetPosition(anchor, axis, 0, 2),
      offsetPosition(anchor, axis, -3, -1),
      offsetPosition(anchor, axis, -3, 1),
      offsetPosition(anchor, axis, -2, 0),
    ];
  }
  return [0, -1, 1, -2, 2].map((side) =>
    offsetPosition(anchor, axis, -1, side),
  );
}

function validFormationCell(
  cell: Position,
  unit: UnitObject,
  view: Snapshot,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
  assigned: ReadonlySet<string>,
  contact: boolean,
): boolean {
  const cellKey = key(cell);
  return (
    Boolean(memory.explored[cellKey]) &&
    !view.obstacles.has(cellKey) &&
    key(view.core?.position ?? unit.position) !== cellKey &&
    !view.enemies.some((enemy) => key(enemy.position) === cellKey) &&
    !assigned.has(cellKey) &&
    (danger.get(cellKey) ?? 0) <=
      (contact
        ? unit.unit_type === "VANGUARD"
          ? unitPower(unit) * 2
          : unitPower(unit)
        : 0.5) &&
    (cellKey === key(unit.position) ||
      !blockedCells(view, unit.id).has(cellKey))
  );
}

function rallyAnchorForObjective(
  core: CoreObject,
  objective: Position,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
): Position {
  const candidates = Object.values(memory.explored)
    .filter(
      (position) =>
        !memory.obstacles[key(position)] &&
        (danger.get(key(position)) ?? 0) <= 0.5 &&
        knownSafeStep(core.position, position, memory, danger, 0.5),
    )
    .map((position) => ({
      position,
      score:
        Math.abs(distance(position, objective) - 4) * 5 +
        distance(core.position, position),
    }))
    .sort(
      (a, b) =>
        a.score - b.score || key(a.position).localeCompare(key(b.position)),
    );
  return candidates[0]?.position ?? core.position;
}

function assignFormationCells(
  units: readonly UnitObject[],
  anchor: Position,
  objective: Position,
  view: Snapshot,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
  contact: boolean,
): Map<string, Position> {
  const axis = axisVector(view.core?.position ?? anchor, objective);
  const assigned = new Set<string>();
  const result = new Map<string, Position>();
  for (const unit of [...units].sort(
    (a, b) =>
      (a.unit_type === "VANGUARD" ? 0 : 1) -
        (b.unit_type === "VANGUARD" ? 0 : 1) || a.id.localeCompare(b.id),
  )) {
    const candidates = formationCandidates(
      anchor,
      axis,
      unit.unit_type,
      contact,
    ).sort(
      (a, b) =>
        (key(a) === key(unit.position) ? -100 : distance(unit.position, a)) -
          (key(b) === key(unit.position) ? -100 : distance(unit.position, b)) ||
        key(a).localeCompare(key(b)),
    );
    const cell =
      candidates.find((candidate) =>
        validFormationCell(
          candidate,
          unit,
          view,
          memory,
          danger,
          assigned,
          contact,
        ),
      ) ?? unit.position;
    assigned.add(key(cell));
    result.set(unit.id, cell);
  }
  return result;
}

function primaryCombatTarget(
  tick: number,
  view: Snapshot,
  memory: StrategyMemory,
  assessment: Assessment,
): { position: Position } | undefined {
  const core = view.core;
  if (!core || assessment.retreatRequired) return undefined;
  if (assessment.threatened) {
    return nearest(
      core.position,
      view.enemies.filter((enemy) => !isEnemyWorker(enemy)),
    );
  }
  const visibleCombatThreat = nearest(
    core.position,
    view.enemies.filter((enemy) => !isEnemyWorker(enemy)),
  );
  if (visibleCombatThreat) return visibleCombatThreat;
  if (assessment.posture === "ATTACK" || assessment.posture === "CONTEST") {
    const enemyCore = view.enemies.find((enemy) => enemy.kind === "CORE");
    if (enemyCore) return enemyCore;
    const rememberedCore = Object.values(memory.enemies)
      .filter((enemy) => enemy.kind === "CORE")
      .sort((a, b) => b.lastSeenTick - a.lastSeenTick)[0];
    if (rememberedCore) {
      const age = Math.max(0, tick - rememberedCore.lastSeenTick);
      let predicted = rememberedCore.position;
      for (let step = 0; step < Math.min(3, age); step += 1) {
        if (!rememberedCore.lastMove) break;
        predicted = nextPosition(predicted, rememberedCore.lastMove);
      }
      return { position: predicted };
    }
    // Keep pushing the approach lane after a cleared wave so scouts gain Core
    // vision instead of idling on positional control near home.
    const rememberedCombat = Object.values(memory.enemies)
      .filter(
        (enemy) =>
          enemy.kind === "CORE" ||
          (enemy.unitType !== undefined && enemy.unitType !== "WORKER"),
      )
      .sort(
        (a, b) =>
          b.lastSeenTick - a.lastSeenTick ||
          distance(core.position, b.position) -
            distance(core.position, a.position) ||
          a.id.localeCompare(b.id),
      )[0];
    if (rememberedCombat) return { position: rememberedCombat.position };
  }
  if (assessment.posture !== "ATTACK" && assessment.posture !== "CONTEST")
    return undefined;
  return [...view.enemies]
    .filter((enemy) => !isEnemyWorker(enemy))
    .sort((a, b) => {
      const aThreat = enemyPower(a);
      const bThreat = enemyPower(b);
      return (
        bThreat - aThreat ||
        distance(core.position, a.position) -
          distance(core.position, b.position) ||
        a.id.localeCompare(b.id)
      );
    })[0];
}

function combatFormationOrders(
  tick: number,
  view: Snapshot,
  memory: StrategyMemory,
  assessment: Assessment,
  danger: ReadonlyMap<string, number>,
): Map<string, CombatFormationOrder> {
  const core = view.core;
  if (assessment.threatened) return new Map();
  const target = primaryCombatTarget(tick, view, memory, assessment);
  if (!core || !target) return new Map();
  const combatUnits = view.units.filter((unit) => unit.unit_type !== "WORKER");
  const participants = combatUnits.filter(
    (unit) =>
      !assessment.reserveIds.has(unit.id) &&
      !assessment.controlIds.has(unit.id) &&
      !assessment.responseIds.has(unit.id),
  );
  if (participants.length < 2) return new Map();

  const precontactStaging =
    !assessment.threatened &&
    assessment.posture !== "ATTACK" &&
    assessment.posture !== "CONTEST";
  const rallyAnchor = precontactStaging
    ? assessment.supportAnchor
    : rallyAnchorForObjective(core, target.position, memory, danger);
  const rallyCells = assignFormationCells(
    participants,
    rallyAnchor,
    target.position,
    view,
    memory,
    danger,
    false,
  );
  const continuingAdvance = participants.some((unit) => {
    const role = memory.roles[unit.id];
    return (
      (role?.kind === "ADVANCE" || role?.kind === "ENGAGE") &&
      key(role.anchor) === key(target.position)
    );
  });
  const readyCount = participants.filter(
    (unit) =>
      distance(unit.position, rallyCells.get(unit.id) ?? unit.position) <= 1,
  ).length;
  const requiredReady = Math.max(2, Math.ceil(participants.length * 0.6));
  const advancing =
    assessment.posture === "ATTACK" ||
    (!precontactStaging && (continuingAdvance || readyCount >= requiredReady));
  const contactCells = advancing
    ? assignFormationCells(
        participants,
        target.position,
        target.position,
        view,
        memory,
        danger,
        true,
      )
    : rallyCells;
  return new Map(
    participants.map((unit) => [
      unit.id,
      {
        objective: target.position,
        formationCell: contactCells.get(unit.id) ?? unit.position,
        phase: advancing ? "ADVANCE" : "RALLY",
      },
    ]),
  );
}

function rangerDisengagement(
  unit: UnitObject,
  core: CoreObject,
  view: Snapshot,
  danger: ReadonlyMap<string, number>,
  reserved: Set<string>,
): UnitAction | undefined {
  if (unit.unit_type !== "RANGER") return undefined;
  const meleeThreat = nearest(
    unit.position,
    view.enemies.filter(
      (enemy): enemy is UnitObject =>
        enemy.kind === "UNIT" &&
        enemy.unit_type === "VANGUARD" &&
        distance(unit.position, enemy.position) <= 1,
    ),
  );
  if (!meleeThreat) return undefined;
  const blocked = blockedCells(view, unit.id);
  for (const cell of reserved) blocked.add(cell);
  const escape = DIRECTIONS.map(([direction, delta]) => {
    const position: Position = [
      unit.position[0] + delta[0],
      unit.position[1] + delta[1],
    ];
    return {
      direction,
      position,
      score:
        (danger.get(key(position)) ?? 0) * 20 -
        distance(position, meleeThreat.position) * 6 +
        distance(position, core.position),
    };
  })
    .filter(
      (candidate) =>
        !blocked.has(key(candidate.position)) &&
        distance(candidate.position, meleeThreat.position) > 1,
    )
    .sort(
      (a, b) => a.score - b.score || a.direction.localeCompare(b.direction),
    )[0];
  if (!escape) return undefined;
  reserved.add(key(escape.position));
  return { type: "MOVE", direction: escape.direction };
}

function incomingAttackCount(position: Position, view: Snapshot): number {
  return view.enemies.filter((enemy) => {
    if (enemy.kind !== "UNIT") return false;
    if (enemy.unit_type === "VANGUARD")
      return distance(enemy.position, position) === 1;
    if (enemy.unit_type === "RANGER")
      return lineClear(enemy.position, position, view.obstacles);
    return false;
  }).length;
}

function canDamageCoreNow(
  enemy: CoreObject | UnitObject,
  core: CoreObject,
  obstacles: ReadonlySet<string>,
): enemy is UnitObject {
  return (
    enemy.kind === "UNIT" &&
    ((enemy.unit_type === "VANGUARD" &&
      distance(enemy.position, core.position) === 1) ||
      (enemy.unit_type === "RANGER" &&
        lineClear(enemy.position, core.position, obstacles)))
  );
}

function isOnCoreAxis(core: Position, position: Position): boolean {
  return position[0] === core[0] || position[1] === core[1];
}

function freefireCorridorAxis(
  core: Position,
  threat: Position,
): "x" | "y" | undefined {
  if (threat[0] === core[0]) return "x";
  if (threat[1] === core[1]) return "y";
  return undefined;
}

function onFreefireCorridor(
  core: Position,
  threat: Position,
  position: Position,
): boolean {
  const axis = freefireCorridorAxis(core, threat);
  if (axis === "x") return position[0] === core[0];
  if (axis === "y") return position[1] === core[1];
  return false;
}

/** One-step cross-axis fix onto a live freefire corridor (not early approach). */
function rangerCorridorAlignStep(
  unit: UnitObject,
  threat: CoreObject | UnitObject,
  core: CoreObject,
  view: Snapshot,
  reserved: Set<string>,
): UnitAction | undefined {
  if (unit.unit_type !== "RANGER") return undefined;
  if (threat.kind !== "UNIT" || threat.unit_type !== "RANGER") return undefined;
  // Early corridor pulls (pre-freefire) regressed multiwave raids. Only snap in
  // once the ranger can already damage Core.
  if (!canDamageCoreNow(threat, core, view.obstacles)) return undefined;
  const axis = freefireCorridorAxis(core.position, threat.position);
  if (!axis) return undefined;
  if (onFreefireCorridor(core.position, threat.position, unit.position))
    return undefined;

  // Do not align from the far side of Core 闂?that parks behind Core and then
  // pathing walks onto the Core cell (RANGED_PRESSURE seed 6).
  if (axis === "x") {
    const threatSide = Math.sign(threat.position[1] - core.position[1]);
    const unitSide = Math.sign(unit.position[1] - core.position[1]);
    if (threatSide !== 0 && unitSide !== 0 && threatSide !== unitSide)
      return undefined;
  } else {
    const threatSide = Math.sign(threat.position[0] - core.position[0]);
    const unitSide = Math.sign(unit.position[0] - core.position[0]);
    if (threatSide !== 0 && unitSide !== 0 && threatSide !== unitSide)
      return undefined;
  }

  const direction: Direction =
    axis === "x"
      ? unit.position[0] < core.position[0]
        ? "RIGHT"
        : "LEFT"
      : unit.position[1] < core.position[1]
        ? "DOWN"
        : "UP";
  const destination = nextPosition(unit.position, direction);
  const blocked = blockedCells(view, unit.id);
  for (const cell of reserved) blocked.add(cell);
  if (blocked.has(key(destination))) return undefined;
  if (incomingAttackCount(destination, view) >= unit.hp) return undefined;
  reserved.add(key(destination));
  return { type: "MOVE", direction };
}

function selectCoreDefenseThreat(
  core: CoreObject,
  view: Snapshot,
): CoreObject | UnitObject | undefined {
  const threats = view.enemies.filter((enemy) => !isEnemyWorker(enemy));
  if (threats.length === 0) return undefined;
  // Keep distance primary so multiwave melee breaches still win. Only break
  // equal-distance ties toward on-axis Rangers so pre-freefire alignment works
  // without dragging the whole army onto a distant freefire column.
  return [...threats].sort((a, b) => {
    const axisRangerRank = (enemy: CoreObject | UnitObject): number =>
      enemy.kind === "UNIT" &&
      enemy.unit_type === "RANGER" &&
      isOnCoreAxis(core.position, enemy.position)
        ? 0
        : 1;
    return (
      distance(core.position, a.position) -
        distance(core.position, b.position) ||
      axisRangerRank(a) - axisRangerRank(b) ||
      key(a.position).localeCompare(key(b.position))
    );
  })[0];
}

function rangedBreachAnchor(
  unit: UnitObject,
  target: CoreObject | UnitObject,
  core: CoreObject,
  view: Snapshot,
  reserved: ReadonlySet<string>,
): Position | undefined {
  if (unit.unit_type !== "RANGER") return undefined;
  if (lineClear(unit.position, target.position, view.obstacles))
    return undefined;
  const blocked = blockedCells(view, unit.id);
  for (const cell of reserved) blocked.add(cell);
  const freefire = canDamageCoreNow(target, core, view.obstacles);
  const scoreCell = (position: Position): number =>
    (incomingAttackCount(position, view) >= unit.hp ? 1000 : 0) +
    incomingAttackCount(position, view) * 40 +
    // Do not park on the Core cell: pathing there detours around melee and
    // walks off the freefire corridor (RANGED_PRESSURE seed 6).
    (key(position) === key(core.position) ? 200 : 0) +
    distance(position, core.position) * 3 +
    distance(unit.position, position) * 2 +
    // Prefer a clear shoot seat ~2 tiles from a freefirer, not Core-adjacent cover.
    (freefire ? Math.abs(distance(position, target.position) - 2) * 4 : 0) +
    (freefire && isOnCoreAxis(core.position, position) ? 0 : freefire ? 6 : 0);

  const stepLane = DIRECTIONS.map(([, delta]) => {
    const position: Position = [
      unit.position[0] + delta[0],
      unit.position[1] + delta[1],
    ];
    return position;
  })
    .filter(
      (position) =>
        !blocked.has(key(position)) &&
        key(position) !== key(core.position) &&
        lineClear(position, target.position, view.obstacles),
    )
    .sort(
      (a, b) => scoreCell(a) - scoreCell(b) || key(a).localeCompare(key(b)),
    )[0];
  if (stepLane) return stepLane;

  const alignCandidates: Position[] = [
    [target.position[0], unit.position[1]],
    [unit.position[0], target.position[1]],
  ];
  for (const direction of ["UP", "DOWN", "LEFT", "RIGHT"] as const) {
    for (let range = 1; range <= 3; range += 1) {
      let cursor = target.position;
      for (let step = 0; step < range; step += 1)
        cursor = nextPosition(cursor, direction);
      alignCandidates.push(cursor);
    }
  }
  return alignCandidates
    .filter(
      (position) =>
        key(position) !== key(unit.position) &&
        key(position) !== key(target.position) &&
        key(position) !== key(core.position) &&
        !view.obstacles.has(key(position)) &&
        lineClear(position, target.position, view.obstacles) &&
        distance(position, core.position) <=
          distance(target.position, core.position) + 2,
    )
    .sort(
      (a, b) =>
        scoreCell(a) - scoreCell(b) ||
        distance(unit.position, a) - distance(unit.position, b) ||
        key(a).localeCompare(key(b)),
    )[0];
}

function predictedEnemyCell(
  enemy: CoreObject | UnitObject,
  memory: StrategyMemory,
): Position {
  const observation = memory.enemies[enemy.id];
  if (
    !observation?.lastMove ||
    (observation.movementStreak ?? 0) < 1 ||
    enemy.kind !== "UNIT" ||
    enemy.unit_type === "RANGER"
  ) {
    return enemy.position;
  }
  const predicted = nextPosition(enemy.position, observation.lastMove);
  return memory.obstacles[key(predicted)] ? enemy.position : predicted;
}

function enemyExpectedToAdvance(
  enemy: CoreObject | UnitObject,
  core: CoreObject,
  view: Snapshot,
  memory: StrategyMemory,
): boolean {
  if (enemy.kind !== "UNIT") return false;
  const predicted = predictedEnemyCell(enemy, memory);
  return (
    key(predicted) !== key(enemy.position) &&
    distance(predicted, core.position) <
      distance(enemy.position, core.position) &&
    !canDamageCoreNow(enemy, core, view.obstacles)
  );
}

function movingMeleeCutoff(
  unit: UnitObject,
  core: CoreObject,
  view: Snapshot,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
  reserved: Set<string>,
  allocatedDamage?: Map<string, number>,
): UnitAction | undefined {
  if (unit.unit_type !== "VANGUARD") return undefined;
  // Still freefire-strike if we are already adjacent to a live Core hitter.
  // Otherwise allow cutoff even under freefire so side-adjacent melee cannot
  // step off our sweep cell before combat (RANGED_PRESSURE seed 7).
  if (
    view.enemies.some(
      (enemy) =>
        canDamageCoreNow(enemy, core, view.obstacles) &&
        distance(unit.position, enemy.position) === 1,
    )
  ) {
    return undefined;
  }
  const threat = view.enemies.find(
    (enemy): enemy is UnitObject =>
      enemy.kind === "UNIT" &&
      enemy.unit_type === "VANGUARD" &&
      distance(unit.position, enemy.position) === 1 &&
      enemyExpectedToAdvance(enemy, core, view, memory),
  );
  if (!threat) return undefined;
  const predicted = predictedEnemyCell(threat, memory);
  // Already standing on the predicted advance cell: sweep now instead of
  // stepping off the intercept (CORE_ASSAULT seed 2). Keep this inside cutoff
  // so only advancing adjacent melee is affected 闂?not all visibleAttack paths.
  if (key(unit.position) === key(predicted)) {
    const direction = directionBetween(unit.position, threat.position);
    if (direction && incomingAttackCount(unit.position, view) < unit.hp) {
      if (allocatedDamage)
        allocatedDamage.set(
          threat.id,
          (allocatedDamage.get(threat.id) ?? 0) + 1,
        );
      return { type: "SWEEP", direction };
    }
    return undefined;
  }
  const blocked = blockedCells(view, unit.id);
  for (const cell of reserved) blocked.add(cell);
  const cutoff = DIRECTIONS.map(([direction, delta]) => {
    const position: Position = [
      unit.position[0] + delta[0],
      unit.position[1] + delta[1],
    ];
    return { direction, position };
  })
    .filter(
      (candidate) =>
        !blocked.has(key(candidate.position)) &&
        distance(candidate.position, predicted) === 1 &&
        distance(candidate.position, core.position) <=
          distance(unit.position, core.position) &&
        incomingAttackCount(candidate.position, view) < unit.hp,
    )
    .sort(
      (a, b) =>
        (danger.get(key(a.position)) ?? 0) -
          (danger.get(key(b.position)) ?? 0) ||
        distance(a.position, core.position) -
          distance(b.position, core.position) ||
        a.direction.localeCompare(b.direction),
    )[0];
  if (!cutoff) return undefined;
  reserved.add(key(cutoff.position));
  return { type: "MOVE", direction: cutoff.direction };
}

function returnAlongThreatAxis(
  unit: UnitObject,
  threat: CoreObject | UnitObject,
  core: CoreObject,
  view: Snapshot,
  memory: StrategyMemory,
  reserved: Set<string>,
): UnitAction | undefined {
  if (
    threat.kind !== "UNIT" ||
    !enemyExpectedToAdvance(threat, core, view, memory) ||
    distance(unit.position, core.position) <=
      distance(threat.position, core.position)
  ) {
    return undefined;
  }
  // Off-axis units that copy the threat's advance direction march parallel to a
  // freefire corridor (RANGED_PRESSURE) instead of entering the shooting lane.
  if (
    isOnCoreAxis(core.position, threat.position) &&
    !isOnCoreAxis(core.position, unit.position)
  ) {
    return undefined;
  }
  const advanceDirection = memory.enemies[threat.id]?.lastMove;
  if (!advanceDirection) return undefined;
  const destination = nextPosition(unit.position, advanceDirection);
  const blocked = blockedCells(view, unit.id);
  for (const cell of reserved) blocked.add(cell);
  if (
    blocked.has(key(destination)) ||
    distance(destination, core.position) >=
      distance(unit.position, core.position)
  ) {
    return undefined;
  }
  reserved.add(key(destination));
  return { type: "MOVE", direction: advanceDirection };
}

function lethalCombatEvasion(
  unit: UnitObject,
  core: CoreObject,
  view: Snapshot,
  danger: ReadonlyMap<string, number>,
  reserved: Set<string>,
): UnitAction | undefined {
  const currentIncoming = incomingAttackCount(unit.position, view);
  if (currentIncoming < unit.hp) return undefined;
  const blocked = blockedCells(view, unit.id);
  for (const cell of reserved) blocked.add(cell);
  const escape = DIRECTIONS.map(([direction, delta]) => {
    const position: Position = [
      unit.position[0] + delta[0],
      unit.position[1] + delta[1],
    ];
    return {
      direction,
      position,
      incoming: incomingAttackCount(position, view),
      score:
        incomingAttackCount(position, view) * 100 +
        (danger.get(key(position)) ?? 0) * 8 +
        distance(position, core.position),
    };
  })
    .filter(
      (candidate) =>
        !blocked.has(key(candidate.position)) &&
        candidate.incoming < currentIncoming &&
        candidate.incoming < unit.hp,
    )
    .sort(
      (a, b) => a.score - b.score || a.direction.localeCompare(b.direction),
    )[0];
  if (!escape) return undefined;
  reserved.add(key(escape.position));
  return { type: "MOVE", direction: escape.direction };
}

function visibleAttack(
  unit: UnitObject,
  view: Snapshot,
  allocatedDamage: Map<string, number>,
  memory: StrategyMemory,
  assessment: Assessment,
): UnitAction | undefined {
  const core = view.core;
  const enemies = view.enemies
    .filter((enemy) => {
      if (!core || !isEnemyWorker(enemy)) return true;
      if (memory.enemies[enemy.id]?.lastMove) return false;
      if (
        unit.unit_type === "RANGER" &&
        lineClear(unit.position, enemy.position, view.obstacles)
      ) {
        return true;
      }
      const guardPower = nearbyGuardPower(enemy, view.enemies);
      const friendlyPower = nearbyFriendlyPower(enemy.position, view.units);
      return (
        valuableWorkerIntrusion(
          enemy,
          core,
          memory.resources,
          assessment.controlRadius,
        ) && friendlyPower >= Math.max(1, guardPower * 1.25)
      );
    })
    .sort((a, b) => {
      const targetValue = (enemy: CoreObject | UnitObject): number => {
        const corePressure = core
          ? Math.max(
              0,
              assessment.controlRadius -
                distance(core.position, enemy.position),
            )
          : 0;
        const adjacentPressure =
          enemy.kind === "UNIT" &&
          enemy.unit_type === "VANGUARD" &&
          distance(unit.position, enemy.position) <= 1
            ? 8
            : 0;
        const objectiveValue =
          enemy.kind === "CORE" && assessment.posture === "ATTACK" ? 8 : 0;
        const immediateCoreDamage =
          core && canDamageCoreNow(enemy, core, view.obstacles) ? 14 : 0;
        const sustainedRangedFire =
          core &&
          enemy.kind === "UNIT" &&
          enemy.unit_type === "RANGER" &&
          canDamageCoreNow(enemy, core, view.obstacles)
            ? 16
            : 0;
        return (
          enemyPower(enemy) * 3 +
          corePressure +
          adjacentPressure +
          objectiveValue +
          immediateCoreDamage +
          sustainedRangedFire
        );
      };
      const aThreat = targetValue(a);
      const bThreat = targetValue(b);
      const aRemaining = Math.max(0, a.hp - (allocatedDamage.get(a.id) ?? 0));
      const bRemaining = Math.max(0, b.hp - (allocatedDamage.get(b.id) ?? 0));
      return (
        bThreat - aThreat || aRemaining - bRemaining || a.id.localeCompare(b.id)
      );
    });
  if (unit.unit_type === "VANGUARD") {
    const freefireEnemy =
      core &&
      enemies.find((enemy) => canDamageCoreNow(enemy, core, view.obstacles));
    // Only the unit one step off the freefire corridor should force-sweep an
    // advancing melee instead of sidestepping onto the lane (seed 6). Broader
    // freefire sweeps regressed RECURRING_RAIDS multiwave seeds.
    const freefireAxis =
      core && freefireEnemy
        ? freefireCorridorAxis(core.position, freefireEnemy.position)
        : undefined;
    const oneStepOffCorridor = core
      ? freefireAxis === "x"
        ? Math.abs(unit.position[0] - core.position[0]) === 1
        : freefireAxis === "y"
          ? Math.abs(unit.position[1] - core.position[1]) === 1
          : false
      : false;
    const forceFreefireMeleeSweep = Boolean(
      freefireEnemy &&
        freefireAxis &&
        oneStepOffCorridor &&
        !onFreefireCorridor(
          core.position,
          freefireEnemy.position,
          unit.position,
        ),
    );
    const adjacent = enemies.find((enemy) => {
      if (distance(unit.position, enemy.position) !== 1) return false;
      if ((allocatedDamage.get(enemy.id) ?? 0) >= enemy.hp) return false;
      if (!core || forceFreefireMeleeSweep) return true;
      // Near-Core ring: always contest adjacent melee. Side-adjacent refusal
      // let CORE-bound vanguards walk past while we chase freefire (RANGED 7).
      if (distance(unit.position, core.position) <= 2) return true;
      if (!enemyExpectedToAdvance(enemy, core, view, memory)) return true;
      // Field on-tile intercept only. Broad field adjacent locks stranded the
      // army during RECURRING_RAIDS multiwave pursuit.
      return (
        key(predictedEnemyCell(enemy, memory)) === key(unit.position) &&
        distance(unit.position, core.position) <= 3
      );
    });
    // Live freefire two steps along our corridor outranks speculative melee
    // lead-sweeps. Closing now lets us cut freefire shots (RANGED seed 7).
    const closeFreefireFirst = Boolean(
      freefireEnemy &&
        !adjacent &&
        onFreefireCorridor(
          core.position,
          freefireEnemy.position,
          unit.position,
        ) &&
        distance(unit.position, freefireEnemy.position) === 2 &&
        (allocatedDamage.get(freefireEnemy.id) ?? 0) < freefireEnemy.hp,
    );
    const advancing =
      adjacent || closeFreefireFirst
        ? undefined
        : enemies.find((enemy) => {
            if (isEnemyWorker(enemy)) return false;
            const observation = memory.enemies[enemy.id];
            if (!observation?.lastMove) return false;
            return (
              distance(unit.position, predictedEnemyCell(enemy, memory)) ===
                1 && (allocatedDamage.get(enemy.id) ?? 0) < enemy.hp
            );
          });
    const sweepTarget =
      adjacent?.position ??
      (advancing ? predictedEnemyCell(advancing, memory) : undefined);
    const direction = sweepTarget
      ? directionBetween(unit.position, sweepTarget)
      : undefined;
    if (sweepTarget && direction) {
      for (const enemy of enemies.filter(
        (candidate) =>
          key(
            candidate === advancing
              ? predictedEnemyCell(candidate, memory)
              : candidate.position,
          ) === key(sweepTarget),
      ))
        allocatedDamage.set(enemy.id, (allocatedDamage.get(enemy.id) ?? 0) + 1);
      return { type: "SWEEP", direction };
    }
  }
  if (unit.unit_type === "RANGER") {
    for (const enemy of enemies) {
      if ((allocatedDamage.get(enemy.id) ?? 0) >= enemy.hp) continue;
      const observation = memory.enemies[enemy.id];
      if (isEnemyWorker(enemy) && observation?.lastMove) continue;
      const predictedCell = predictedEnemyCell(enemy, memory);
      // Only override lead shots for live Core freefirers. Broad fallback to the
      // current cell regresses kiting fights (PURSUIT) where leading matters.
      // Approaching (non-freefire) targets still use lead shots when the lane is clear.
      const freefireAim =
        core &&
        canDamageCoreNow(enemy, core, view.obstacles) &&
        lineClear(unit.position, enemy.position, view.obstacles)
          ? enemy.position
          : undefined;
      const expectedCell = lineClear(
        unit.position,
        predictedCell,
        view.obstacles,
      )
        ? predictedCell
        : freefireAim;
      if (!expectedCell) continue;
      allocatedDamage.set(enemy.id, (allocatedDamage.get(enemy.id) ?? 0) + 1);
      return {
        type: "SHOOT",
        target_id: enemy.id,
        expected_cell: expectedCell,
      };
    }
  }
  return undefined;
}

function attackFinishesCoreThreat(
  action: UnitAction | undefined,
  core: CoreObject,
  view: Snapshot,
  damageBefore: ReadonlyMap<string, number>,
  damageAfter: ReadonlyMap<string, number>,
): boolean {
  if (!action || (action.type !== "SWEEP" && action.type !== "SHOOT"))
    return false;
  return view.enemies.some(
    (enemy) =>
      canDamageCoreNow(enemy, core, view.obstacles) &&
      (damageBefore.get(enemy.id) ?? 0) < enemy.hp &&
      (damageAfter.get(enemy.id) ?? 0) >= enemy.hp,
  );
}

/** True when the attack damages a unit that is currently hurting Core. */
function attackHitsCoreThreat(
  action: UnitAction | undefined,
  core: CoreObject,
  view: Snapshot,
  damageBefore: ReadonlyMap<string, number>,
  damageAfter: ReadonlyMap<string, number>,
): boolean {
  if (!action || (action.type !== "SWEEP" && action.type !== "SHOOT"))
    return false;
  return view.enemies.some(
    (enemy) =>
      canDamageCoreNow(enemy, core, view.obstacles) &&
      (damageAfter.get(enemy.id) ?? 0) > (damageBefore.get(enemy.id) ?? 0),
  );
}

function harassmentDecision(
  tick: number,
  unit: UnitObject,
  core: CoreObject,
  view: Snapshot,
  memory: StrategyMemory,
  assessment: Assessment,
  danger: Map<string, number>,
  reserved: Set<string>,
): { action: UnitAction; role: RoleMemory } | undefined {
  const target = [...view.enemies]
    .filter(
      (enemy): enemy is UnitObject =>
        isEnemyWorker(enemy) &&
        distance(core.position, enemy.position) <=
          assessment.controlRadius + 1 &&
        valuableWorkerIntrusion(
          enemy,
          core,
          memory.resources,
          assessment.controlRadius,
        ) &&
        nearbyFriendlyPower(enemy.position, view.units) >=
          Math.max(1, nearbyGuardPower(enemy, view.enemies) * 1.25),
    )
    .sort(
      (a, b) =>
        distance(unit.position, a.position) -
          distance(unit.position, b.position) || a.id.localeCompare(b.id),
    )[0];
  if (!target) return undefined;

  const denialAnchor =
    Object.values(memory.resources)
      .filter((resource) => distance(resource.position, target.position) <= 3)
      .sort(
        (a, b) =>
          distance(a.position, target.position) -
            distance(b.position, target.position) ||
          key(a.position).localeCompare(key(b.position)),
      )[0]?.position ?? target.position;
  return {
    action: moveToward(unit, denialAnchor, view, danger, reserved),
    role: {
      kind: "ENGAGE",
      anchor: denialAnchor,
      sinceTick:
        memory.roles[unit.id]?.kind === "ENGAGE"
          ? (memory.roles[unit.id]?.sinceTick ?? tick)
          : tick,
    },
  };
}

function angularDistance(a: number, b: number): number {
  const delta = Math.abs(a - b);
  return Math.min(delta, Math.PI * 2 - delta);
}

function explorationWorkerIndexes(
  tick: number,
  workers: readonly UnitObject[],
  core: CoreObject | undefined,
  rotate: boolean,
): ReadonlyMap<string, number> {
  if (!core || workers.length === 0) return new Map();
  const workerCount = workers.length;
  const sectorCount = 8;
  const rotationEpoch = Math.floor(tick / Math.max(4, workerCount * 2));
  const rotation = rotate ? (rotationEpoch / sectorCount) * Math.PI * 2 : 0;
  const angle = (position: Position): number => {
    const raw = Math.atan2(
      position[1] - core.position[1],
      position[0] - core.position[0],
    );
    return raw < 0 ? raw + Math.PI * 2 : raw;
  };
  const orderedWorkers = [...workers].sort(
    (a, b) => angle(a.position) - angle(b.position) || a.id.localeCompare(b.id),
  );
  let bestOffset = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < workerCount; offset += 1) {
    const score = orderedWorkers.reduce((total, worker, orderIndex) => {
      const workerIndex = (orderIndex + offset) % workerCount;
      const targetAngle =
        ((workerIndex / workerCount) * Math.PI * 2 + rotation) % (Math.PI * 2);
      return total + angularDistance(angle(worker.position), targetAngle);
    }, 0);
    if (score < bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  return new Map(
    orderedWorkers.map((worker, orderIndex) => [
      worker.id,
      (orderIndex + bestOffset) % workerCount,
    ]),
  );
}

function workerExplorationTarget(
  tick: number,
  workerIndex: number,
  workerCount: number,
  workerPosition: Position,
  core: CoreObject,
  radius: number,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
  assignedTargets: ReadonlySet<string>,
  resourceScarce: boolean,
  config: StrategyConfig,
  dutyScoutBias = false,
): Position {
  const forwardExtension = resourceScarce
    ? config.resourceScarcityScoutExtension
    : config.workerScoutExtension;
  const scoutExtension =
    resourceScarce || workerCount >= 3
      ? forwardExtension
      : Math.max(1, Math.ceil(forwardExtension / 2));
  const scoutRadius = resourceScarce
    ? Number.POSITIVE_INFINITY
    : Math.min(
        config.maxControlRadius + scoutExtension,
        radius + scoutExtension,
      );
  const reachable = knownSafeReachable(
    workerPosition,
    memory,
    danger,
    config.workerEscapeDanger,
  );
  const escapeOptions = (entry: Position): number =>
    DIRECTIONS.filter(([, delta]) => {
      const neighbor: Position = [entry[0] + delta[0], entry[1] + delta[1]];
      return reachable.has(key(neighbor));
    }).length;
  const frontier = Object.values(memory.explored).flatMap((entry) =>
    DIRECTIONS.map(([, delta]) => {
      const position: Position = [entry[0] + delta[0], entry[1] + delta[1]];
      return { entry, position };
    }),
  );
  const perimeter = [
    ...new Map(
      frontier
        .filter(({ entry, position }) => {
          const positionKey = key(position);
          return (
            !memory.explored[positionKey] &&
            !memory.obstacles[positionKey] &&
            distance(core.position, position) <= scoutRadius &&
            !nearAssignedTarget(
              position,
              assignedTargets,
              config.workerTargetSpacing,
            ) &&
            (danger.get(positionKey) ?? 0) <= config.workerEscapeDanger &&
            reachable.has(key(entry)) &&
            escapeOptions(entry) >= 2
          );
        })
        .map(({ position }) => [key(position), position] as const),
    ).values(),
  ];
  const sectorCount = 8;
  const angle = (position: Position): number => {
    const raw = Math.atan2(
      position[1] - core.position[1],
      position[0] - core.position[0],
    );
    return raw < 0 ? raw + Math.PI * 2 : raw;
  };
  const sectorRadii = Array.from({ length: sectorCount }, () => 0);
  const workerHistory = Object.values(memory.workerExplored ?? {});
  for (const explored of workerHistory.length > 0
    ? workerHistory
    : Object.values(memory.explored)) {
    const exploredSector = Math.floor(
      (angle(explored) / (Math.PI * 2)) * sectorCount,
    );
    sectorRadii[exploredSector] = Math.max(
      sectorRadii[exploredSector] ?? 0,
      distance(core.position, explored),
    );
  }
  const shortestFrontier = Math.min(...sectorRadii);
  const longestFrontier = Math.max(...sectorRadii);
  const imbalanceGap = longestFrontier - shortestFrontier;
  const rotationEpoch = Math.floor(
    tick / Math.max(workerCount <= 2 ? 3 : 4, workerCount * 2),
  );
  // Rotate under scarcity or tiny teams. Do not rotate purely on imbalance:
  // that yank pulls harvest routes across the interior and recreates long hauls.
  const rotateHeading = resourceScarce || workerCount <= 2;
  const defaultAngle =
    ((workerIndex / Math.max(1, workerCount)) * Math.PI * 2 +
      (rotateHeading ? (rotationEpoch / sectorCount) * Math.PI * 2 : 0)) %
    (Math.PI * 2);
  // Only a dedicated duty scout may lock onto the neediest wedge. Multi-worker
  // needy pins recreate same-sector collisions under scarcity.
  const needySectors = sectorRadii
    .map((radius, sector) => ({ radius, sector }))
    .filter((entry) => entry.radius <= shortestFrontier + 1)
    .sort((a, b) => a.radius - b.radius || a.sector - b.sector)
    .map((entry) => entry.sector);
  // Under scarcity, one Worker may lock the neediest fog wedge. Keeping this
  // single-worker-only prevents the multi-body sector stampede that raised
  // workerSectorCollisionTicks above the 1% gate.
  const scarceLeadScout =
    resourceScarce &&
    !dutyScoutBias &&
    workerIndex === 0 &&
    workerHistory.length >= 12 &&
    imbalanceGap >= 4 &&
    shortestFrontier <= 1 &&
    needySectors.length > 0;
  const targetAngle =
    (dutyScoutBias || scarceLeadScout) && needySectors.length > 0
      ? (((needySectors[0] ?? 0) + 0.5) / sectorCount) * Math.PI * 2
      : defaultAngle;
  const sectorDistance = (position: Position): number => {
    return angularDistance(angle(position), targetAngle);
  };
  // Hard rebalance still prefers shallow wedges, but heading stays dominant so
  // Workers rebalance inside their own lane instead of stampeding one sector.
  const rebalanceHard = resourceScarce
    ? imbalanceGap >= 4
    : imbalanceGap >= 5 && workerHistory.length >= 12;
  const imbalanceSlack = resourceScarce ? (rebalanceHard ? 1 : 2) : 1;
  const imbalanceWeight = rebalanceHard ? 40 : resourceScarce ? 20 : 40;
  const behindWeight = rebalanceHard ? 34 : resourceScarce ? 24 : 36;
  const headingWeight = rebalanceHard ? 48 : 56;
  const laneWidth = Math.PI / Math.max(2, workerCount) + 0.35;
  const rankTargets = (positions: readonly Position[]): Position | undefined =>
    positions
      .map((position) => {
        const candidateSector = Math.floor(
          (angle(position) / (Math.PI * 2)) * sectorCount,
        );
        const frontierImbalance = Math.max(
          0,
          (sectorRadii[candidateSector] ?? 0) -
            shortestFrontier -
            imbalanceSlack,
        );
        const sectorBehind =
          (sectorRadii[candidateSector] ?? 0) <= shortestFrontier + 1 ? 1 : 0;
        const inLane = sectorDistance(position) <= laneWidth;
        const behindBonus = sectorBehind
          ? inLane
            ? behindWeight
            : Math.floor(behindWeight * 0.2)
          : 0;
        const peacetimeOverfill =
          !rebalanceHard && imbalanceGap >= 3
            ? Math.max(
                0,
                distance(core.position, position) - (shortestFrontier + 2),
              )
            : 0;
        const overfill = rebalanceHard
          ? Math.max(
              0,
              distance(core.position, position) - (shortestFrontier + 2),
            )
          : peacetimeOverfill;
        return {
          position,
          score:
            sectorDistance(position) * headingWeight +
            frontierImbalance * imbalanceWeight +
            overfill * (rebalanceHard ? 28 : 24) +
            distance(workerPosition, position) * 0.25 +
            (memory.explored[key(position)] ? 4 : resourceScarce ? -6 : -2) +
            (danger.get(key(position)) ?? 0) * 8 -
            behindBonus,
        };
      })
      .sort(
        (a, b) =>
          a.score - b.score || key(a.position).localeCompare(key(b.position)),
      )[0]?.position;
  const localFallback = Object.values(memory.explored).filter(
    (position) =>
      distance(core.position, position) >= Math.min(2, radius) &&
      distance(core.position, position) <= scoutRadius &&
      !memory.obstacles[key(position)] &&
      !nearAssignedTarget(
        position,
        assignedTargets,
        config.workerTargetSpacing,
      ) &&
      (danger.get(key(position)) ?? 0) <= config.workerEscapeDanger &&
      reachable.has(key(position)),
  );
  return rankTargets(perimeter) ?? rankTargets(localFallback) ?? workerPosition;
}

function stableUnitHash(id: string): number {
  return [...id].reduce(
    (hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0,
    0,
  );
}

function patrolTarget(
  unit: UnitObject,
  core: CoreObject,
  radius: number,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
  assignments: ReadonlySet<string>,
  supports: readonly Position[] = [],
  supportResponseTicks = Number.POSITIVE_INFINITY,
): Position {
  const sectorCount = 8;
  const angle = (position: Position): number => {
    const raw = Math.atan2(
      position[1] - core.position[1],
      position[0] - core.position[0],
    );
    return raw < 0 ? raw + Math.PI * 2 : raw;
  };
  const sectorRadii = Array.from({ length: sectorCount }, () => 0);
  for (const explored of Object.values(memory.explored)) {
    const exploredSector = Math.floor(
      (angle(explored) / (Math.PI * 2)) * sectorCount,
    );
    sectorRadii[exploredSector] = Math.max(
      sectorRadii[exploredSector] ?? 0,
      distance(core.position, explored),
    );
  }
  const shortestFrontier = Math.min(...sectorRadii);
  const longestFrontier = Math.max(...sectorRadii);
  const preferredSector = stableUnitHash(unit.id) % sectorCount;
  const needySectors = Array.from({ length: sectorCount }, (_, index) => index)
    .filter((sector) => (sectorRadii[sector] ?? 0) <= shortestFrontier + 2)
    .sort(
      (a, b) =>
        Math.min(
          Math.abs(a - preferredSector),
          sectorCount - Math.abs(a - preferredSector),
        ) -
          Math.min(
            Math.abs(b - preferredSector),
            sectorCount - Math.abs(b - preferredSector),
          ) || a - b,
    );
  // Keep sticky sector identity unless the frontier is clearly lopsided, and
  // even then redistribute across the shallow set instead of one shared cell.
  const sector =
    longestFrontier - shortestFrontier >= 3 &&
    needySectors.length > 0 &&
    !needySectors.includes(preferredSector)
      ? (needySectors[0] ?? preferredSector)
      : preferredSector;
  const targetAngle = ((sector + 0.5) / sectorCount) * Math.PI * 2;
  const sectorDistance = (position: Position): number =>
    angularDistance(angle(position), targetAngle);
  const knownSafeCells = Object.values(memory.explored).filter(
    (position) =>
      key(position) !== key(core.position) &&
      !memory.obstacles[key(position)] &&
      (danger.get(key(position)) ?? 0) <= 0.5 &&
      (supports.length === 0 ||
        nearestSupportDistance(position, supports) <= supportResponseTicks),
  );
  const knownReach = knownSafeCells.reduce(
    (outer, position) => Math.max(outer, distance(core.position, position)),
    0,
  );
  const targetRadius = Math.min(radius, knownReach);
  const candidate = knownSafeCells
    .filter(
      (position) =>
        distance(core.position, position) >= Math.max(2, targetRadius - 2) &&
        distance(core.position, position) <= targetRadius &&
        !nearAssignedTarget(position, assignments, 3),
    )
    .map((position) => {
      const candidateSector = Math.floor(
        (angle(position) / (Math.PI * 2)) * sectorCount,
      );
      const frontierImbalance = Math.max(
        0,
        (sectorRadii[candidateSector] ?? 0) - shortestFrontier - 2,
      );
      return {
        position,
        score:
          sectorDistance(position) * 12 +
          frontierImbalance * 6 +
          Math.abs(distance(core.position, position) - targetRadius) * 2 +
          Math.max(0, memory.patrolVisits[key(position)] ?? 0) * 0.01,
      };
    })
    .sort(
      (a, b) =>
        a.score - b.score || key(a.position).localeCompare(key(b.position)),
    )[0]?.position;
  if (candidate) return candidate;
  return unit.position;
}

function resourceSupportExtension(
  position: Position,
  core: CoreObject,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
  assessment: Assessment,
  config: StrategyConfig,
  options?: { memoryRecall?: boolean },
): number | undefined {
  if (distance(core.position, position) <= assessment.controlRadius) return 0;

  for (const extension of [
    config.workerScoutExtension,
    config.resourceScarcityScoutExtension,
  ]) {
    if (
      distance(core.position, position) >
      assessment.controlRadius + extension
    )
      continue;
    const supported = assessment.supportPositions.some(
      (support) =>
        distance(position, support) <=
          assessment.supportResponseTicks + extension &&
        knownSafeStep(
          position,
          support,
          memory,
          danger,
          config.workerEscapeDanger,
        ),
    );
    if (supported) return extension;
  }

  // Peacetime recall of a previously walked live fog resource. Without this,
  // workers only orbit the explored vision frontier while known out-of-sight
  // nodes sit unused beyond the combat-support envelope.
  if (
    options?.memoryRecall &&
    !assessment.threatened &&
    !assessment.retreatRequired &&
    distance(core.position, position) <=
      config.maxControlRadius + config.resourceScarcityScoutExtension &&
    knownSafeStep(
      core.position,
      position,
      memory,
      danger,
      config.workerEscapeDanger,
    )
  ) {
    return Math.max(
      0,
      distance(core.position, position) - assessment.controlRadius,
    );
  }
  return undefined;
}

function workerFootprint(
  core: CoreObject,
  memory: StrategyMemory,
): {
  radii: number[];
  spread: number;
  count: number;
} {
  const sectorCount = 8;
  const radii = Array.from({ length: sectorCount }, () => 0);
  const angle = (position: Position): number => {
    const raw = Math.atan2(
      position[1] - core.position[1],
      position[0] - core.position[0],
    );
    return raw < 0 ? raw + Math.PI * 2 : raw;
  };
  for (const cell of Object.values(memory.workerExplored ?? {})) {
    const sector =
      Math.floor((angle(cell) / (Math.PI * 2)) * sectorCount) % sectorCount;
    radii[sector] = Math.max(radii[sector] ?? 0, distance(core.position, cell));
  }
  const active = radii.some((value) => value > 0);
  const min = active ? Math.min(...radii) : 0;
  const max = active ? Math.max(...radii) : 0;
  return {
    radii,
    spread: max - min,
    count: Object.keys(memory.workerExplored ?? {}).length,
  };
}

function workerAction(
  tick: number,
  unit: UnitObject,
  workerIndex: number,
  workerCount: number,
  view: Snapshot,
  memory: StrategyMemory,
  danger: Map<string, number>,
  reserved: Set<string>,
  reservedResources: Set<string>,
  fogResourceClaims: Set<string>,
  visibleResourceTarget: Position | undefined,
  assignedWorkerTargets: Set<string>,
  assessment: Assessment,
  config: StrategyConfig,
): UnitAction {
  const core = view.core;
  if (!core) return { type: "WAIT" };
  const currentDanger = danger.get(key(unit.position)) ?? 0;
  if (currentDanger > config.workerEscapeDanger) {
    const supportSafe =
      key(assessment.supportAnchor) !== key(core.position) &&
      (danger.get(key(assessment.supportAnchor)) ?? 0) <=
        config.workerEscapeDanger &&
      distance(assessment.supportAnchor, core.position) <
        distance(unit.position, core.position);
    return evasiveWorkerMove(
      unit,
      supportSafe ? assessment.supportAnchor : core.position,
      view,
      memory,
      danger,
      reserved,
    );
  }
  if ((unit.cargo ?? 0) > 0) {
    if (key(unit.position) === key(core.position) && core.state === "NORMAL")
      return { type: "DEPOSIT" };
    if ((danger.get(key(core.position)) ?? 0) > config.workerEscapeDanger)
      return { type: "WAIT" };
    return moveTowardCore(unit, core, view, memory, danger, reserved);
  }
  memory.workerDutyScoutUntil ??= {};
  const footprint = workerFootprint(core, memory);
  const hasZeroSector =
    footprint.radii.some((radius) => radius === 0) &&
    footprint.radii.some((radius) => radius > 0);
  const spreadUrgent = hasZeroSector || footprint.spread >= 7;
  const atHome = distance(unit.position, core.position) <= 2;
  const activeStickyScouts = Object.values(
    memory.workerDutyScoutUntil ?? {},
  ).filter((until) => tick < until).length;
  // One concurrent peel keeps chokepoint harvest moving while still breaking
  // MAP_CONTROL wall-gap lock-in on empty worker wedges.
  const stickyCap = 1;
  if (
    !assessment.threatened &&
    !assessment.retreatRequired &&
    footprint.count >= 10 &&
    hasZeroSector &&
    atHome &&
    view.resources.size > 0 &&
    assessment.combatCount >= 3 &&
    activeStickyScouts < stickyCap
  ) {
    const duration =
      workerCount <= 2 ? (spreadUrgent ? 16 : 12) : spreadUrgent ? 14 : 10;
    memory.workerDutyScoutUntil[unit.id] = Math.max(
      memory.workerDutyScoutUntil[unit.id] ?? 0,
      tick + duration,
    );
  }
  // Rotate zero-sector duty under defended peacetime harvest so one identity
  // cannot monopolize scouting while others freeze on wall-gap lanes.
  if (
    !assessment.threatened &&
    !assessment.retreatRequired &&
    footprint.count >= 10 &&
    hasZeroSector &&
    view.resources.size > 0 &&
    assessment.combatCount >= 4 &&
    workerIndex === Math.floor(tick / 6) % Math.max(1, workerCount) &&
    activeStickyScouts < stickyCap
  ) {
    memory.workerDutyScoutUntil[unit.id] = Math.max(
      memory.workerDutyScoutUntil[unit.id] ?? 0,
      tick + 10,
    );
  }
  // Keep scouting while any worker wedge is still empty; spread<4 alone is not
  // balanced when one sector remains at radius 0.
  if (
    assessment.threatened ||
    assessment.retreatRequired ||
    (!hasZeroSector && footprint.spread < 4)
  ) {
    delete memory.workerDutyScoutUntil[unit.id];
  }
  const stickyDutyScout =
    !assessment.threatened &&
    !assessment.retreatRequired &&
    footprint.count >= 10 &&
    tick < (memory.workerDutyScoutUntil[unit.id] ?? 0);

  if (visibleResourceTarget) {
    // Visible harvest always beats duty-scout peels. Sticky scouts were walking
    // UP/DOWN along the vision rim beside live crystals ("卡视野").
    delete memory.workerDutyScoutUntil[unit.id];
    memory.workerScoutTarget ??= {};
    delete memory.workerScoutTarget[unit.id];
    const resourceKey = key(visibleResourceTarget);
    reservedResources.add(resourceKey);
    assignedWorkerTargets.add(resourceKey);
    memory.workerHarvestGoal ??= {};
    memory.workerHarvestGoal[unit.id] = visibleResourceTarget;
    if (key(unit.position) === resourceKey) {
      delete memory.workerHarvestGoal[unit.id];
      if (memory.workerHarvestVisited)
        delete memory.workerHarvestVisited[unit.id];
      if (memory.workerHarvestPath) delete memory.workerHarvestPath[unit.id];
      return { type: "HARVEST" };
    }
    return moveTowardVisibleResource(
      tick,
      unit,
      visibleResourceTarget,
      view,
      memory,
      danger,
      reserved,
    );
  }
  if (memory.workerHarvestGoal?.[unit.id]) {
    delete memory.workerHarvestGoal[unit.id];
  }
  const resourceCandidates = Object.values(memory.resources)
    .filter((resource) => {
      const incumbent = view.units.find(
        (candidate) =>
          candidate.unit_type === "WORKER" &&
          (candidate.cargo ?? 0) === 0 &&
          key(candidate.position) === key(resource.position),
      );
      return (
        !view.resources.has(key(resource.position)) &&
        !reservedResources.has(key(resource.position)) &&
        !fogResourceClaims.has(key(resource.position)) &&
        !view.enemies.some(
          (enemy) => distance(enemy.position, resource.position) <= 1,
        ) &&
        !nearAssignedTarget(
          resource.position,
          assignedWorkerTargets,
          Math.max(2, config.workerTargetSpacing - 1),
        ) &&
        (!incumbent || incumbent.id === unit.id) &&
        (resource.depletedAtTick === undefined ||
          (tick - resource.depletedAtTick >= config.resourceReplenishTicks &&
            !visibleToFriendly(resource.position, view, view.obstacles))) &&
        (danger.get(key(resource.position)) ?? 0) <=
          config.workerEscapeDanger &&
        knownSafeStep(
          unit.position,
          resource.position,
          memory,
          danger,
          config.workerEscapeDanger,
        )
      );
    })
    .map((resource) => ({
      resource,
      supportExtension: resourceSupportExtension(
        resource.position,
        core,
        memory,
        danger,
        assessment,
        config,
        { memoryRecall: resource.depletedAtTick === undefined },
      ),
    }))
    .filter(
      (
        candidate,
      ): candidate is typeof candidate & {
        supportExtension: number;
      } => candidate.supportExtension !== undefined,
    );
  const normalResources = resourceCandidates.filter(
    (candidate) => candidate.supportExtension <= config.workerScoutExtension,
  );
  const rankedResources = (
    normalResources.length > 0 ? normalResources : resourceCandidates
  ).sort(
    (a, b) =>
      distance(unit.position, a.resource.position) -
        distance(unit.position, b.resource.position) ||
      b.resource.lastSeenTick - a.resource.lastSeenTick ||
      key(a.resource.position).localeCompare(key(b.resource.position)),
  );
  // Sticky home-commit sweeps cover visible harvest lock-in. Keep a lighter
  // periodic peel for fog-memory harvest routes that never touch the core cell.
  const dutyScoutTicks =
    workerCount <= 2 ? 3 : Math.max(1, Math.ceil(workerCount / 2));
  const dutyScoutPeriod = workerCount <= 2 ? 5 : Math.max(8, workerCount * 5);
  const closestResourceDistance = rankedResources[0]
    ? distance(unit.position, rankedResources[0].resource.position)
    : Number.POSITIVE_INFINITY;
  const periodicDutyScout =
    !stickyDutyScout &&
    !assessment.threatened &&
    !assessment.retreatRequired &&
    footprint.count >= 10 &&
    (hasZeroSector || footprint.spread >= (workerCount <= 2 ? 6 : 7)) &&
    rankedResources.length > 0 &&
    distance(unit.position, core.position) <= assessment.controlRadius &&
    closestResourceDistance > 4 &&
    workerIndex ===
      Math.floor(tick / dutyScoutPeriod) % Math.max(1, workerCount) &&
    tick % dutyScoutPeriod < dutyScoutTicks;
  const dutyScout =
    periodicDutyScout ||
    (!assessment.threatened &&
      !assessment.retreatRequired &&
      footprint.count >= 10 &&
      tick < (memory.workerDutyScoutUntil[unit.id] ?? 0));
  // Live fog memories are productive work. Do not drop them for duty-scout
  // peels or workers lock into the explored vision perimeter ("卡视野").
  const liveFogResources = rankedResources.filter(
    (candidate) => candidate.resource.depletedAtTick === undefined,
  );
  const resources =
    liveFogResources.length > 0
      ? liveFogResources
      : dutyScout
        ? []
        : rankedResources;
  const resourceScarce =
    view.resources.size === 0 || resources.length === 0 || dutyScout;
  memory.workerScoutTarget ??= {};
  memory.workerHarvestGoal ??= {};
  if (resources[0]) {
    const resourceTarget = resources[0].resource.position;
    const resourceKey = key(resourceTarget);
    reservedResources.add(resourceKey);
    if (!view.resources.has(resourceKey)) fogResourceClaims.add(resourceKey);
    assignedWorkerTargets.add(resourceKey);
    memory.workerHarvestGoal[unit.id] = resourceTarget;
    // Drop scout stickiness �� productive fog/visible harvest owns the unit.
    delete memory.workerScoutTarget[unit.id];
    if (key(unit.position) === resourceKey) {
      delete memory.workerHarvestGoal[unit.id];
      if (memory.workerHarvestVisited)
        delete memory.workerHarvestVisited[unit.id];
      if (memory.workerHarvestPath) delete memory.workerHarvestPath[unit.id];
      return { type: "HARVEST" };
    }
    // Same known-cell march used for visible crystals. Fog must not be a free
    // intermediate shortcut or workers re-enter vision-rim reverse thrash.
    return moveTowardVisibleResource(
      tick,
      unit,
      resourceTarget,
      view,
      memory,
      danger,
      reserved,
    );
  }

  // Pure exploration / duty-scout. Stick to one frontier cell so re-ranking
  // cannot flip the worker between two rim targets every tick.
  if (memory.workerHarvestGoal[unit.id]) {
    delete memory.workerHarvestGoal[unit.id];
  }
  if (memory.workerHarvestPath?.[unit.id]) {
    delete memory.workerHarvestPath[unit.id];
  }
  const sticky = memory.workerScoutTarget[unit.id];
  const scoutRadius =
    assessment.controlRadius +
    (dutyScout || resourceScarce
      ? config.workerScoutExtension + 2
      : config.workerScoutExtension);
  const stickyValid =
    sticky &&
    tick - sticky.tick <= 12 &&
    !memory.obstacles[key(sticky.position)] &&
    (danger.get(key(sticky.position)) ?? 0) <= config.workerEscapeDanger &&
    distance(core.position, sticky.position) <= scoutRadius &&
    key(sticky.position) !== key(unit.position);
  const target = stickyValid
    ? sticky.position
    : workerExplorationTarget(
        tick,
        workerIndex,
        workerCount,
        unit.position,
        core,
        assessment.controlRadius,
        memory,
        danger,
        assignedWorkerTargets,
        resourceScarce,
        config,
        dutyScout,
      );
  memory.workerScoutTarget[unit.id] = {
    position: target,
    tick: stickyValid && sticky ? sticky.tick : tick,
  };
  assignedWorkerTargets.add(key(target));
  return moveTowardWorkerFrontier(
    unit,
    target,
    view,
    memory,
    danger,
    reserved,
    config.workerEscapeDanger,
    tick,
  );
}

function chokepointGuardCell(
  unit: UnitObject,
  chokepoint: Position,
  core: CoreObject,
  view: Snapshot,
  memory: StrategyMemory,
  assessment: Assessment,
  danger: ReadonlyMap<string, number>,
  reserved: ReadonlySet<string>,
  config: StrategyConfig,
): Position | undefined {
  if (assessment.threatened || (danger.get(key(chokepoint)) ?? 0) > 0.5)
    return undefined;
  if (
    nearestSupportDistance(chokepoint, assessment.supportPositions) >
    assessment.supportResponseTicks
  ) {
    return undefined;
  }
  const vision = visibilityRadius(unit);
  const capacityBlocked = blockedCells(view, unit.id);
  return cellsWithin(chokepoint, Math.min(vision, config.softControlMaxOffset))
    .filter(
      (position) =>
        key(position) !== key(chokepoint) &&
        Boolean(memory.explored[key(position)]) &&
        !capacityBlocked.has(key(position)) &&
        !reserved.has(key(position)) &&
        distance(core.position, position) <=
          distance(core.position, chokepoint) &&
        nearestSupportDistance(position, assessment.supportPositions) <=
          assessment.supportResponseTicks &&
        (danger.get(key(position)) ?? 0) <= 0.5 &&
        hasVision(position, chokepoint, vision, view.obstacles) &&
        (key(position) === key(unit.position) ||
          (() => {
            const blocked = blockedCells(view, unit.id);
            for (const cell of reserved) blocked.add(cell);
            return (
              findStep(unit.position, position, blocked, danger, 256) !==
              undefined
            );
          })()),
    )
    .map((position) => ({
      position,
      score:
        distance(position, chokepoint) * 2 +
        distance(position, assessment.supportAnchor) +
        (unit.unit_type === "RANGER" ? -distance(position, chokepoint) : 0) +
        (danger.get(key(position)) ?? 0) * 8,
    }))
    .sort(
      (a, b) =>
        a.score - b.score || key(a.position).localeCompare(key(b.position)),
    )[0]?.position;
}

function chokepointDecision(
  tick: number,
  unit: UnitObject,
  core: CoreObject,
  view: Snapshot,
  memory: StrategyMemory,
  assessment: Assessment,
  danger: Map<string, number>,
  reserved: Set<string>,
  holdAssignments: Set<string>,
  config: StrategyConfig,
  maxCoreDistance = Number.POSITIVE_INFINITY,
  minCoreDistance = 0,
): { action: UnitAction; role: RoleMemory } | undefined {
  const priorRole = memory.roles[unit.id];
  const candidates = assessment.chokepoints
    .filter(
      (position) =>
        !holdAssignments.has(key(position)) &&
        distance(core.position, position) >= minCoreDistance &&
        distance(core.position, position) <= maxCoreDistance &&
        (assessment.combatCount === 1 ||
          nearestSupportDistance(position, assessment.supportPositions) <=
            assessment.supportResponseTicks) &&
        (danger.get(key(position)) ?? 0) <= unitPower(unit),
    )
    .sort(
      (a, b) =>
        (assessment.posture === "CONTEST"
          ? distance(unit.position, a) - distance(unit.position, b)
          : distance(a, assessment.supportAnchor) -
            distance(b, assessment.supportAnchor)) ||
        distance(core.position, b) - distance(core.position, a) ||
        key(a).localeCompare(key(b)),
    );
  const retained =
    priorRole?.kind === "HOLD_POINT" ||
    priorRole?.kind === "WATCH_POINT" ||
    priorRole?.kind === "CONTROL_RALLY"
      ? candidates.find((position) => key(position) === key(priorRole.anchor))
      : undefined;
  const chokepoint = retained ?? candidates[0];
  if (!chokepoint) return undefined;

  holdAssignments.add(key(chokepoint));
  memory.patrolVisits[key(chokepoint)] = tick;
  let formationCell =
    chokepointGuardCell(
      unit,
      chokepoint,
      core,
      view,
      memory,
      assessment,
      danger,
      reserved,
      config,
    ) ?? chokepoint;
  if (unit.unit_type === "RANGER" && key(formationCell) === key(chokepoint)) {
    const coreward = directionBetween(chokepoint, core.position);
    const supportCell = coreward
      ? nextPosition(chokepoint, coreward)
      : chokepoint;
    if (
      memory.explored[key(supportCell)] &&
      !view.obstacles.has(key(supportCell)) &&
      key(supportCell) !== key(core.position)
    ) {
      formationCell = supportCell;
    }
  }
  const proposed: UnitAction =
    key(unit.position) === key(formationCell)
      ? { type: "WAIT" }
      : moveToward(unit, formationCell, view, danger, reserved);
  const action = supportGatedControlAction(
    unit,
    proposed,
    view,
    assessment,
    danger,
    reserved,
  );
  const plannedPosition = actionPosition(unit, action);
  return {
    action,
    role: {
      kind:
        nearestSupportDistance(plannedPosition, assessment.supportPositions) >
          assessment.supportResponseTicks ||
        !hasVision(
          plannedPosition,
          chokepoint,
          visibilityRadius(unit),
          view.obstacles,
        )
          ? "CONTROL_RALLY"
          : key(formationCell) === key(chokepoint)
            ? "HOLD_POINT"
            : "WATCH_POINT",
      anchor: chokepoint,
      sinceTick: retained && priorRole ? priorRole.sinceTick : tick,
    },
  };
}

function observationDecision(
  tick: number,
  unit: UnitObject,
  view: Snapshot,
  memory: StrategyMemory,
  assessment: Assessment,
  danger: Map<string, number>,
  reserved: Set<string>,
  assignments: Set<string>,
): { action: UnitAction; role: RoleMemory } | undefined {
  if (
    assessment.posture === "ATTACK" ||
    assessment.posture === "REGROUP" ||
    assessment.retreatRequired
  ) {
    return undefined;
  }
  const priorRole = memory.roles[unit.id];
  const candidates = assessment.observationPosts.filter(
    (position) => !assignments.has(key(position)),
  );
  const retained =
    priorRole?.kind === "OBSERVE" || priorRole?.kind === "CONTROL_RALLY"
      ? candidates.find((position) => key(position) === key(priorRole.anchor))
      : undefined;
  const post =
    retained ??
    (assessment.posture === "CONTEST"
      ? [...candidates].sort(
          (a, b) =>
            distance(unit.position, a) - distance(unit.position, b) ||
            key(a).localeCompare(key(b)),
        )[0]
      : candidates[0]);
  if (!post) return undefined;
  assignments.add(key(post));
  memory.patrolVisits[key(post)] = tick;
  const proposed: UnitAction =
    key(unit.position) === key(post)
      ? { type: "WAIT" }
      : moveToward(unit, post, view, danger, reserved);
  const action = supportGatedControlAction(
    unit,
    proposed,
    view,
    assessment,
    danger,
    reserved,
  );
  const plannedPosition = actionPosition(unit, action);
  return {
    action,
    role: {
      kind:
        nearestSupportDistance(plannedPosition, assessment.supportPositions) <=
          assessment.supportResponseTicks &&
        hasVision(plannedPosition, post, visibilityRadius(unit), view.obstacles)
          ? "OBSERVE"
          : "CONTROL_RALLY",
      anchor: post,
      sinceTick: retained && priorRole ? priorRole.sinceTick : tick,
    },
  };
}

function positionalControlDecision(
  tick: number,
  unit: UnitObject,
  core: CoreObject,
  view: Snapshot,
  memory: StrategyMemory,
  assessment: Assessment,
  danger: Map<string, number>,
  reserved: Set<string>,
  holdAssignments: Set<string>,
  config: StrategyConfig,
): { action: UnitAction; role: RoleMemory } {
  const hold = chokepointDecision(
    tick,
    unit,
    core,
    view,
    memory,
    assessment,
    danger,
    reserved,
    holdAssignments,
    config,
    Number.POSITIVE_INFINITY,
    assessment.threatened ? 0 : 2,
  );
  if (hold) return hold;

  const observation = observationDecision(
    tick,
    unit,
    view,
    memory,
    assessment,
    danger,
    reserved,
    holdAssignments,
  );
  if (observation) return observation;

  const patrolRadius = Math.max(
    config.minControlRadius,
    assessment.controlRadius - 2,
  );
  const patrolAnchor = patrolTarget(
    unit,
    core,
    patrolRadius,
    memory,
    danger,
    holdAssignments,
    assessment.supportPositions,
    assessment.supportResponseTicks,
  );
  holdAssignments.add(key(patrolAnchor));
  memory.patrolVisits[key(patrolAnchor)] = tick;
  const action = supportGatedControlAction(
    unit,
    moveToward(unit, patrolAnchor, view, danger, reserved),
    view,
    assessment,
    danger,
    reserved,
  );
  const plannedPosition = actionPosition(unit, action);
  return {
    action,
    role: {
      kind:
        nearestSupportDistance(plannedPosition, assessment.supportPositions) <=
          assessment.supportResponseTicks &&
        hasVision(
          plannedPosition,
          patrolAnchor,
          visibilityRadius(unit),
          view.obstacles,
        )
          ? "PATROL"
          : "CONTROL_RALLY",
      anchor: patrolAnchor,
      sinceTick:
        memory.roles[unit.id]?.kind === "PATROL"
          ? (memory.roles[unit.id]?.sinceTick ?? tick)
          : tick,
    },
  };
}

function combatAction(
  tick: number,
  unit: UnitObject,
  view: Snapshot,
  beacon: ChampionBeacon,
  memory: StrategyMemory,
  assessment: Assessment,
  danger: Map<string, number>,
  reserved: Set<string>,
  holdAssignments: Set<string>,
  allocatedDamage: Map<string, number>,
  claimedIntercepts: Set<string>,
  formationOrders: ReadonlyMap<string, CombatFormationOrder>,
  config: StrategyConfig,
): { action: UnitAction; role: RoleMemory } {
  const core = view.core;
  if (!core)
    return {
      action: { type: "WAIT" },
      role: { kind: "WITHDRAW", anchor: unit.position, sinceTick: tick },
    };

  const coreBreach = [...view.enemies]
    .filter(
      (enemy) =>
        !isEnemyWorker(enemy) &&
        distance(core.position, enemy.position) <= 3 &&
        (allocatedDamage.get(enemy.id) ?? 0) < enemy.hp,
    )
    .sort((a, b) => {
      const adjacentRank = (enemy: CoreObject | UnitObject): number =>
        distance(unit.position, enemy.position) === 1 ? 0 : 1;
      const coreDamageRank = (enemy: CoreObject | UnitObject): number =>
        canDamageCoreNow(enemy, core, view.obstacles) ? 0 : 1;
      const localCover = (enemy: CoreObject | UnitObject): number =>
        view.units.reduce((count, friendly) => {
          if (friendly.unit_type === "WORKER") return count;
          if (friendly.id === unit.id) return count;
          return distance(friendly.position, enemy.position) <= 1
            ? count + 1
            : count;
        }, 0);
      const claimedRank = (enemy: CoreObject | UnitObject): number =>
        distance(unit.position, enemy.position) === 1
          ? 0
          : claimedIntercepts.has(enemy.id)
            ? 1
            : 0;
      const directRanger = (enemy: CoreObject | UnitObject): number =>
        enemy.kind === "UNIT" &&
        enemy.unit_type === "RANGER" &&
        canDamageCoreNow(enemy, core, view.obstacles)
          ? 0
          : 1;
      return (
        adjacentRank(a) - adjacentRank(b) ||
        coreDamageRank(a) - coreDamageRank(b) ||
        localCover(a) - localCover(b) ||
        claimedRank(a) - claimedRank(b) ||
        directRanger(a) - directRanger(b) ||
        distance(unit.position, a.position) -
          distance(unit.position, b.position) ||
        distance(core.position, a.position) -
          distance(core.position, b.position) ||
        key(a.position).localeCompare(key(b.position))
      );
    })[0];
  if (coreBreach) {
    const cutoff = movingMeleeCutoff(
      unit,
      core,
      view,
      memory,
      danger,
      reserved,
      allocatedDamage,
    );
    const disengage = cutoff
      ? undefined
      : rangerDisengagement(unit, core, view, danger, reserved);
    const counterattackDamage = new Map(allocatedDamage);
    const counterattack =
      cutoff || disengage
        ? undefined
        : visibleAttack(unit, view, counterattackDamage, memory, assessment);
    const finishesCoreThreat = attackFinishesCoreThreat(
      counterattack,
      core,
      view,
      allocatedDamage,
      counterattackDamage,
    );
    // Near-Core only: trading a non-lethal chip into a live Core hitter beats
    // pure evasion. Field kiting (PURSUIT) must still be allowed to withdraw.
    const hitsCoreThreat = attackHitsCoreThreat(
      counterattack,
      core,
      view,
      allocatedDamage,
      counterattackDamage,
    );
    const holdTheLine =
      finishesCoreThreat ||
      (hitsCoreThreat && distance(unit.position, core.position) <= 2);
    const lethalEvasion =
      cutoff || disengage
        ? undefined
        : lethalCombatEvasion(unit, core, view, danger, reserved);
    const breachAxis = axisVector(core.position, coreBreach.position);
    const blockingCell = offsetPosition(core.position, breachAxis, 1, 0);
    const otherVanguardBlocks = view.units.some(
      (candidate) =>
        candidate.id !== unit.id &&
        candidate.unit_type === "VANGUARD" &&
        key(candidate.position) === key(blockingCell),
    );
    const flank =
      !cutoff &&
      !disengage &&
      !counterattack &&
      !lethalEvasion &&
      unit.unit_type === "VANGUARD" &&
      otherVanguardBlocks
        ? [-1, 1]
            .map((side) =>
              offsetPosition(coreBreach.position, breachAxis, 0, side),
            )
            .filter(
              (position) =>
                !view.obstacles.has(key(position)) &&
                !view.enemies.some(
                  (enemy) => key(enemy.position) === key(position),
                ),
            )
            .sort(
              (a, b) =>
                distance(unit.position, a) - distance(unit.position, b) ||
                key(a).localeCompare(key(b)),
            )[0]
        : undefined;
    const axisReturn =
      cutoff || disengage || counterattack || lethalEvasion
        ? undefined
        : returnAlongThreatAxis(unit, coreBreach, core, view, memory, reserved);
    // Live freefire only: one-step onto the corridor before pathing detours.
    const corridorAlign =
      cutoff || disengage || counterattack || lethalEvasion || axisReturn
        ? undefined
        : view.enemies.some((enemy) =>
              canDamageCoreNow(enemy, core, view.obstacles),
            )
          ? rangerCorridorAlignStep(unit, coreBreach, core, view, reserved)
          : undefined;
    if (counterattack && (!lethalEvasion || holdTheLine)) {
      allocatedDamage.clear();
      for (const [id, damage] of counterattackDamage)
        allocatedDamage.set(id, damage);
    }
    const withdrawing =
      Boolean(disengage) || Boolean(lethalEvasion && !holdTheLine);
    const rangedAnchor =
      cutoff ||
      disengage ||
      holdTheLine ||
      lethalEvasion ||
      counterattack ||
      axisReturn ||
      corridorAlign ||
      flank
        ? undefined
        : rangedBreachAnchor(unit, coreBreach, core, view, reserved);
    const action =
      cutoff ??
      disengage ??
      (holdTheLine ? counterattack : undefined) ??
      lethalEvasion ??
      counterattack ??
      axisReturn ??
      corridorAlign ??
      (flank
        ? moveToward(unit, flank, view, new Map(), reserved)
        : undefined) ??
      moveToward(
        unit,
        rangedAnchor ?? coreBreach.position,
        view,
        new Map(),
        reserved,
      );
    if (!withdrawing) {
      claimedIntercepts.add(coreBreach.id);
      if (action.type === "SHOOT" && action.target_id) {
        claimedIntercepts.add(action.target_id);
      }
    }

    return {
      action,
      role: {
        kind: withdrawing ? "WITHDRAW" : "CORE_DEFENSE",
        anchor: core.position,
        sinceTick: tick,
      },
    };
  }

  if (assessment.retreatRequired) {
    const supportDistance = distance(core.position, assessment.supportAnchor);
    const outsideSupportLine =
      distance(core.position, unit.position) > supportDistance + 1;
    const supportUnsafe =
      (danger.get(key(assessment.supportAnchor)) ?? 0) > unitPower(unit);
    let retreatAnchor =
      outsideSupportLine && !supportUnsafe
        ? assessment.supportAnchor
        : core.position;
    const threat = nearest(unit.position, view.enemies);
    if (threat && key(retreatAnchor) !== key(core.position)) {
      const axis = axisVector(retreatAnchor, threat.position);
      const layeredAnchor =
        unit.unit_type === "VANGUARD"
          ? offsetPosition(retreatAnchor, axis, 1, 0)
          : offsetPosition(
              retreatAnchor,
              axis,
              -1,
              stableUnitHash(unit.id) % 2 === 0 ? -1 : 1,
            );
      if (
        memory.explored[key(layeredAnchor)] &&
        !view.obstacles.has(key(layeredAnchor)) &&
        (danger.get(key(layeredAnchor)) ?? 0) <= unitPower(unit)
      ) {
        retreatAnchor = layeredAnchor;
      }
    }
    // Core is a friendly occupant; combat WITHDRAW stages on the perimeter only.
    if (key(retreatAnchor) === key(core.position)) {
      return {
        action: moveTowardCore(unit, core, view, memory, danger, reserved, {
          allowCoreCell: false,
          desiredDistance: 1,
        }),
        role: {
          kind: "WITHDRAW",
          anchor: approachCorePerimeter(
            unit,
            core,
            view,
            memory,
            danger,
            reserved,
            1,
          ),
          sinceTick:
            memory.roles[unit.id]?.kind === "WITHDRAW"
              ? (memory.roles[unit.id]?.sinceTick ?? tick)
              : tick,
        },
      };
    }
    return {
      action: moveToward(unit, retreatAnchor, view, danger, reserved),
      role: {
        kind: "WITHDRAW",
        anchor: retreatAnchor,
        sinceTick:
          memory.roles[unit.id]?.kind === "WITHDRAW"
            ? (memory.roles[unit.id]?.sinceTick ?? tick)
            : tick,
      },
    };
  }

  const disengage = rangerDisengagement(unit, core, view, danger, reserved);
  if (disengage) {
    return {
      action: disengage,
      role: { kind: "WITHDRAW", anchor: core.position, sinceTick: tick },
    };
  }

  const lethalEvasion = lethalCombatEvasion(unit, core, view, danger, reserved);
  if (lethalEvasion) {
    return {
      action: lethalEvasion,
      role: { kind: "WITHDRAW", anchor: core.position, sinceTick: tick },
    };
  }

  const immediateAttack = visibleAttack(
    unit,
    view,
    allocatedDamage,
    memory,
    assessment,
  );
  if (immediateAttack)
    return {
      action: immediateAttack,
      role: { kind: "ENGAGE", anchor: unit.position, sinceTick: tick },
    };

  if (assessment.posture === "REGROUP") {
    const isReserve = assessment.reserveIds.has(unit.id);
    let regroupAnchor = isReserve
      ? (assessment.reserveAnchors[unit.id] ?? assessment.supportAnchor)
      : assessment.supportAnchor;
    if (key(regroupAnchor) === key(core.position)) {
      regroupAnchor = approachCorePerimeter(
        unit,
        core,
        view,
        memory,
        danger,
        reserved,
        1,
      );
    }
    if (key(unit.position) === key(core.position)) {
      return {
        action: moveTowardCore(unit, core, view, memory, danger, reserved, {
          allowCoreCell: false,
          desiredDistance: 1,
        }),
        role: {
          kind: isReserve ? "RESERVE" : "WITHDRAW",
          anchor: regroupAnchor,
          sinceTick:
            memory.roles[unit.id]?.kind === (isReserve ? "RESERVE" : "WITHDRAW")
              ? (memory.roles[unit.id]?.sinceTick ?? tick)
              : tick,
        },
      };
    }
    return {
      action:
        key(unit.position) === key(regroupAnchor)
          ? { type: "WAIT" }
          : moveToward(unit, regroupAnchor, view, danger, reserved),
      role: {
        kind: isReserve ? "RESERVE" : "WITHDRAW",
        anchor: regroupAnchor,
        sinceTick:
          memory.roles[unit.id]?.kind === (isReserve ? "RESERVE" : "WITHDRAW")
            ? (memory.roles[unit.id]?.sinceTick ?? tick)
            : tick,
      },
    };
  }

  const formationOrder = formationOrders.get(unit.id);
  if (formationOrder) {
    return {
      action:
        key(unit.position) === key(formationOrder.formationCell)
          ? { type: "WAIT" }
          : moveToward(
              unit,
              formationOrder.formationCell,
              view,
              formationOrder.phase === "ADVANCE" &&
                unit.unit_type === "VANGUARD"
                ? new Map<string, number>()
                : danger,
              reserved,
            ),
      role: {
        kind: formationOrder.phase,
        anchor: formationOrder.objective,
        sinceTick:
          memory.roles[unit.id]?.kind === formationOrder.phase &&
          key(memory.roles[unit.id]?.anchor ?? unit.position) ===
            key(formationOrder.objective)
            ? (memory.roles[unit.id]?.sinceTick ?? tick)
            : tick,
      },
    };
  }

  const coreThreat = selectCoreDefenseThreat(core, view);
  if (assessment.threatened && coreThreat) {
    const interceptCell = DIRECTIONS.map(
      ([, delta]) =>
        [
          coreThreat.position[0] + delta[0],
          coreThreat.position[1] + delta[1],
        ] as Position,
    )
      .filter(
        (candidate) =>
          distance(candidate, core.position) <
            distance(coreThreat.position, core.position) &&
          !view.obstacles.has(key(candidate)) &&
          !view.enemies.some((enemy) => key(enemy.position) === key(candidate)),
      )
      .sort(
        (a, b) =>
          distance(unit.position, a) - distance(unit.position, b) ||
          distance(a, core.position) - distance(b, core.position) ||
          key(a).localeCompare(key(b)),
      )[0];
    const axisRangerThreat =
      coreThreat.kind === "UNIT" &&
      coreThreat.unit_type === "RANGER" &&
      isOnCoreAxis(core.position, coreThreat.position);
    let defenseTarget = interceptCell ?? coreThreat.position;
    if (axisRangerThreat) {
      const towardCore = directionBetween(coreThreat.position, core.position);
      if (towardCore) {
        const axisStep = nextPosition(coreThreat.position, towardCore);
        if (
          key(axisStep) !== key(core.position) &&
          !view.obstacles.has(key(axisStep)) &&
          !view.enemies.some((enemy) => key(enemy.position) === key(axisStep))
        ) {
          defenseTarget = axisStep;
        }
      }
    }
    return {
      action:
        returnAlongThreatAxis(unit, coreThreat, core, view, memory, reserved) ??
        moveToward(
          unit,
          defenseTarget,
          view,
          unit.unit_type === "VANGUARD" || axisRangerThreat
            ? new Map<string, number>()
            : danger,
          reserved,
        ),
      role: { kind: "CORE_DEFENSE", anchor: core.position, sinceTick: tick },
    };
  }

  const protectedCarrier = view.units.find(
    (candidate) =>
      candidate.id === beacon.carrier_id ||
      (candidate.unit_type === "WORKER" &&
        (candidate.cargo ?? 0) > 0 &&
        (danger.get(key(candidate.position)) ?? 0) > 0),
  );
  if (assessment.responseIds.has(unit.id) && assessment.responseThreat) {
    const protectsCarrier = Boolean(
      protectedCarrier &&
        protectedCarrier.id !== unit.id &&
        distance(
          assessment.responseThreat.position,
          protectedCarrier.position,
        ) <= 3,
    );
    const movingWorkerDenial =
      isEnemyWorker(assessment.responseThreat) &&
      Boolean(memory.enemies[assessment.responseThreat.id]?.lastMove) &&
      distance(unit.position, assessment.responseThreat.position) <= 2 &&
      nearestSupportDistance(unit.position, assessment.supportPositions) <=
        assessment.supportResponseTicks;
    if (movingWorkerDenial) {
      return {
        action: { type: "WAIT" },
        role: {
          kind: "HOLD_POINT",
          anchor: assessment.responseThreat.position,
          sinceTick:
            memory.roles[unit.id]?.kind === "HOLD_POINT"
              ? (memory.roles[unit.id]?.sinceTick ?? tick)
              : tick,
        },
      };
    }
    return {
      action:
        returnAlongThreatAxis(
          unit,
          assessment.responseThreat,
          core,
          view,
          memory,
          reserved,
        ) ??
        moveToward(
          unit,
          assessment.responseThreat.position,
          view,
          unit.unit_type === "VANGUARD" ? new Map<string, number>() : danger,
          reserved,
        ),
      role: {
        kind: protectsCarrier ? "ESCORT" : "CORE_DEFENSE",
        anchor:
          protectsCarrier && protectedCarrier
            ? protectedCarrier.position
            : assessment.responseThreat.position,
        sinceTick: tick,
      },
    };
  }

  // Residual multiwave pressure with no live contact: hold a tight Core perimeter
  // instead of escort/control marches that strand the army before the next wave
  // (STAGGERED_RANGED_WAVES seed 8). Stay adjacent/near Core for reaction speed,
  // but never occupy the Core cell — that single free stack slot is for DEPOSIT.
  const betweenWaveHold =
    memory.militaryPressureTicks > 0 &&
    !view.enemies.some((enemy) => !isEnemyWorker(enemy));
  if (betweenWaveHold && !assessment.reserveIds.has(unit.id)) {
    const ring = Math.max(1, unit.unit_type === "RANGER" ? 2 : 1);
    const onCoreCell = key(unit.position) === key(core.position);
    const ringAnchor = approachCorePerimeter(
      unit,
      core,
      view,
      memory,
      danger,
      reserved,
      ring,
    );
    if (onCoreCell || distance(unit.position, core.position) > ring) {
      return {
        action: moveTowardCore(unit, core, view, memory, danger, reserved, {
          allowCoreCell: false,
          desiredDistance: ring,
        }),
        role: { kind: "RESERVE", anchor: ringAnchor, sinceTick: tick },
      };
    }
    return {
      action: { type: "WAIT" },
      role: { kind: "RESERVE", anchor: ringAnchor, sinceTick: tick },
    };
  }

  if (assessment.reserveIds.has(unit.id)) {
    if (assessment.combatCount === 1) {
      const hold = chokepointDecision(
        tick,
        unit,
        core,
        view,
        memory,
        assessment,
        danger,
        reserved,
        holdAssignments,
        config,
        Math.max(
          config.reserveResponseRadius,
          distance(core.position, assessment.supportAnchor) + 1,
        ),
        2,
      );
      if (hold) return hold;
    }
    let reserveAnchor =
      assessment.reserveAnchors[unit.id] ?? assessment.supportAnchor;
    // Defensive: if anchor selection collapsed to the Core cell, push to the
    // perimeter so RESERVE never parks on the DEPOSIT slot.
    if (key(reserveAnchor) === key(core.position)) {
      reserveAnchor = approachCorePerimeter(
        unit,
        core,
        view,
        memory,
        danger,
        reserved,
        unit.unit_type === "RANGER" ? 2 : 1,
      );
    }
    holdAssignments.add(key(reserveAnchor));
    memory.patrolVisits[key(reserveAnchor)] = tick;
    const onCoreCell = key(unit.position) === key(core.position);
    return {
      action:
        onCoreCell ||
        distance(unit.position, reserveAnchor) >
          (unit.unit_type === "RANGER" ? 1 : 0)
          ? key(reserveAnchor) === key(core.position) || onCoreCell
            ? moveTowardCore(unit, core, view, memory, danger, reserved, {
                allowCoreCell: false,
                desiredDistance: unit.unit_type === "RANGER" ? 2 : 1,
              })
            : moveToward(unit, reserveAnchor, view, danger, reserved)
          : { type: "WAIT" },
      role: {
        kind: "RESERVE",
        anchor: reserveAnchor,
        sinceTick: memory.roles[unit.id]?.sinceTick ?? tick,
      },
    };
  }

  if (assessment.controlIds.has(unit.id)) {
    return positionalControlDecision(
      tick,
      unit,
      core,
      view,
      memory,
      assessment,
      danger,
      reserved,
      holdAssignments,
      config,
    );
  }

  const workerResponseCovered = Boolean(
    assessment.responseThreat &&
      isEnemyWorker(assessment.responseThreat) &&
      assessment.responseIds.size > 0,
  );
  const harassment = workerResponseCovered
    ? undefined
    : harassmentDecision(
        tick,
        unit,
        core,
        view,
        memory,
        assessment,
        danger,
        reserved,
      );
  if (harassment) return harassment;

  if (protectedCarrier && protectedCarrier.id !== unit.id) {
    const escortDistance = distance(unit.position, protectedCarrier.position);
    if (escortDistance > 1) {
      return {
        action: moveToward(
          unit,
          protectedCarrier.position,
          view,
          danger,
          reserved,
        ),
        role: {
          kind: "ESCORT",
          anchor: protectedCarrier.position,
          sinceTick:
            memory.roles[unit.id]?.kind === "ESCORT"
              ? (memory.roles[unit.id]?.sinceTick ?? tick)
              : tick,
        },
      };
    }
  }

  const enemyCore = view.enemies.find((enemy) => enemy.kind === "CORE");
  const rememberedEnemyCore = Object.values(memory.enemies)
    .filter(
      (enemy) =>
        enemy.kind === "CORE" &&
        tick - enemy.lastSeenTick <= config.enemyLocalizedTicks * 4,
    )
    .sort((a, b) => b.lastSeenTick - a.lastSeenTick)[0];
  if (
    (assessment.posture === "ATTACK" || assessment.posture === "CONTEST") &&
    (enemyCore || rememberedEnemyCore !== undefined)
  ) {
    const objective = enemyCore?.position ?? rememberedEnemyCore?.position;
    if (!objective) {
      return positionalControlDecision(
        tick,
        unit,
        core,
        view,
        memory,
        assessment,
        danger,
        reserved,
        holdAssignments,
        config,
      );
    }
    const offset: Position =
      unit.unit_type === "RANGER"
        ? [
            objective[0],
            objective[1] + (stableUnitHash(unit.id) % 2 === 0 ? 2 : -2),
          ]
        : objective;
    // Committed offense ignores soft danger so the field army closes instead of
    // orbiting the objective under residual threat heat.
    const advanceDanger =
      assessment.posture === "ATTACK" || unit.unit_type === "VANGUARD"
        ? new Map<string, number>()
        : danger;
    return {
      action: moveToward(unit, offset, view, advanceDanger, reserved),
      role: {
        kind: "ADVANCE",
        anchor: objective,
        sinceTick: memory.roles[unit.id]?.sinceTick ?? tick,
      },
    };
  }

  if (
    assessment.posture === "CONTEST" &&
    view.core &&
    distance(view.core.position, beacon.position) <= 12
  ) {
    if (key(unit.position) === key(beacon.position)) {
      return {
        action: { type: "PICKUP_BEACON" },
        role: { kind: "ENGAGE", anchor: beacon.position, sinceTick: tick },
      };
    }
    return {
      action: moveToward(unit, beacon.position, view, danger, reserved),
      role: {
        kind: "ADVANCE",
        anchor: beacon.position,
        sinceTick: memory.roles[unit.id]?.sinceTick ?? tick,
      },
    };
  }

  return positionalControlDecision(
    tick,
    unit,
    core,
    view,
    memory,
    assessment,
    danger,
    reserved,
    holdAssignments,
    config,
  );
}

function upkeepSelfDestructs(state: PlayerState, view: Snapshot): Set<string> {
  if (state.resources >= state.upkeep_next_tick || state.population < 20)
    return new Set();
  let targetPopulation = state.population - 1;
  while (
    targetPopulation > 0 &&
    upkeepForPopulation(targetPopulation) > state.resources
  ) {
    targetPopulation -= 1;
  }
  const count = state.population - targetPopulation;
  const candidates = [...view.units]
    .filter(
      (unit) =>
        unit.id !== state.champion_beacon.carrier_id && (unit.cargo ?? 0) === 0,
    )
    .sort((a, b) => {
      const value = (unit: UnitObject): number =>
        unit.unit_type === "WORKER" ? 1 : unit.unit_type === "RANGER" ? 2 : 3;
      return value(a) - value(b) || a.id.localeCompare(b.id);
    });
  return new Set(candidates.slice(0, count).map((unit) => unit.id));
}

function upkeepForPopulation(population: number): number {
  const tier = Math.floor(population / 20);
  return (tier * (tier + 1)) / 2;
}

function coreCellAvailable(
  view: Snapshot,
  actions: Readonly<Record<string, UnitAction>>,
): boolean {
  return Boolean(
    view.core &&
      !view.units.some(
        (unit) =>
          key(unit.position) === key(view.core?.position ?? unit.position) &&
          actions[unit.id]?.type !== "MOVE",
      ),
  );
}

function canAffordSpawn(
  type: UnitType,
  state: PlayerState,
  discretionary: number,
  emergency: boolean,
): boolean {
  const projectedUpkeep = upkeepForPopulation(state.population + 1);
  const upkeepIncrease = Math.max(0, projectedUpkeep - state.upkeep_next_tick);
  const upkeepBuffer = (emergency ? 3 : 2) * upkeepIncrease;
  return discretionary >= SPAWN_COSTS[type] + upkeepBuffer;
}

function chooseCombatSpawn(
  state: PlayerState,
  view: Snapshot,
  memory: StrategyMemory,
  readiness: MilitaryReadiness,
  discretionary: number,
  emergency: boolean,
): UnitType | undefined {
  const vanguards = view.units.filter(
    (unit) => unit.unit_type === "VANGUARD",
  ).length;
  const rangers = view.units.filter(
    (unit) => unit.unit_type === "RANGER",
  ).length;
  const observedTypes = [
    ...view.enemies.flatMap((enemy) =>
      enemy.kind === "UNIT" ? [enemy.unit_type] : [],
    ),
    ...Object.values(memory.enemies).flatMap((enemy) =>
      enemy.kind === "UNIT" && enemy.unitType ? [enemy.unitType] : [],
    ),
  ];
  const enemyVanguards = observedTypes.filter(
    (type) => type === "VANGUARD",
  ).length;
  const enemyRangers = observedTypes.filter((type) => type === "RANGER").length;
  const vanguardGap = Math.max(0, readiness.desiredVanguards - vanguards);
  const rangerGap = Math.max(0, readiness.desiredRangers - rangers);
  const pureCountTopUp =
    readiness.combatCountDeficit > 0 && vanguardGap === 0 && rangerGap === 0;
  const vanguardScore =
    vanguardGap * 6 +
    enemyVanguards * 2 +
    (enemyRangers > 0 && vanguards < 2 ? 3 : 0) +
    (pureCountTopUp ? 5 : 0) +
    Number(vanguards < rangers || (vanguards === rangers && rangerGap === 0));
  const rangerScore =
    rangerGap * 6 +
    enemyRangers * 2 +
    (enemyVanguards > 0 && vanguards >= readiness.desiredVanguards ? 2 : 0) +
    (rangerGap > 0 && rangers < vanguards ? 1 : 0);
  const ranked: UnitType[] =
    rangerScore > vanguardScore
      ? ["RANGER", "VANGUARD"]
      : ["VANGUARD", "RANGER"];
  return ranked.find((type) =>
    canAffordSpawn(type, state, discretionary, emergency),
  );
}

function chooseSpawn(
  state: PlayerState,
  view: Snapshot,
  assessment: Assessment,
  readiness: MilitaryReadiness,
  memory: StrategyMemory,
  discretionary: number,
  actions: Readonly<Record<string, UnitAction>>,
  config: StrategyConfig,
): UnitType | undefined {
  if (!coreCellAvailable(view, actions)) return undefined;
  const emergency = assessment.threatened || assessment.retreatRequired;
  const counts: Record<UnitType, number> = {
    WORKER: 0,
    VANGUARD: 0,
    RANGER: 0,
  };
  for (const unit of view.units) counts[unit.unit_type] += 1;
  if (emergency && counts.VANGUARD + counts.RANGER < 2) {
    return chooseCombatSpawn(
      state,
      view,
      memory,
      readiness,
      discretionary,
      true,
    );
  }
  if (
    counts.WORKER < 3 &&
    canAffordSpawn("WORKER", state, discretionary, emergency)
  )
    return "WORKER";
  if (
    counts.VANGUARD < 1 &&
    canAffordSpawn("VANGUARD", state, discretionary, emergency)
  )
    return "VANGUARD";
  if (
    counts.RANGER < 1 &&
    canAffordSpawn("RANGER", state, discretionary, emergency)
  )
    return "RANGER";
  const militaryDeficit =
    readiness.combatCountDeficit > 0 ||
    readiness.combatPowerDeficit > 0 ||
    readiness.formationIncomplete;
  if (militaryDeficit) {
    return chooseCombatSpawn(
      state,
      view,
      memory,
      readiness,
      discretionary,
      emergency,
    );
  }
  if (state.population >= 19 && state.resources < 20) return undefined;
  const total = Math.max(1, state.population);
  const projectedWorkerShare = (counts.WORKER + 1) / (total + 1);
  // Keep a spare combat body and a replacement bank before peacetime Workers.
  // Otherwise PURSUIT-like openings spend the last 5-10 resources on a Worker
  // and cannot rebuild after the first wave trades down the screen.
  const replacementBank = SPAWN_COSTS.VANGUARD + SPAWN_COSTS.RANGER;
  const lowReplacementBank = discretionary < replacementBank;
  const spareCombatNeeded = emergency || readiness.rebuilding ? 0 : 1;
  if (
    projectedWorkerShare <= readiness.targetWorkerShare &&
    canAffordSpawn("WORKER", state, discretionary, emergency) &&
    assessment.combatCount >=
      readiness.minimumCombatCount + spareCombatNeeded &&
    !lowReplacementBank
  ) {
    return "WORKER";
  }
  void config.combatReplacementDeadlineTicks;
  if (lowReplacementBank || discretionary < SPAWN_COSTS.VANGUARD * 2) {
    return undefined;
  }
  return chooseCombatSpawn(
    state,
    view,
    memory,
    readiness,
    discretionary,
    emergency,
  );
}

function centralChunk(position: Position): boolean {
  const chunkX = Math.floor(position[0] / 32);
  const chunkY = Math.floor(position[1] / 32);
  return (chunkX === -1 || chunkX === 0) && (chunkY === -1 || chunkY === 0);
}

function safeCoreMigrationDirection(
  core: CoreObject,
  target: Position,
  view: Snapshot,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
): Direction | undefined {
  const preferred = DIRECTIONS.map(([direction]) => direction)
    .filter((direction) => {
      const destination = nextPosition(core.position, direction);
      return distance(destination, target) < distance(core.position, target);
    })
    .sort((a, b) => {
      const aDestination = nextPosition(core.position, a);
      const bDestination = nextPosition(core.position, b);
      return (
        distance(aDestination, target) - distance(bDestination, target) ||
        a.localeCompare(b)
      );
    });
  for (const direction of preferred) {
    const destination = nextPosition(core.position, direction);
    if (
      !memory.explored[key(destination)] ||
      memory.obstacles[key(destination)] ||
      view.resources.has(key(destination)) ||
      view.occupied.has(key(destination)) ||
      (danger.get(key(destination)) ?? 0) > 0.5
    ) {
      continue;
    }
    const safeExits = DIRECTIONS.filter(([, delta]) => {
      const neighbor: Position = [
        destination[0] + delta[0],
        destination[1] + delta[1],
      ];
      return (
        Boolean(memory.explored[key(neighbor)]) &&
        !memory.obstacles[key(neighbor)] &&
        (danger.get(key(neighbor)) ?? 0) <= 0.5
      );
    }).length;
    if (safeExits >= 2) return direction;
  }
  return undefined;
}

function coreAction(
  state: PlayerState,
  view: Snapshot,
  assessment: Assessment,
  readiness: MilitaryReadiness,
  reserve: number,
  memory: StrategyMemory,
  danger: ReadonlyMap<string, number>,
  config: StrategyConfig,
  actions: Readonly<Record<string, UnitAction>>,
): CoreAction | undefined {
  const core = view.core;
  if (!core) return undefined;
  const beaconAtCore =
    state.champion_beacon.status === "GROUND" &&
    key(state.champion_beacon.position) === key(core.position);
  const shieldMax = state.champion_beacon.carrier_id ? 10 : 5;
  const canRepair = core.shield < shieldMax && state.resources >= 1;
  const criticalRepair =
    canRepair &&
    (core.shield === 0 ||
      (assessment.threatened && core.hp <= 2 && core.shield < 2));
  const visibleHostileCombat = view.enemies.some(
    (enemy) => !isEnemyWorker(enemy),
  );
  const betweenWaveTopOff =
    canRepair &&
    !criticalRepair &&
    !visibleHostileCombat &&
    !assessment.threatened &&
    core.shield < shieldMax &&
    (memory.militaryPressureTicks > 0 ||
      memory.recentCombatLosses > 0 ||
      core.shield < 4);
  const softRepairNeeded =
    canRepair &&
    !criticalRepair &&
    (assessment.threatened || core.shield < 3 || betweenWaveTopOff);
  const nearbyDepositPending = view.units.some(
    (unit) =>
      unit.unit_type === "WORKER" &&
      (unit.cargo ?? 0) > 0 &&
      distance(unit.position, core.position) <= 2,
  );
  const discretionary = Math.max(0, state.resources - reserve);
  const spawn = chooseSpawn(
    state,
    view,
    assessment,
    readiness,
    memory,
    discretionary,
    actions,
    config,
  );
  const production = spawn;
  const urgentMilitarySpawn =
    readiness.combatCountDeficit > 0 ||
    readiness.combatPowerDeficit > 0 ||
    readiness.formationIncomplete ||
    memory.recentCombatLosses > 0 ||
    ((assessment.threatened || assessment.retreatRequired) &&
      assessment.combatCount < readiness.minimumCombatCount);
  const combatProduction =
    production !== undefined &&
    production !== "WORKER" &&
    urgentMilitarySpawn &&
    !betweenWaveTopOff;
  const bankForCombatReplacement =
    urgentMilitarySpawn &&
    discretionary < SPAWN_COSTS.VANGUARD &&
    visibleHostileCombat &&
    (assessment.threatened || assessment.retreatRequired) &&
    !betweenWaveTopOff;
  if (core.state === "MOVING") {
    if (
      assessment.threatened ||
      view.resources.size > 0 ||
      beaconAtCore ||
      criticalRepair ||
      softRepairNeeded ||
      nearbyDepositPending ||
      production
    )
      return { type: "CANCEL_MOVE" };
    return undefined;
  }
  if (core.state !== "NORMAL") return undefined;
  if (beaconAtCore) return { type: "PICKUP_BEACON" };
  // Critical shield first, then combat-floor replacement, then soft repair,
  // then ordinary production. Full repair must not starve wartime spawns.
  if (criticalRepair) return { type: "REPAIR_SHIELD" };
  if (combatProduction) return { type: "SPAWN", unit_type: production };
  if (softRepairNeeded && !bankForCombatReplacement)
    return { type: "REPAIR_SHIELD" };
  const safeIdleMigration =
    memory.nearbyResourceDryTicks >= config.migrationDryTicks &&
    !assessment.threatened &&
    !assessment.retreatRequired &&
    (assessment.posture === "HOLD" || assessment.posture === "ECONOMY") &&
    view.enemies.length === 0 &&
    !nearbyDepositPending &&
    !production &&
    state.resources >= survivalReserve(state, core, assessment.threatened) + 5;
  if (safeIdleMigration) {
    const resource = Object.values(memory.resources)
      .filter(
        (candidate) =>
          distance(core.position, candidate.position) > 6 &&
          candidate.depletedAtTick === undefined,
      )
      .sort((a, b) => {
        const score = (candidate: { position: Position }): number =>
          distance(core.position, candidate.position) -
          (directionBetween(core.position, candidate.position) ===
          directionBetween(core.position, state.champion_beacon.position)
            ? 1
            : 0);
        return (
          score(a) - score(b) || key(a.position).localeCompare(key(b.position))
        );
      })[0];
    const target = centralChunk(core.position)
      ? resource?.position
      : ([0, 0] as const);
    const direction = target
      ? safeCoreMigrationDirection(core, target, view, memory, danger)
      : undefined;
    if (direction) {
      return { type: "START_MOVE", direction };
    }
  }
  if (production) return { type: "SPAWN", unit_type: production };
  return undefined;
}

function actionCounts(
  actions: Record<string, UnitAction>,
  core?: CoreAction,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const action of Object.values(actions))
    counts[action.type] = (counts[action.type] ?? 0) + 1;
  if (core) counts[`CORE_${core.type}`] = 1;
  return counts;
}

function militarySummary(
  readiness: MilitaryReadiness,
  memory: StrategyMemory,
): Pick<
  DecisionSummary,
  | "militaryReady"
  | "minimumCombatCount"
  | "minimumCombatPower"
  | "combatCountDeficit"
  | "combatPowerDeficit"
  | "targetWorkerShare"
  | "recentCombatLosses"
  | "militaryPressureTicks"
> {
  return {
    militaryReady:
      readiness.combatCountDeficit === 0 &&
      readiness.combatPowerDeficit === 0 &&
      !readiness.formationIncomplete,
    minimumCombatCount: readiness.minimumCombatCount,
    minimumCombatPower: readiness.minimumCombatPower,
    combatCountDeficit: readiness.combatCountDeficit,
    combatPowerDeficit: readiness.combatPowerDeficit,
    targetWorkerShare: readiness.targetWorkerShare,
    recentCombatLosses: memory.recentCombatLosses,
    militaryPressureTicks: memory.militaryPressureTicks,
  };
}

export function planTick(
  tick: number,
  state: PlayerState,
  previousMemory: StrategyMemory,
  config: StrategyConfig = DEFAULT_CONFIG,
  now: () => number = () => performance.now(),
): PlanResult {
  const started = now();
  const view = snapshot(state);
  const memory = updateMemory(tick, state, view, previousMemory, config);
  for (const obstacle of Object.keys(memory.obstacles))
    view.obstacles.add(obstacle);
  const danger = buildDanger(tick, view, memory, config);
  const assessment = assess(tick, state, view, memory, danger, config);
  if (assessment.retreatRequired) {
    memory.militaryPressureTicks = config.militaryPressureHorizonTicks;
    memory.militaryCalmTicks = 0;
  }
  const readiness = deriveMilitaryReadiness(
    tick,
    view,
    assessment,
    memory,
    config,
  );
  const visibleHarvestAssignments = visibleResourceAssignments(
    view,
    memory,
    danger,
    config,
  );
  const explorationIndexes = explorationWorkerIndexes(
    tick,
    view.units.filter((unit) => unit.unit_type === "WORKER"),
    view.core,
    view.resources.size === 0 ||
      view.units.filter((unit) => unit.unit_type === "WORKER").length <= 3,
  );
  if (assessment.posture !== memory.posture) {
    memory.posture = assessment.posture;
    memory.postureSinceTick = tick;
  }
  const reserve = economicReserve(
    state,
    view.core,
    assessment.threatened || assessment.retreatRequired,
  );
  const actions: Record<string, UnitAction> = {};
  const reserved = new Set<string>();
  const reservedResources = new Set<string>();
  const fogResourceClaims = new Set<string>();
  const assignedWorkerTargets = new Set<string>();
  const holdAssignments = new Set<string>();
  const allocatedDamage = new Map<string, number>();
  const claimedIntercepts = new Set<string>();
  const formationOrders = combatFormationOrders(
    tick,
    view,
    memory,
    assessment,
    danger,
  );
  const destruct = upkeepSelfDestructs(state, view);
  let timedOut = false;
  let workerIndex = 0;

  const synchronizeControlSupport = assessment.controlIds.size > 0;
  if (synchronizeControlSupport) assessment.supportPositions.length = 0;
  const corePressureEnemies = view.core
    ? view.enemies.filter(
        (enemy) =>
          !isEnemyWorker(enemy) &&
          distance(view.core!.position, enemy.position) <= 3,
      )
    : [];
  const freefireEnemies = view.core
    ? corePressureEnemies.filter((enemy) =>
        canDamageCoreNow(enemy, view.core!, view.obstacles),
      )
    : [];
  const combatPlanPriority = (unit: UnitObject): number => {
    if (unit.unit_type === "WORKER") return 10_000;
    const focus =
      freefireEnemies.length > 0 ? freefireEnemies : corePressureEnemies;
    if (focus.length === 0) return 500;
    let best = Number.POSITIVE_INFINITY;
    for (const enemy of focus) {
      const dist = distance(unit.position, enemy.position);
      const rank = (dist === 1 ? 0 : 20) + dist;
      if (rank < best) best = rank;
    }
    return best;
  };
  const planningUnits = [...view.units].sort(
    (a, b) =>
      (synchronizeControlSupport
        ? Number(!assessment.reserveIds.has(a.id)) -
          Number(!assessment.reserveIds.has(b.id))
        : 0) ||
      (synchronizeControlSupport
        ? Number(assessment.responseIds.has(a.id)) -
          Number(assessment.responseIds.has(b.id))
        : 0) ||
      combatPlanPriority(a) - combatPlanPriority(b) ||
      Number(a.unit_type === "WORKER") - Number(b.unit_type === "WORKER") ||
      a.id.localeCompare(b.id),
  );
  for (const unit of planningUnits) {
    if (now() - started > config.computeBudgetMs) {
      timedOut = true;
      break;
    }
    if (destruct.has(unit.id)) {
      actions[unit.id] = { type: "SELF_DESTRUCT" };
      continue;
    }
    if (unit.unit_type === "WORKER") {
      actions[unit.id] = workerAction(
        tick,
        unit,
        explorationIndexes.get(unit.id) ?? workerIndex,
        assessment.workerCount,
        view,
        memory,
        danger,
        reserved,
        reservedResources,
        fogResourceClaims,
        visibleHarvestAssignments.get(unit.id),
        assignedWorkerTargets,
        assessment,
        config,
      );
      workerIndex += 1;
    } else {
      const decision = combatAction(
        tick,
        unit,
        view,
        state.champion_beacon,
        memory,
        assessment,
        danger,
        reserved,
        holdAssignments,
        allocatedDamage,
        claimedIntercepts,
        formationOrders,
        config,
      );
      actions[unit.id] = decision.action;
      memory.roles[unit.id] = decision.role;
      if (
        synchronizeControlSupport &&
        assessment.reserveIds.has(unit.id) &&
        decision.role.kind === "RESERVE"
      ) {
        assessment.supportPositions.push(actionPosition(unit, decision.action));
      }
    }
  }

  memory.previousPopulation = state.population;
  if (timedOut) {
    memory.previousCombatUnitIds = view.units
      .filter((unit) => unit.unit_type !== "WORKER")
      .map((unit) => unit.id);
    const fallback = safeFallbackPlan(tick, state);
    return {
      plan: fallback,
      memory,
      summary: {
        posture: assessment.posture,
        threatened: assessment.threatened,
        retreating: assessment.retreatRequired,
        controlRadius: assessment.controlRadius,
        supportResponseTicks: assessment.supportResponseTicks,
        reserveCount: assessment.reserveIds.size,
        reserve,
        ...militarySummary(readiness, memory),
        actions: actionCounts(fallback.unit_actions ?? {}),
        planningMs: Math.max(0, now() - started),
      },
    };
  }
  const selectedCoreAction = coreAction(
    state,
    view,
    assessment,
    readiness,
    reserve,
    memory,
    danger,
    config,
    actions,
  );
  memory.previousCombatUnitIds = view.units
    .filter((unit) => unit.unit_type !== "WORKER" && !destruct.has(unit.id))
    .map((unit) => unit.id);
  const plan: CommandPlan = { tick, unit_actions: actions };
  if (selectedCoreAction) plan.core_action = selectedCoreAction;
  const summary: DecisionSummary = {
    posture: assessment.posture,
    threatened: assessment.threatened,
    retreating: assessment.retreatRequired,
    controlRadius: assessment.controlRadius,
    supportResponseTicks: assessment.supportResponseTicks,
    reserveCount: assessment.reserveIds.size,
    reserve,
    ...militarySummary(readiness, memory),
    actions: actionCounts(actions, selectedCoreAction),
    planningMs: Math.max(0, now() - started),
  };
  return { plan, memory, summary };
}

export function safeFallbackPlan(
  tick: number,
  state: PlayerState,
): CommandPlan {
  const view = snapshot(state);
  const unitActions: Record<string, UnitAction> = {};
  for (const unit of view.units) {
    if (
      unit.unit_type === "WORKER" &&
      (unit.cargo ?? 0) > 0 &&
      view.core &&
      key(unit.position) === key(view.core.position)
    ) {
      unitActions[unit.id] = { type: "DEPOSIT" };
    }
  }
  return { tick, unit_actions: unitActions };
}

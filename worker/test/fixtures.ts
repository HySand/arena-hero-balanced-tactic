import type {
  CoreObject,
  PlayerState,
  Position,
  UnitObject,
  UnitType,
  WorldObject,
} from "../src/contracts";

export const IDS = {
  core: "00000000-0000-4000-8000-000000000001",
  worker1: "00000000-0000-4000-8000-000000000011",
  worker2: "00000000-0000-4000-8000-000000000012",
  worker3: "00000000-0000-4000-8000-000000000013",
  vanguard: "00000000-0000-4000-8000-000000000021",
  ranger: "00000000-0000-4000-8000-000000000031",
  enemyCore: "00000000-0000-4000-8000-000000000101",
  enemyWorker: "00000000-0000-4000-8000-000000000111",
  enemyVanguard: "00000000-0000-4000-8000-000000000121",
} as const;

export function core(overrides: Partial<CoreObject> = {}): CoreObject {
  return {
    kind: "CORE",
    id: IDS.core,
    owner_username: "player",
    controlled: true,
    position: [0, 0],
    hp: 5,
    shield: 5,
    state: "NORMAL",
    ...overrides,
  };
}

export function unit(
  id: string,
  unitType: UnitType,
  position: Position,
  overrides: Partial<UnitObject> = {},
): UnitObject {
  return {
    kind: "UNIT",
    id,
    controlled: true,
    position,
    hp: unitType === "VANGUARD" ? 4 : 2,
    unit_type: unitType,
    ...(unitType === "WORKER" ? { cargo: 0 } : {}),
    ...overrides,
  };
}

export function state(
  objects: WorldObject[],
  overrides: Partial<PlayerState> = {},
): PlayerState {
  const population = objects.filter(
    (object): object is UnitObject =>
      object.kind === "UNIT" && object.controlled,
  ).length;
  return {
    status: "ACTIVE",
    resources: 5,
    population,
    population_tier: Math.floor(population / 20),
    upkeep_next_tick: population >= 20 ? 1 : 0,
    champion_beacon: { position: [20, 20] },
    objects,
    events: [],
    ...overrides,
  };
}

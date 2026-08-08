import type {
  CommandPlan,
  CoreObject,
  GameMessage,
  PlayerState,
  Position,
  ReceivedData,
  TerrainObject,
  UnitObject,
  WorldObject,
} from "./contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function position(value: unknown): Position | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isSafeInteger(value[0]) ||
    !Number.isSafeInteger(value[1])
  ) {
    return undefined;
  }
  return [value[0] as number, value[1] as number];
}

function positions(value: unknown): Position[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const decoded = value.map(position);
  return decoded.every((item): item is Position => item !== undefined)
    ? decoded
    : undefined;
}

function worldObject(value: unknown): WorldObject | undefined {
  const data = object(value);
  if (!data || typeof data.kind !== "string") return undefined;

  if (data.kind === "OBSTACLE" || data.kind === "RESOURCE") {
    const decodedPositions = positions(data.positions);
    if (!decodedPositions) return undefined;
    return {
      kind: data.kind,
      positions: decodedPositions,
    } satisfies TerrainObject;
  }

  const decodedPosition = position(data.position);
  if (
    !decodedPosition ||
    typeof data.id !== "string" ||
    !UUID.test(data.id) ||
    typeof data.controlled !== "boolean" ||
    !Number.isInteger(data.hp)
  ) {
    return undefined;
  }

  if (data.kind === "CORE") {
    if (
      typeof data.owner_username !== "string" ||
      !Number.isInteger(data.shield) ||
      (data.state !== "NORMAL" && data.state !== "MOVING")
    ) {
      return undefined;
    }
    const core: CoreObject = {
      kind: "CORE",
      id: data.id,
      owner_username: data.owner_username,
      controlled: data.controlled,
      position: decodedPosition,
      hp: data.hp as number,
      shield: data.shield as number,
      state: data.state,
    };
    if (data.state === "MOVING") {
      const destination = position(data.destination);
      if (
        !isDirection(data.move_direction) ||
        !Number.isInteger(data.move_progress) ||
        !Number.isInteger(data.move_required_ticks) ||
        !destination
      ) {
        return undefined;
      }
      core.move_direction = data.move_direction;
      core.move_progress = data.move_progress as number;
      core.move_required_ticks = data.move_required_ticks as number;
      core.destination = destination;
    }
    return core;
  }

  if (
    data.kind !== "UNIT" ||
    (data.unit_type !== "WORKER" &&
      data.unit_type !== "VANGUARD" &&
      data.unit_type !== "RANGER")
  ) {
    return undefined;
  }
  const unit: UnitObject = {
    kind: "UNIT",
    id: data.id,
    controlled: data.controlled,
    position: decodedPosition,
    hp: data.hp as number,
    unit_type: data.unit_type,
  };
  if (data.controlled && data.unit_type === "WORKER") {
    if (!Number.isInteger(data.cargo)) return undefined;
    unit.cargo = data.cargo as number;
  }
  return unit;
}

function isDirection(
  value: unknown,
): value is "UP" | "DOWN" | "LEFT" | "RIGHT" {
  return (
    value === "UP" || value === "DOWN" || value === "LEFT" || value === "RIGHT"
  );
}

function playerState(value: unknown): PlayerState | undefined {
  const data = object(value);
  if (
    !data ||
    (data.status !== "ACTIVE" && data.status !== "RESPAWNING") ||
    !Number.isInteger(data.resources) ||
    !Number.isInteger(data.population) ||
    !Number.isInteger(data.population_tier) ||
    !Number.isInteger(data.upkeep_next_tick) ||
    !Array.isArray(data.objects) ||
    !Array.isArray(data.events)
  ) {
    return undefined;
  }
  const beacon = object(data.champion_beacon);
  const beaconPosition = position(beacon?.position);
  if (!beacon || !beaconPosition) return undefined;
  const decodedObjects = data.objects.map(worldObject);
  if (!decodedObjects.every((item): item is WorldObject => item !== undefined))
    return undefined;

  const state: PlayerState = {
    status: data.status,
    resources: data.resources as number,
    population: data.population as number,
    population_tier: data.population_tier as number,
    upkeep_next_tick: data.upkeep_next_tick as number,
    champion_beacon: { position: beaconPosition },
    objects: decodedObjects,
    events: data.events.filter(
      (event): event is Record<string, unknown> => object(event) !== undefined,
    ),
  };
  if (Number.isInteger(data.respawn_at_tick))
    state.respawn_at_tick = data.respawn_at_tick as number;
  if (beacon.status === "GROUND" || beacon.status === "CARRIED") {
    state.champion_beacon.status = beacon.status;
  }
  if (typeof beacon.carrier_id === "string")
    state.champion_beacon.carrier_id = beacon.carrier_id;
  return state;
}

function commandPlan(value: unknown): CommandPlan | undefined {
  const data = object(value);
  if (!data || !Number.isInteger(data.tick) || (data.tick as number) < 1)
    return undefined;
  return data as unknown as CommandPlan;
}

function received(value: unknown): ReceivedData | undefined {
  const data = object(value);
  const plan = commandPlan(data?.plan);
  if (
    !data ||
    !Number.isInteger(data.tick) ||
    (data.source !== "AGENT" && data.source !== "MANUAL") ||
    typeof data.received_at !== "string" ||
    !plan
  ) {
    return undefined;
  }
  return {
    tick: data.tick as number,
    source: data.source,
    received_at: data.received_at,
    plan,
  };
}

export function decodeGameMessage(raw: string): GameMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  const envelope = object(parsed);
  if (!envelope) return undefined;
  if (
    envelope.type === "tick" &&
    Number.isInteger(envelope.data) &&
    (envelope.data as number) > 0
  ) {
    return { type: "tick", data: envelope.data as number };
  }
  if (envelope.type === "state") {
    const state = playerState(envelope.data);
    return state ? { type: "state", data: state } : undefined;
  }
  if (envelope.type === "received") {
    const receipt = received(envelope.data);
    return receipt ? { type: "received", data: receipt } : undefined;
  }
  return undefined;
}

export function serializePlan(plan: CommandPlan): string {
  return JSON.stringify(plan);
}

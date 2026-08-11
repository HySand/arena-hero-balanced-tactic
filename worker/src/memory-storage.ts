import type { PlayerState, Position, StrategyMemory } from "./contracts";

const MAX_EXPLORED_CELLS = 2400;
const MAX_WORKER_EXPLORED_CELLS = 1200;
const MAX_OBSTACLE_CELLS = 800;
const MAX_RESOURCE_OBSERVATIONS = 32;

export interface StrategyMemorySize {
  explored: number;
  workerExplored: number;
  obstacles: number;
  resources: number;
}

export function strategyMemorySize(memory: StrategyMemory): StrategyMemorySize {
  return {
    explored: Object.keys(memory.explored).length,
    workerExplored: Object.keys(memory.workerExplored ?? {}).length,
    obstacles: Object.keys(memory.obstacles).length,
    resources: Object.keys(memory.resources).length,
  };
}

export function compactStrategyMemory(
  memory: StrategyMemory,
  state: PlayerState,
): StrategyMemory {
  const size = strategyMemorySize(memory);
  if (
    size.explored <= MAX_EXPLORED_CELLS &&
    size.workerExplored <= MAX_WORKER_EXPLORED_CELLS &&
    size.obstacles <= MAX_OBSTACLE_CELLS &&
    size.resources <= MAX_RESOURCE_OBSERVATIONS
  ) {
    return memory;
  }

  const anchors = memoryAnchors(memory, state);
  const resources = selectEntries(
    memory.resources,
    MAX_RESOURCE_OBSERVATIONS,
    (observation) => [
      -observation.lastSeenTick,
      nearestDistance(observation.position, anchors),
    ],
  );
  const retainedAnchors = [
    ...anchors,
    ...Object.values(resources).map((resource) => resource.position),
  ];
  const explored = selectPositions(
    memory.explored,
    MAX_EXPLORED_CELLS,
    retainedAnchors,
  );
  const workerExplored = selectPositions(
    memory.workerExplored ?? {},
    MAX_WORKER_EXPLORED_CELLS,
    retainedAnchors,
  );
  const obstacles = selectPositions(
    memory.obstacles,
    MAX_OBSTACLE_CELLS,
    retainedAnchors,
  );

  return {
    ...memory,
    explored,
    workerExplored,
    obstacles,
    resources,
    patrolVisits: Object.fromEntries(
      Object.entries(memory.patrolVisits).filter(([cell]) => explored[cell]),
    ),
  };
}

function memoryAnchors(memory: StrategyMemory, state: PlayerState): Position[] {
  const anchors: Position[] = [state.champion_beacon.position];
  for (const object of state.objects) {
    if ("position" in object) anchors.push(object.position);
  }
  for (const enemy of Object.values(memory.enemies)) {
    anchors.push(enemy.position);
  }
  return anchors;
}

function selectPositions(
  values: Record<string, Position>,
  limit: number,
  anchors: readonly Position[],
): Record<string, Position> {
  return selectEntries(values, limit, (position) => [
    nearestDistance(position, anchors),
  ]);
}

function selectEntries<T>(
  values: Record<string, T>,
  limit: number,
  rank: (value: T) => readonly number[],
): Record<string, T> {
  const entries = Object.entries(values);
  if (entries.length <= limit) return values;
  return Object.fromEntries(
    entries
      .map(([entryKey, value]) => ({ entryKey, value, rank: rank(value) }))
      .sort(
        (left, right) =>
          compareRank(left.rank, right.rank) ||
          left.entryKey.localeCompare(right.entryKey),
      )
      .slice(0, limit)
      .map(({ entryKey, value }) => [entryKey, value]),
  );
}

function compareRank(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference =
      (left[index] ?? Number.POSITIVE_INFINITY) -
      (right[index] ?? Number.POSITIVE_INFINITY);
    if (difference !== 0) return difference;
  }
  return 0;
}

function nearestDistance(
  position: Position,
  anchors: readonly Position[],
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const anchor of anchors) {
    best = Math.min(
      best,
      Math.abs(position[0] - anchor[0]) + Math.abs(position[1] - anchor[1]),
    );
  }
  return best;
}

export async function encodeStrategyMemory(
  memory: StrategyMemory,
): Promise<ArrayBuffer> {
  const source = new Blob([JSON.stringify(memory)]).stream();
  return new Response(
    source.pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
}

export async function decodeStrategyMemory(
  compressed: ArrayBuffer,
): Promise<StrategyMemory> {
  const source = new Blob([compressed]).stream();
  const json = await new Response(
    source.pipeThrough(new DecompressionStream("gzip")),
  ).text();
  return JSON.parse(json) as StrategyMemory;
}

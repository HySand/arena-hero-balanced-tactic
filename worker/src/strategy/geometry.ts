import type { Direction, Position } from "../contracts";

export const DIRECTIONS: ReadonlyArray<readonly [Direction, Position]> = [
  ["UP", [0, -1]],
  ["RIGHT", [1, 0]],
  ["DOWN", [0, 1]],
  ["LEFT", [-1, 0]],
];

export function key(position: Position): string {
  return `${position[0]},${position[1]}`;
}

export function add(position: Position, delta: Position): Position {
  return [position[0] + delta[0], position[1] + delta[1]];
}

export function distance(a: Position, b: Position): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

export function directionBetween(
  from: Position,
  to: Position,
): Direction | undefined {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (Math.abs(dx) >= Math.abs(dy) && dx !== 0)
    return dx > 0 ? "RIGHT" : "LEFT";
  if (dy !== 0) return dy > 0 ? "DOWN" : "UP";
  return undefined;
}

export function nextPosition(
  position: Position,
  direction: Direction,
): Position {
  const entry = DIRECTIONS.find(([candidate]) => candidate === direction);
  return entry ? add(position, entry[1]) : position;
}

export function lineClear(
  from: Position,
  to: Position,
  blocked: ReadonlySet<string>,
): boolean {
  if (from[0] !== to[0] && from[1] !== to[1]) return false;
  const range = distance(from, to);
  if (range < 1 || range > 3) return false;
  const direction = directionBetween(from, to);
  if (!direction) return false;
  let cursor = from;
  for (let step = 1; step < range; step += 1) {
    cursor = nextPosition(cursor, direction);
    if (blocked.has(key(cursor))) return false;
  }
  return true;
}

export function hasVision(
  from: Position,
  to: Position,
  radius: number,
  obstacles: ReadonlySet<string>,
): boolean {
  if (distance(from, to) > radius) return false;
  if (key(from) === key(to)) return true;

  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  for (let step = 1; step < steps; step += 1) {
    const previousX = from[0] + (dx * (step - 1)) / steps;
    const previousY = from[1] + (dy * (step - 1)) / steps;
    const exactX = from[0] + (dx * step) / steps;
    const exactY = from[1] + (dy * step) / steps;
    const touched: Position[] = [[Math.round(exactX), Math.round(exactY)]];

    if (Number.isInteger(exactX) && Number.isInteger(exactY)) {
      const xStep = Math.sign(exactX - previousX);
      const yStep = Math.sign(exactY - previousY);
      if (xStep !== 0 && yStep !== 0) {
        touched.push([exactX - xStep, exactY], [exactX, exactY - yStep]);
      }
    }
    if (touched.some((cell) => obstacles.has(key(cell)))) return false;
  }
  return true;
}

export interface PathOptions {
  maxNodes?: number;
  maxDistance?: number;
  /** Ban this direction only for the first edge out of start. */
  bannedFirst?: Direction | undefined;
  /**
   * Intermediate cells must pass this predicate. The goal is always allowed so
   * unknown frontier cells can be exploration targets without becoming fog
   * shortcuts (arena-hero-balanced-tactic Pathfinder rule).
   */
  allowed?: ((position: Position) => boolean) | undefined;
  /**
   * Optional map bounds. When omitted, expansion is unbounded except by
   * maxNodes / maxDistance.
   */
  inBounds?: ((position: Position) => boolean) | undefined;
}

interface WeightedOpenEntry {
  key: string;
  cost: number;
}

class WeightedOpenHeap {
  private readonly entries: WeightedOpenEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  push(entry: WeightedOpenEntry): void {
    this.entries.push(entry);
    let index = this.entries.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentEntry = this.entries[parent];
      if (!parentEntry || compareOpenEntries(parentEntry, entry) <= 0) break;
      this.entries[index] = parentEntry;
      index = parent;
    }
    this.entries[index] = entry;
  }

  pop(): WeightedOpenEntry | undefined {
    const first = this.entries[0];
    const last = this.entries.pop();
    if (!first || !last || this.entries.length === 0) return first;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.entries.length) break;
      const leftEntry = this.entries[left];
      const rightEntry = this.entries[right];
      if (!leftEntry) break;
      const child =
        rightEntry && compareOpenEntries(rightEntry, leftEntry) < 0
          ? right
          : left;
      const childEntry = this.entries[child];
      if (!childEntry || compareOpenEntries(last, childEntry) <= 0) break;
      this.entries[index] = childEntry;
      index = child;
    }
    this.entries[index] = last;
    return first;
  }
}

function compareOpenEntries(
  left: WeightedOpenEntry,
  right: WeightedOpenEntry,
): number {
  return left.cost - right.cost || left.key.localeCompare(right.key);
}

function reconstructPath(
  cameFrom: Map<string, { from: string; direction: Direction }>,
  startKey: string,
  goalKey: string,
): Direction[] {
  const path: Direction[] = [];
  let cursor = goalKey;
  while (cursor !== startKey) {
    const parent = cameFrom.get(cursor);
    if (!parent) return [];
    path.push(parent.direction);
    cursor = parent.from;
  }
  path.reverse();
  return path;
}

export function findStep(
  start: Position,
  goal: Position,
  blocked: ReadonlySet<string>,
  danger: ReadonlyMap<string, number>,
  maxNodes = 2048,
  requireGoal = false,
  /** When set, only expand through cells that pass (goal always allowed). */
  allowed?: (position: Position) => boolean,
): Direction | undefined {
  if (key(start) === key(goal)) return undefined;
  const queue: Array<{ position: Position; first?: Direction }> = [
    { position: start },
  ];
  const visited = new Set([key(start)]);
  let best = queue[0];
  let bestScore = distance(start, goal);
  const goalKey = key(goal);

  for (let index = 0; index < queue.length && index < maxNodes; index += 1) {
    const current = queue[index];
    if (!current) break;
    for (const [direction, delta] of DIRECTIONS) {
      const candidate = add(current.position, delta);
      const candidateKey = key(candidate);
      if (visited.has(candidateKey) || blocked.has(candidateKey)) continue;
      if (allowed && candidateKey !== goalKey && !allowed(candidate)) {
        continue;
      }
      visited.add(candidateKey);
      const first = current.first ?? direction;
      const score =
        distance(candidate, goal) + (danger.get(candidateKey) ?? 0) * 4;
      if (score < bestScore) {
        best = { position: candidate, first };
        bestScore = score;
      }
      if (candidateKey === goalKey) return first;
      queue.push({ position: candidate, first });
    }
  }
  return requireGoal ? undefined : best?.first;
}

/**
 * BFS path. By default unknown/fog cells are walkable (legacy combat movers).
 * Pass `allowed` to restrict intermediates to known/explored cells — required
 * for worker harvest so FOW never becomes a phantom shortcut.
 */
export function findPath(
  start: Position,
  goal: Position,
  blocked: ReadonlySet<string>,
  danger: ReadonlyMap<string, number> = new Map(),
  maxNodes = 2048,
  bannedFirst?: Direction,
  allowed?: (position: Position) => boolean,
): Direction[] | undefined {
  return findPathWithOptions(
    start,
    goal,
    blocked,
    {
      maxNodes,
      bannedFirst,
      allowed,
      // danger reserved for future weighted search; callers pre-filter unsafe.
    },
    danger,
  );
}

export function findPathWithOptions(
  start: Position,
  goal: Position,
  blocked: ReadonlySet<string>,
  options: PathOptions = {},
  danger: ReadonlyMap<string, number> = new Map(),
): Direction[] | undefined {
  if (key(start) === key(goal)) return [];
  const maxNodes = options.maxNodes ?? 2048;
  const maxDistance = options.maxDistance ?? 96;
  const bannedFirst = options.bannedFirst;
  const allowed = options.allowed;
  const inBounds = options.inBounds;
  const startKey = key(start);
  const goalKey = key(goal);

  const queue: Position[] = [start];
  const visited = new Set([startKey]);
  const cameFrom = new Map<string, { from: string; direction: Direction }>();
  const depth = new Map<string, number>([[startKey, 0]]);

  // Soft preference: expand safer nodes earlier without leaving BFS layers.
  // We keep true BFS by only using danger as a within-layer sort key via
  // neighbor ordering.
  for (let index = 0; index < queue.length && index < maxNodes; index += 1) {
    const current = queue[index];
    if (!current) break;
    const currentKey = key(current);
    const currentDepth = depth.get(currentKey) ?? 0;
    if (currentDepth >= maxDistance) continue;

    const neighbors = [...DIRECTIONS].sort(([dirA, deltaA], [dirB, deltaB]) => {
      const a = add(current, deltaA);
      const b = add(current, deltaB);
      const dangerA = danger.get(key(a)) ?? 0;
      const dangerB = danger.get(key(b)) ?? 0;
      return (
        dangerA - dangerB ||
        distance(a, goal) - distance(b, goal) ||
        dirA.localeCompare(dirB)
      );
    });

    for (const [direction, delta] of neighbors) {
      if (currentDepth === 0 && bannedFirst && direction === bannedFirst) {
        continue;
      }
      const candidate = add(current, delta);
      const candidateKey = key(candidate);
      if (visited.has(candidateKey)) continue;
      if (inBounds && candidateKey !== goalKey && !inBounds(candidate))
        continue;
      // Goal may be occupied by the resource itself; only block non-goal cells.
      if (candidateKey !== goalKey && blocked.has(candidateKey)) continue;
      if (allowed && candidateKey !== goalKey && !allowed(candidate)) continue;

      visited.add(candidateKey);
      cameFrom.set(candidateKey, { from: currentKey, direction });
      depth.set(candidateKey, currentDepth + 1);

      if (candidateKey === goalKey) {
        return reconstructPath(cameFrom, startKey, goalKey);
      }
      queue.push(candidate);
    }
  }

  // Goal sealed or unknown: approach nearest reachable neighbor of the goal
  // (reference Pathfinder.distance_to / first_step behavior).
  let bestApproach: { key: string; depth: number } | undefined;
  for (const [, delta] of DIRECTIONS) {
    const neighbor = add(goal, delta);
    const neighborKey = key(neighbor);
    const neighborDepth = depth.get(neighborKey);
    if (neighborDepth === undefined) continue;
    if (
      !bestApproach ||
      neighborDepth < bestApproach.depth ||
      (neighborDepth === bestApproach.depth &&
        neighborKey.localeCompare(bestApproach.key) < 0)
    ) {
      bestApproach = { key: neighborKey, depth: neighborDepth };
    }
  }
  if (!bestApproach) return undefined;
  if (bestApproach.key === startKey) {
    const step = directionBetween(start, goal);
    if (!step) return undefined;
    if (bannedFirst && step === bannedFirst) return undefined;
    // Stepping onto the goal from an adjacent approach cell.
    if (blocked.has(goalKey)) return undefined;
    return [step];
  }
  const toApproach = reconstructPath(cameFrom, startKey, bestApproach.key);
  return toApproach.length > 0 ? toApproach : undefined;
}

/**
 * Dijkstra path where each step has a caller-provided cost.
 * Use higher costs for unexplored fog so known corridors win, while still
 * allowing deliberate fog entry when no explored route exists (detours).
 */
export function findWeightedPath(
  start: Position,
  goal: Position,
  blocked: ReadonlySet<string>,
  stepCost: (
    from: Position,
    to: Position,
    direction: Direction,
  ) => number | undefined,
  options: PathOptions = {},
): Direction[] | undefined {
  if (key(start) === key(goal)) return [];
  const maxNodes = options.maxNodes ?? 2048;
  const maxDistance = options.maxDistance ?? 96;
  const bannedFirst = options.bannedFirst;
  const inBounds = options.inBounds;
  const startKey = key(start);
  const goalKey = key(goal);

  const bestCost = new Map<string, number>([[startKey, 0]]);
  const bestDepth = new Map<string, number>([[startKey, 0]]);
  const cameFrom = new Map<string, { from: string; direction: Direction }>();
  const open = new WeightedOpenHeap();
  open.push({ key: startKey, cost: 0 });
  const positions = new Map<string, Position>([[startKey, start]]);
  let expansions = 0;

  while (open.size > 0 && expansions < maxNodes) {
    const currentEntry = open.pop();
    if (!currentEntry) break;
    const currentKey = currentEntry.key;
    const currentCost = currentEntry.cost;
    if (currentCost !== bestCost.get(currentKey)) continue;
    expansions += 1;
    if (currentKey === goalKey) {
      return reconstructPath(cameFrom, startKey, goalKey);
    }
    const current = positions.get(currentKey);
    if (!current) continue;
    const currentDepth = bestDepth.get(currentKey) ?? 0;
    if (currentDepth >= maxDistance) continue;

    for (const [direction, delta] of DIRECTIONS) {
      if (currentDepth === 0 && bannedFirst && direction === bannedFirst)
        continue;
      const candidate = add(current, delta);
      const candidateKey = key(candidate);
      if (inBounds && candidateKey !== goalKey && !inBounds(candidate))
        continue;
      if (candidateKey !== goalKey && blocked.has(candidateKey)) continue;
      const edge = stepCost(current, candidate, direction);
      if (edge === undefined || edge >= Number.POSITIVE_INFINITY) continue;
      const nextCost = currentCost + edge;
      const prior = bestCost.get(candidateKey);
      if (prior !== undefined && nextCost >= prior) continue;
      bestCost.set(candidateKey, nextCost);
      bestDepth.set(candidateKey, currentDepth + 1);
      cameFrom.set(candidateKey, { from: currentKey, direction });
      positions.set(candidateKey, candidate);
      open.push({ key: candidateKey, cost: nextCost });
    }
  }

  // Approach nearest reached neighbor of the goal.
  let bestApproach: { key: string; cost: number } | undefined;
  for (const [, delta] of DIRECTIONS) {
    const neighbor = add(goal, delta);
    const neighborKey = key(neighbor);
    const cost = bestCost.get(neighborKey);
    if (cost === undefined) continue;
    if (
      !bestApproach ||
      cost < bestApproach.cost ||
      (cost === bestApproach.cost &&
        neighborKey.localeCompare(bestApproach.key) < 0)
    ) {
      bestApproach = { key: neighborKey, cost };
    }
  }
  if (!bestApproach) return undefined;
  if (bestApproach.key === startKey) {
    const step = directionBetween(start, goal);
    if (!step || (bannedFirst && step === bannedFirst)) return undefined;
    if (blocked.has(goalKey)) return undefined;
    const edge = stepCost(start, goal, step);
    if (edge === undefined) return undefined;
    return [step];
  }
  const toApproach = reconstructPath(cameFrom, startKey, bestApproach.key);
  return toApproach.length > 0 ? toApproach : undefined;
}

export function cellsWithin(center: Position, radius: number): Position[] {
  const cells: Position[] = [];
  for (let dx = -radius; dx <= radius; dx += 1) {
    const remaining = radius - Math.abs(dx);
    for (let dy = -remaining; dy <= remaining; dy += 1) {
      cells.push([center[0] + dx, center[1] + dy]);
    }
  }
  return cells;
}

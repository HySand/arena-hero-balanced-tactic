import { describe, expect, it } from "vitest";

import type {
  Position,
  StrategyMemory,
  UnitObject,
  WorldObject,
} from "../src/contracts";
import { DEFAULT_CONFIG } from "../src/strategy/config";
import { distance, lineClear, nextPosition } from "../src/strategy/geometry";
import {
  emptyMemory,
  planTick,
  safeFallbackPlan,
} from "../src/strategy/planner";
import { core, IDS, state, unit } from "./fixtures";

function exploredDiamond(
  center: Position,
  radius: number,
): Record<string, Position> {
  const explored: Record<string, Position> = {};
  for (let x = center[0] - radius; x <= center[0] + radius; x += 1) {
    for (let y = center[1] - radius; y <= center[1] + radius; y += 1) {
      if (distance(center, [x, y]) <= radius) explored[`${x},${y}`] = [x, y];
    }
  }
  return explored;
}

describe("balanced strategy planner", () => {
  it("assigns only one Worker to harvest a contested resource", () => {
    const result = planTick(
      10,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [1, 0]),
        unit(IDS.worker2, "WORKER", [1, 0]),
        { kind: "RESOURCE", positions: [[1, 0]] },
      ]),
      emptyMemory(),
    );
    const actions = result.plan.unit_actions ?? {};
    expect(
      Object.values(actions).filter((action) => action.type === "HARVEST"),
    ).toHaveLength(1);
  });

  it("fans idle Workers into distinct exploration directions", () => {
    const workers = Array.from({ length: 6 }, (_, index) =>
      unit(
        `00000000-0000-4000-8000-${String(index + 200).padStart(12, "0")}`,
        "WORKER",
        [0, 0],
      ),
    );
    const result = planTick(10, state([core(), ...workers]), {
      ...emptyMemory(),
      posture: "HOLD",
      postureSinceTick: 1,
    });
    const directions = new Set(
      Object.values(result.plan.unit_actions ?? {})
        .filter((action) => action.type === "MOVE")
        .map((action) => (action.type === "MOVE" ? action.direction : "")),
    );
    expect(directions.size).toBeGreaterThanOrEqual(3);
  });

  it("pushes resource-scarce Workers from the known boundary into fog", () => {
    const explored: Record<string, readonly [number, number]> = {};
    for (let x = -5; x <= 5; x += 1) {
      for (let y = -5; y <= 5; y += 1) {
        if (Math.abs(x) + Math.abs(y) <= 5) explored[`${x},${y}`] = [x, y];
      }
    }
    const workerPositions = new Map([
      [IDS.worker1, [3, 2] as const],
      [IDS.worker2, [-3, 2] as const],
      [IDS.worker3, [-3, -2] as const],
    ]);
    const result = planTick(
      20,
      state([
        core(),
        ...[...workerPositions].map(([id, position]) =>
          unit(id, "WORKER", position),
        ),
      ]),
      {
        ...emptyMemory(),
        explored,
        posture: "ECONOMY",
        postureSinceTick: 1,
        safeExpansionTicks: 8,
      },
    );
    const delta = {
      UP: [0, -1],
      RIGHT: [1, 0],
      DOWN: [0, 1],
      LEFT: [-1, 0],
    } as const;
    const fogEntries = [...workerPositions].filter(([id, position]) => {
      const action = result.plan.unit_actions?.[id];
      if (action?.type !== "MOVE") return false;
      const step = delta[action.direction];
      return !explored[`${position[0] + step[0]},${position[1] + step[1]}`];
    });
    expect(fogEntries.length).toBeGreaterThanOrEqual(2);
  });

  it("routes an empty Worker around another empty Worker's cell", () => {
    const result = planTick(
      10,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [2, 0]),
        unit(IDS.worker2, "WORKER", [3, 0]),
        { kind: "RESOURCE", positions: [[4, 0]] },
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );
    expect(result.plan.unit_actions?.[IDS.worker1]).not.toEqual({
      type: "MOVE",
      direction: "RIGHT",
    });
  });

  it("assigns one empty Worker to every cell in a compact resource patch", () => {
    const result = planTick(
      10,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [2, 0]),
        unit(IDS.worker2, "WORKER", [2, 1]),
        {
          kind: "RESOURCE",
          positions: [
            [3, 0],
            [3, 1],
          ],
        },
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );
    const movesIntoPatch = [
      result.plan.unit_actions?.[IDS.worker1],
      result.plan.unit_actions?.[IDS.worker2],
    ].filter(
      (action) => action?.type === "MOVE" && action.direction === "RIGHT",
    );
    expect(movesIntoPatch).toHaveLength(2);
  });

  it("recalls the nearest empty Worker before a lower-id explorer", () => {
    const result = planTick(
      10,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [1, 0]),
        unit(IDS.worker2, "WORKER", [3, 0]),
        { kind: "RESOURCE", positions: [[3, 0]] },
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );

    expect(result.plan.unit_actions?.[IDS.worker2]).toEqual({
      type: "HARVEST",
    });
    expect(result.plan.unit_actions?.[IDS.worker1]?.type).not.toBe("HARVEST");
  });

  it("assigns three nearest empty Workers to three newly visible resources", () => {
    const worker4 = "00000000-0000-4000-8000-000000000014";
    const result = planTick(
      10,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [1, 0]),
        unit(IDS.worker2, "WORKER", [0, 1]),
        unit(IDS.worker3, "WORKER", [-1, 0]),
        unit(worker4, "WORKER", [0, -1]),
        {
          kind: "RESOURCE",
          positions: [
            [1, 0],
            [0, 1],
            [-1, 0],
          ],
        },
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );
    const actions = result.plan.unit_actions ?? {};

    expect(
      Object.values(actions).filter((action) => action.type === "HARVEST"),
    ).toHaveLength(3);
    expect(actions[worker4]?.type).toBe("MOVE");
  });

  it("uses safe route distance instead of distance through an obstacle", () => {
    const explored: Record<string, Position> = {};
    for (let x = -4; x <= 4; x += 1) {
      for (let y = -4; y <= 4; y += 1) explored[`${x},${y}`] = [x, y];
    }
    const result = planTick(
      10,
      state([
        core({ position: [-3, 0] }),
        unit(IDS.worker1, "WORKER", [0, 0]),
        unit(IDS.worker2, "WORKER", [2, 3]),
        { kind: "OBSTACLE", positions: [[1, 0]] },
        { kind: "RESOURCE", positions: [[2, 0]] },
      ]),
      {
        ...emptyMemory(),
        explored,
        posture: "HOLD",
        postureSinceTick: 1,
      },
    );

    expect(result.plan.unit_actions?.[IDS.worker2]).toEqual({
      type: "MOVE",
      direction: "UP",
    });
  });

  it("minimizes total route distance across the whole harvest assignment", () => {
    const explored: Record<string, Position> = {};
    for (let x = -2; x <= 6; x += 1) explored[`${x},0`] = [x, 0];
    const result = planTick(
      10,
      state([
        core({ position: [-1, 0] }),
        unit(IDS.worker1, "WORKER", [0, 0]),
        unit(IDS.worker2, "WORKER", [3, 0]),
        {
          kind: "RESOURCE",
          positions: [
            [2, 0],
            [4, 0],
          ],
        },
      ]),
      {
        ...emptyMemory(),
        explored,
        posture: "HOLD",
        postureSinceTick: 1,
      },
    );

    expect(result.plan.unit_actions?.[IDS.worker1]).toEqual({
      type: "MOVE",
      direction: "RIGHT",
    });
    expect(result.plan.unit_actions?.[IDS.worker2]).toEqual({
      type: "MOVE",
      direction: "RIGHT",
    });
  });

  it("does not assign a visible resource to a boxed-in Worker", () => {
    const explored: Record<string, Position> = {};
    for (let x = -4; x <= 4; x += 1) {
      for (let y = -4; y <= 4; y += 1) explored[`${x},${y}`] = [x, y];
    }
    const result = planTick(
      10,
      state([
        core({ position: [-3, -3] }),
        unit(IDS.worker1, "WORKER", [0, 0]),
        unit(IDS.worker2, "WORKER", [3, 2]),
        {
          kind: "OBSTACLE",
          positions: [
            [-1, 0],
            [1, 0],
            [0, -1],
            [0, 1],
          ],
        },
        { kind: "RESOURCE", positions: [[0, 2]] },
      ]),
      {
        ...emptyMemory(),
        explored,
        posture: "HOLD",
        postureSinceTick: 1,
      },
    );

    expect(result.plan.unit_actions?.[IDS.worker2]).toEqual({
      type: "MOVE",
      direction: "LEFT",
    });
  });

  it("local seer keeps a visible crystal instead of vision-rim orbiting", () => {
    const crystal: Position = [-3, -1];
    const left: Position = [-2, 0];
    const right: Position = [4, 2];
    const rocks: Position[] = [
      [-2, -1],
      [-3, 0],
    ];
    // Left only has a local vision blob; right has a long explored highway.
    const explored: Record<string, Position> = {};
    for (let x = -5; x <= 0; x += 1) {
      for (let y = -3; y <= 2; y += 1) {
        if (Math.abs(x - left[0]) + Math.abs(y - left[1]) <= 3) {
          explored[`${x},${y}`] = [x, y];
        }
      }
    }
    for (let x = 0; x <= 6; x += 1) {
      for (let y = 0; y <= 3; y += 1) explored[`${x},${y}`] = [x, y];
    }
    for (let x = -3; x <= 4; x += 1) explored[`${x},2`] = [x, 2];
    let memory = {
      ...emptyMemory(),
      explored,
      workerExplored: { ...explored },
      posture: "ECONOMY" as const,
      postureSinceTick: 1,
      obstacles: Object.fromEntries(rocks.map((r) => [`${r[0]},${r[1]}`, r])),
    };
    let pos: Position = left;
    let harvested = false;
    const owners: string[] = [];
    for (let tick = 30; tick < 55; tick += 1) {
      const result = planTick(
        tick,
        state([
          core({ position: [0, 0] }),
          unit(IDS.worker1, "WORKER", pos),
          unit(IDS.worker2, "WORKER", right),
          { kind: "OBSTACLE", positions: rocks },
          { kind: "RESOURCE", positions: [crystal] },
        ]),
        memory,
      );
      memory = result.memory as typeof memory;
      const goal1 = memory.workerHarvestGoal?.[IDS.worker1];
      const goal2 = memory.workerHarvestGoal?.[IDS.worker2];
      if (goal1) owners.push("left");
      else if (goal2) owners.push("right");
      const action = result.plan.unit_actions?.[IDS.worker1];
      if (action?.type === "MOVE") pos = nextPosition(pos, action.direction);
      if (action?.type === "HARVEST") {
        harvested = true;
        break;
      }
    }
    expect(owners[0]).toBe("left");
    expect(harvested).toBe(true);
  });

  it("paths around a diagonal rock pocket to a visible crystal", () => {
    const crystal: Position = [-1, -1];
    const rocks: Position[] = [
      [0, -1],
      [-1, 0],
      [0, 1],
      [1, 1],
      [-2, -1],
      [1, -2],
      [2, 0],
    ];
    const explored: Record<string, Position> = {};
    for (let x = -4; x <= 6; x += 1) {
      for (let y = -4; y <= 4; y += 1) explored[`${x},${y}`] = [x, y];
    }
    let memory = {
      ...emptyMemory(),
      explored,
      workerExplored: { ...explored },
      posture: "ECONOMY" as const,
      postureSinceTick: 1,
      workerDutyScoutUntil: { [IDS.worker1]: 200 },
      obstacles: Object.fromEntries(rocks.map((r) => [`${r[0]},${r[1]}`, r])),
    };
    let pos: Position = [0, 0];
    const actions: string[] = [];
    let harvested = false;
    for (let tick = 10; tick < 40; tick += 1) {
      const result = planTick(
        tick,
        state([
          core({ position: [3, 0] }),
          unit(IDS.worker1, "WORKER", pos),
          unit(IDS.worker2, "WORKER", [5, 2]),
          { kind: "OBSTACLE", positions: rocks },
          { kind: "RESOURCE", positions: [crystal] },
        ]),
        memory,
      );
      memory = result.memory as typeof memory;
      const action = result.plan.unit_actions?.[IDS.worker1];
      if (action?.type === "MOVE") {
        actions.push(action.direction);
        pos = nextPosition(pos, action.direction);
      } else if (action?.type === "HARVEST") {
        harvested = true;
        break;
      } else actions.push(action?.type ?? "NONE");
    }
    expect(harvested).toBe(true);
    expect(actions[0]).not.toBe("DOWN");
    for (let i = 1; i < actions.length; i += 1) {
      const opp: Record<string, string> = {
        UP: "DOWN",
        DOWN: "UP",
        LEFT: "RIGHT",
        RIGHT: "LEFT",
      };
      expect(opp[actions[i - 1]!] === actions[i]).toBe(false);
    }
  });

  it("does not reverse-bob in a rock corridor toward a visible crystal", () => {
    const explored: Record<string, Position> = {};
    // Vertical corridor of explored cells plus a side path to the crystal.
    for (let y = -3; y <= 2; y += 1) explored[`0,${y}`] = [0, y];
    for (let x = 0; x <= 4; x += 1) explored[`${x},0`] = [x, 0];
    explored["-2,-2"] = [-2, -2];
    explored["-1,0"] = [-1, 0];
    explored["1,0"] = [1, 0];
    const rocks: Position[] = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
      [-1, -2],
      [1, -2],
      [-2, -1],
      [-2, 0],
      [-3, -2],
      [-2, -3],
    ];
    let memory = {
      ...emptyMemory(),
      explored,
      workerExplored: { ...explored },
      posture: "ECONOMY" as const,
      postureSinceTick: 1,
      workerDutyScoutUntil: { [IDS.worker1]: 120 },
      obstacles: Object.fromEntries(rocks.map((r) => [`${r[0]},${r[1]}`, r])),
    };
    let pos: Position = [0, 0];
    const actions: string[] = [];
    for (let tick = 50; tick < 62; tick += 1) {
      const result = planTick(
        tick,
        state([
          core({ position: [4, 0] }),
          unit(IDS.worker1, "WORKER", pos),
          unit(IDS.worker2, "WORKER", [5, 1]),
          { kind: "OBSTACLE", positions: rocks },
          { kind: "RESOURCE", positions: [[-2, -2]] },
        ]),
        memory,
      );
      memory = result.memory as typeof memory;
      const action = result.plan.unit_actions?.[IDS.worker1];
      if (action?.type === "MOVE") {
        actions.push(action.direction);
        pos = nextPosition(pos, action.direction);
      } else if (action?.type === "HARVEST") {
        actions.push("HARVEST");
        break;
      } else {
        actions.push(action?.type ?? "NONE");
      }
    }
    for (let i = 1; i < actions.length; i += 1) {
      const prev = actions[i - 1];
      const cur = actions[i];
      const opp: Record<string, string> = {
        UP: "DOWN",
        DOWN: "UP",
        LEFT: "RIGHT",
        RIGHT: "LEFT",
      };
      expect(opp[prev!] === cur).toBe(false);
    }
  });

  it("reaches a visible crystal under progressive FOW without reverse thrash", () => {
    // Screenshot-class pocket: crystal NW, UP+LEFT walled. Hidden rocks break
    // any fog-as-empty shortcut; worker must expand known cells toward the goal.
    const crystal: Position = [-1, -1];
    const visibleRocks: Position[] = [
      [0, -1],
      [-1, 0],
    ];
    const hiddenRocks: Position[] = [
      [1, -1],
      [2, -1],
      [-2, -1],
      [-2, 0],
      [0, 2],
      [-1, 1],
    ];
    const allRocks = [...visibleRocks, ...hiddenRocks];
    const visionAround = (
      center: Position,
      radius = 3,
    ): Record<string, Position> => {
      const explored: Record<string, Position> = {};
      for (let x = center[0] - radius; x <= center[0] + radius; x += 1) {
        for (let y = center[1] - radius; y <= center[1] + radius; y += 1) {
          if (distance(center, [x, y]) <= radius)
            explored[`${x},${y}`] = [x, y];
        }
      }
      // Core vision blob so assignment/economy stay peacetime.
      for (let x = 2; x <= 5; x += 1) {
        for (let y = -1; y <= 2; y += 1) {
          if (distance([3, 0], [x, y]) <= 3) explored[`${x},${y}`] = [x, y];
        }
      }
      return explored;
    };
    let pos: Position = [0, 0];
    let memory = {
      ...emptyMemory(),
      explored: visionAround(pos),
      workerExplored: visionAround(pos),
      posture: "ECONOMY" as const,
      postureSinceTick: 1,
      workerDutyScoutUntil: { [IDS.worker1]: 200 },
      obstacles: Object.fromEntries(
        visibleRocks.map((rock) => [`${rock[0]},${rock[1]}`, rock] as const),
      ),
    };
    const actions: string[] = [];
    let harvested = false;
    for (let tick = 5; tick < 70; tick += 1) {
      // Reveal rocks as vision expands �� mirrors live FOW obstacle discovery.
      for (const rock of allRocks) {
        if (memory.explored[`${rock[0]},${rock[1]}`]) {
          memory.obstacles[`${rock[0]},${rock[1]}`] = rock;
        }
      }
      const viewRocks = allRocks.filter(
        (rock) => memory.explored[`${rock[0]},${rock[1]}`],
      );
      const result = planTick(
        tick,
        state([
          core({ position: [3, 0] }),
          unit(IDS.worker1, "WORKER", pos),
          unit(IDS.worker2, "WORKER", [5, 2]),
          { kind: "OBSTACLE", positions: viewRocks },
          { kind: "RESOURCE", positions: [crystal] },
        ]),
        memory,
      );
      memory = result.memory as typeof memory;
      const action = result.plan.unit_actions?.[IDS.worker1];
      if (action?.type === "MOVE") {
        actions.push(action.direction);
        pos = nextPosition(pos, action.direction);
        // Expand explored like worker vision after the step.
        const gained = visionAround(pos, 3);
        memory.explored = { ...memory.explored, ...gained };
        memory.workerExplored = { ...memory.workerExplored, ...gained };
        for (const rock of allRocks) {
          if (memory.explored[`${rock[0]},${rock[1]}`]) {
            memory.obstacles[`${rock[0]},${rock[1]}`] = rock;
          }
        }
      } else if (action?.type === "HARVEST") {
        actions.push("HARVEST");
        harvested = true;
        break;
      } else {
        actions.push(action?.type ?? "NONE");
      }
    }
    expect(harvested).toBe(true);
    let reversePairs = 0;
    const opp: Record<string, string> = {
      UP: "DOWN",
      DOWN: "UP",
      LEFT: "RIGHT",
      RIGHT: "LEFT",
    };
    for (let i = 1; i < actions.length; i += 1) {
      if (opp[actions[i - 1] ?? ""] === actions[i]) reversePairs += 1;
    }
    expect(reversePairs).toBe(0);
  });

  it("harvests a visible crystal instead of duty-scout vision oscillation", () => {
    const explored: Record<string, Position> = {};
    for (let x = -3; x <= 3; x += 1) {
      for (let y = -3; y <= 3; y += 1) explored[`${x},${y}`] = [x, y];
    }
    const result = planTick(
      40,
      state([
        core({ position: [0, -8] }),
        unit(IDS.worker1, "WORKER", [0, 0]),
        unit(IDS.vanguard, "VANGUARD", [0, -7]),
        unit(IDS.ranger, "RANGER", [1, -7]),
        unit("v2", "VANGUARD", [-1, -7]),
        {
          kind: "OBSTACLE",
          positions: [
            [-1, 0],
            [1, 0],
            [0, -2],
            [2, -2],
            [1, 1],
          ],
        },
        { kind: "RESOURCE", positions: [[1, 2]] },
      ]),
      {
        ...emptyMemory(),
        explored,
        workerExplored: explored,
        posture: "ECONOMY",
        postureSinceTick: 1,
        // Sticky duty scout used to ignore the crystal and bob UP/DOWN in vision.
        workerDutyScoutUntil: { [IDS.worker1]: 80 },
      },
    );
    expect(result.plan.unit_actions?.[IDS.worker1]).toEqual({
      type: "MOVE",
      direction: "DOWN",
    });
    expect(result.memory.workerDutyScoutUntil?.[IDS.worker1]).toBeUndefined();
  });

  it("does not greedily bob toward a fully enclosed visible resource", () => {
    const explored: Record<string, Position> = {};
    for (let x = -3; x <= 4; x += 1) {
      for (let y = -3; y <= 3; y += 1) explored[`${x},${y}`] = [x, y];
    }
    const result = planTick(
      41,
      state([
        core({ position: [-2, -2] }),
        unit(IDS.worker1, "WORKER", [0, 0]),
        {
          kind: "OBSTACLE",
          positions: [
            // Fully seal the crystal so no walk reaches it.
            [1, 0],
            [2, -1],
            [2, 1],
            [3, 0],
          ],
        },
        { kind: "RESOURCE", positions: [[2, 0]] },
      ]),
      {
        ...emptyMemory(),
        explored,
        posture: "HOLD",
        postureSinceTick: 1,
      },
    );
    // Must not get a requireGoal harvest march (unreachable). Exploration is ok,
    // but the old greedy findStep bob toward the wall is not.
    const action = result.plan.unit_actions?.[IDS.worker1];
    if (action?.type === "MOVE") {
      // Moving into the sealing rock is never correct.
      expect(action.direction).not.toBe("RIGHT");
    }
  });

  it("abandons a resource that a visible enemy can contest next Tick", () => {
    const result = planTick(
      10,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [2, 0]),
        unit(IDS.enemyWorker, "WORKER", [3, 1], { controlled: false }),
        { kind: "RESOURCE", positions: [[3, 0]] },
      ]),
      {
        ...emptyMemory(),
        explored: exploredDiamond([0, 0], 5),
        posture: "ECONOMY",
        postureSinceTick: 1,
      },
    );

    expect(result.plan.unit_actions?.[IDS.worker1]).not.toEqual({
      type: "MOVE",
      direction: "RIGHT",
    });
  });

  it("allows a Unit to move into a friendly cell with one free slot", () => {
    const result = planTick(
      11,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [2, 0], { cargo: 1 }),
        unit(IDS.worker2, "WORKER", [1, 0]),
      ]),
      emptyMemory(),
    );
    expect(result.plan.unit_actions?.[IDS.worker1]).toEqual({
      type: "MOVE",
      direction: "LEFT",
    });
  });

  it("deposits co-located cargo and routes another return to a Core staging cell", () => {
    const result = planTick(
      11,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [0, 0], { cargo: 1 }),
        unit(IDS.worker2, "WORKER", [2, 0], { cargo: 1 }),
      ]),
      emptyMemory(),
    );
    expect(result.plan.unit_actions?.[IDS.worker1]).toEqual({
      type: "DEPOSIT",
    });
    expect(result.plan.unit_actions?.[IDS.worker2]).toEqual({
      type: "MOVE",
      direction: "LEFT",
    });
  });

  it("holds loaded cargo outside a Core cell under direct melee fire", () => {
    const result = planTick(
      20,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [0, -1], { cargo: 1 }),
        unit(IDS.enemyVanguard, "VANGUARD", [0, 1], {
          controlled: false,
        }),
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );

    expect(result.plan.unit_actions?.[IDS.worker1]).not.toEqual({
      type: "MOVE",
      direction: "DOWN",
    });
    expect(result.plan.unit_actions?.[IDS.worker1]).not.toEqual({
      type: "DEPOSIT",
    });
  });

  it("prioritizes an emergency defender over soft shield repair under threat", () => {
    const enemy = unit(IDS.enemyVanguard, "VANGUARD", [2, 0], {
      controlled: false,
    });
    const result = planTick(
      12,
      state([core({ shield: 2 }), unit(IDS.worker1, "WORKER", [0, 0]), enemy], {
        resources: 10,
      }),
      emptyMemory(),
    );
    expect(result.summary.threatened).toBe(true);
    expect(result.summary.reserve).toBe(0);
    // Soft shield damage must not block the first combat spawn when no defenders exist.
    expect(result.plan.core_action).toEqual({
      type: "SPAWN",
      unit_type: "VANGUARD",
    });
    expect(result.summary.posture).not.toBe("CONTEST");
  });

  it("repairs critically broken shields before non-combat spending", () => {
    const enemy = unit(IDS.enemyVanguard, "VANGUARD", [2, 0], {
      controlled: false,
    });
    const result = planTick(
      12,
      state(
        [
          core({ shield: 0 }),
          unit(IDS.worker1, "WORKER", [1, 0]),
          unit(IDS.vanguard, "VANGUARD", [0, 1]),
          enemy,
        ],
        { resources: 4 },
      ),
      emptyMemory(),
    );
    expect(result.summary.threatened).toBe(true);
    expect(result.plan.core_action).toEqual({ type: "REPAIR_SHIELD" });
  });

  it("lets a Ranger shoot through an occupied intermediate cell in v0.7", () => {
    const objects: WorldObject[] = [
      core(),
      unit(IDS.vanguard, "VANGUARD", [0, 1]),
      unit(IDS.ranger, "RANGER", [0, 0]),
      unit(IDS.enemyWorker, "WORKER", [0, 2], { controlled: false }),
    ];
    const result = planTick(13, state(objects), emptyMemory());
    expect(result.plan.unit_actions?.[IDS.ranger]).toEqual({
      type: "SHOOT",
      target_id: IDS.enemyWorker,
      expected_cell: [0, 2],
    });
  });

  it("fires immediately at an unguarded enemy Worker on a resource corridor", () => {
    const result = planTick(
      14,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [1, 0]),
        unit(IDS.vanguard, "VANGUARD", [1, 1]),
        unit(IDS.ranger, "RANGER", [0, 0]),
        unit(IDS.enemyWorker, "WORKER", [0, 3], { controlled: false }),
        { kind: "RESOURCE", positions: [[0, 4]] },
      ]),
      emptyMemory(),
    );
    expect(result.plan.unit_actions?.[IDS.ranger]).toEqual({
      type: "SHOOT",
      target_id: IDS.enemyWorker,
      expected_cell: [0, 3],
    });
  });

  it("does not chase a guarded enemy Worker from a local disadvantage", () => {
    const result = planTick(
      15,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [1, 0]),
        unit(IDS.vanguard, "VANGUARD", [1, 1]),
        unit(IDS.enemyWorker, "WORKER", [4, 0], { controlled: false }),
        unit(IDS.enemyVanguard, "VANGUARD", [4, 1], { controlled: false }),
        unit("00000000-0000-4000-8000-000000000122", "VANGUARD", [5, 0], {
          controlled: false,
        }),
        { kind: "RESOURCE", positions: [[4, 0]] },
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );
    expect(result.memory.roles[IDS.vanguard]?.anchor).not.toEqual([4, 0]);
  });

  it("rallies a separated combat group before advancing", () => {
    const explored: Record<string, Position> = {};
    for (let x = -3; x <= 16; x += 1) {
      for (let y = -4; y <= 4; y += 1) explored[`${x},${y}`] = [x, y];
    }
    const ranger2 = "00000000-0000-4000-8000-000000000032";
    const reserveVanguard = "00000000-0000-4000-8000-000000000022";
    const reserveVanguard2 = "00000000-0000-4000-8000-000000000023";
    const result = planTick(
      30,
      state([
        core(),
        unit(reserveVanguard, "VANGUARD", [0, 1]),
        unit(reserveVanguard2, "VANGUARD", [1, 1]),
        unit(IDS.vanguard, "VANGUARD", [4, 0]),
        unit(IDS.ranger, "RANGER", [-2, 3]),
        unit(ranger2, "RANGER", [-2, -3]),
        unit(IDS.enemyCore, "VANGUARD", [14, 0], { controlled: false }),
      ]),
      {
        ...emptyMemory(),
        explored,
        posture: "CONTEST",
        postureSinceTick: 29,
      },
    );

    expect(result.memory.roles[IDS.vanguard]?.kind).toBe("RALLY");
    expect(result.memory.roles[IDS.ranger]?.kind).toBe("RALLY");
    expect(result.memory.roles[ranger2]?.kind).toBe("RALLY");
  });

  it("advances with a Vanguard screen and separated Ranger support", () => {
    const explored: Record<string, Position> = {};
    for (let x = -3; x <= 16; x += 1) {
      for (let y = -4; y <= 4; y += 1) explored[`${x},${y}`] = [x, y];
    }
    const ranger2 = "00000000-0000-4000-8000-000000000032";
    const reserveVanguard = "00000000-0000-4000-8000-000000000022";
    const reserveVanguard2 = "00000000-0000-4000-8000-000000000023";
    const result = planTick(
      31,
      state([
        core(),
        unit(reserveVanguard, "VANGUARD", [0, 1]),
        unit(reserveVanguard2, "VANGUARD", [1, 1]),
        unit(IDS.vanguard, "VANGUARD", [7, 0]),
        unit(IDS.ranger, "RANGER", [7, -2]),
        unit(ranger2, "RANGER", [7, 2]),
        unit(IDS.enemyCore, "VANGUARD", [14, 0], { controlled: false }),
      ]),
      {
        ...emptyMemory(),
        explored,
        posture: "CONTEST",
        postureSinceTick: 30,
        roles: {
          [IDS.vanguard]: {
            kind: "ADVANCE",
            anchor: [14, 0],
            sinceTick: 30,
          },
          [IDS.ranger]: {
            kind: "ADVANCE",
            anchor: [14, 0],
            sinceTick: 30,
          },
          [ranger2]: {
            kind: "ADVANCE",
            anchor: [14, 0],
            sinceTick: 30,
          },
        },
      },
    );

    expect(result.memory.roles[IDS.vanguard]).toMatchObject({
      kind: "ADVANCE",
      anchor: [14, 0],
    });
    expect(result.memory.roles[IDS.ranger]).toMatchObject({
      kind: "ADVANCE",
      anchor: [14, 0],
    });
    expect(result.memory.roles[ranger2]).toMatchObject({
      kind: "ADVANCE",
      anchor: [14, 0],
    });
    const nextCell = (id: string, position: Position): Position => {
      const action = result.plan.unit_actions?.[id];
      if (action?.type !== "MOVE") return position;
      return nextPosition(position, action.direction);
    };
    expect(nextCell(IDS.ranger, [7, -2])).not.toEqual(
      nextCell(ranger2, [7, 2]),
    );
  });

  it.each([
    {
      label: "below",
      target: [0, 14] as Position,
      vanguard: [0, 12] as Position,
      rangerLeft: [-1, 11] as Position,
      rangerRight: [1, 11] as Position,
      direction: "DOWN" as const,
      frontIsAhead: (frontY: number, rearY: number) => frontY > rearY,
    },
    {
      label: "above",
      target: [0, -14] as Position,
      vanguard: [0, -12] as Position,
      rangerLeft: [-1, -11] as Position,
      rangerRight: [1, -11] as Position,
      direction: "UP" as const,
      frontIsAhead: (frontY: number, rearY: number) => frontY < rearY,
    },
  ])(
    "preserves vertical front and rear depth when the objective is $label",
    ({
      target,
      vanguard,
      rangerLeft,
      rangerRight,
      direction,
      frontIsAhead,
    }) => {
      const explored: Record<string, Position> = {};
      for (let x = -4; x <= 4; x += 1) {
        for (let y = -16; y <= 16; y += 1) explored[`${x},${y}`] = [x, y];
      }
      const ranger2 = "00000000-0000-4000-8000-000000000032";
      const reserveVanguard = "00000000-0000-4000-8000-000000000022";
      const reserveVanguard2 = "00000000-0000-4000-8000-000000000023";
      const result = planTick(
        31,
        state([
          core(),
          unit(reserveVanguard, "VANGUARD", [-1, 0]),
          unit(reserveVanguard2, "VANGUARD", [1, 0]),
          unit(IDS.vanguard, "VANGUARD", vanguard),
          unit(IDS.ranger, "RANGER", rangerLeft),
          unit(ranger2, "RANGER", rangerRight),
          unit(IDS.enemyCore, "VANGUARD", target, { controlled: false }),
        ]),
        {
          ...emptyMemory(),
          explored,
          posture: "CONTEST",
          postureSinceTick: 30,
          roles: {
            [IDS.vanguard]: {
              kind: "ADVANCE",
              anchor: target,
              sinceTick: 30,
            },
            [IDS.ranger]: {
              kind: "ADVANCE",
              anchor: target,
              sinceTick: 30,
            },
            [ranger2]: {
              kind: "ADVANCE",
              anchor: target,
              sinceTick: 30,
            },
          },
        },
      );

      expect(result.plan.unit_actions?.[IDS.vanguard]).toEqual({
        type: "MOVE",
        direction,
      });
      const vanguardNext = nextPosition(vanguard, direction);
      expect(frontIsAhead(vanguardNext[1], rangerLeft[1])).toBe(true);
      expect(frontIsAhead(vanguardNext[1], rangerRight[1])).toBe(true);
      expect(result.memory.roles[IDS.ranger]?.kind).toBe("ADVANCE");
      expect(result.memory.roles[ranger2]?.kind).toBe("ADVANCE");
    },
  );

  it("makes an adjacent Ranger disengage before taking a shot", () => {
    const result = planTick(
      32,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [0, 1]),
        unit(IDS.ranger, "RANGER", [2, 0]),
        unit(IDS.enemyVanguard, "VANGUARD", [3, 0], { controlled: false }),
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );

    expect(result.plan.unit_actions?.[IDS.ranger]?.type).toBe("MOVE");
    expect(result.memory.roles[IDS.ranger]?.kind).toBe("WITHDRAW");
  });

  it("moves out of lethal locked-cell fire instead of standing to trade", () => {
    const result = planTick(
      32,
      state([
        core({ position: [-2, 0] }),
        unit(IDS.vanguard, "VANGUARD", [-1, 1]),
        unit(IDS.ranger, "RANGER", [0, 0]),
        unit(IDS.enemyVanguard, "RANGER", [3, 0], { controlled: false }),
        unit("00000000-0000-4000-8000-000000000123", "RANGER", [0, 3], {
          controlled: false,
        }),
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );

    expect(result.plan.unit_actions?.[IDS.ranger]?.type).toBe("MOVE");
    expect(result.memory.roles[IDS.ranger]?.kind).toBe("WITHDRAW");
  });

  it("finishes a direct Core attacker instead of evading lethal return fire", () => {
    const finisher = "00000000-0000-4000-8000-000000000022";
    const secondEnemy = "00000000-0000-4000-8000-000000000122";
    const result = planTick(
      32,
      state([
        core({ shield: 0, hp: 3 }),
        unit(IDS.vanguard, "VANGUARD", [1, 1]),
        unit(finisher, "VANGUARD", [0, 0], { hp: 2 }),
        unit(IDS.enemyVanguard, "VANGUARD", [0, 1], {
          controlled: false,
          hp: 2,
        }),
        unit(secondEnemy, "VANGUARD", [0, 1], {
          controlled: false,
          hp: 2,
        }),
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );

    expect(result.plan.unit_actions?.[IDS.vanguard]).toEqual({
      type: "SWEEP",
      direction: "LEFT",
    });
    expect(result.plan.unit_actions?.[finisher]).toEqual({
      type: "SWEEP",
      direction: "DOWN",
    });
    expect(result.memory.roles[finisher]?.kind).toBe("CORE_DEFENSE");
  });

  it("trades into a Core-adjacent melee instead of lethally withdrawing", () => {
    const result = planTick(
      34,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [0, 0], { hp: 2 }),
        unit(IDS.enemyVanguard, "VANGUARD", [0, 1], {
          controlled: false,
          hp: 4,
        }),
        unit("00000000-0000-4000-8000-000000000124", "RANGER", [0, 3], {
          controlled: false,
          hp: 2,
        }),
        unit("00000000-0000-4000-8000-000000000125", "RANGER", [3, 0], {
          controlled: false,
          hp: 2,
        }),
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );

    expect(result.plan.unit_actions?.[IDS.vanguard]).toEqual({
      type: "SWEEP",
      direction: "DOWN",
    });
    expect(result.memory.roles[IDS.vanguard]?.kind).toBe("CORE_DEFENSE");
  });

  it("parks combat units on the Core ring under residual multiwave pressure", () => {
    const secondVanguard = "00000000-0000-4000-8000-000000000032";
    const farVanguard = "00000000-0000-4000-8000-000000000033";
    const result = planTick(
      40,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [1, 0]),
        unit(IDS.ranger, "RANGER", [0, 1]),
        unit(secondVanguard, "VANGUARD", [-1, 0]),
        unit(farVanguard, "VANGUARD", [4, 0]),
        unit(IDS.worker1, "WORKER", [2, 0]),
      ]),
      {
        ...emptyMemory(),
        posture: "ECONOMY",
        postureSinceTick: 1,
        militaryPressureTicks: 8,
        explored: {
          "0,0": [0, 0],
          "1,0": [1, 0],
          "0,1": [0, 1],
          "-1,0": [-1, 0],
          "2,0": [2, 0],
          "3,0": [3, 0],
          "0,2": [0, 2],
          "0,-1": [0, -1],
          "4,0": [4, 0],
          "5,0": [5, 0],
          "6,0": [6, 0],
          "0,3": [0, 3],
          "0,4": [0, 4],
          "0,5": [0, 5],
          "0,6": [0, 6],
        },
      },
    );

    expect(result.summary.posture).toBe("HOLD");
    expect(result.plan.unit_actions?.[farVanguard]).toEqual({
      type: "MOVE",
      direction: "LEFT",
    });
    for (const id of [IDS.vanguard, IDS.ranger, secondVanguard, farVanguard]) {
      expect(result.memory.roles[id]?.kind).not.toBe("CONTROL_RALLY");
    }
  });

  it("contests near-Core side-adjacent melee even while a freefirer is live", () => {
    const freefirer = "00000000-0000-4000-8000-000000000341";
    const attacker = "00000000-0000-4000-8000-000000000342";
    const result = planTick(
      28,
      state([
        core(),
        // On the Core ring, beside an advancing melee; freefire is live but not
        // adjacent so we must still chip/cutoff the melee (RANGED seed 7).
        unit(IDS.vanguard, "VANGUARD", [1, 0]),
        unit(attacker, "VANGUARD", [1, 1], { controlled: false, hp: 4 }),
        unit(freefirer, "RANGER", [0, 3], { controlled: false, hp: 2 }),
      ]),
      {
        ...emptyMemory(),
        posture: "HOLD",
        postureSinceTick: 1,
        enemies: {
          [attacker]: {
            id: attacker,
            kind: "UNIT",
            unitType: "VANGUARD",
            position: [1, 2],
            hp: 4,
            lastSeenTick: 27,
            lastMove: "UP",
            movementStreak: 2,
          },
        },
      },
    );

    const action = result.plan.unit_actions?.[IDS.vanguard];
    expect(action).toBeDefined();
    // Either sweep the melee now or cutoff-step onto its predicted cell.
    if (action?.type === "SWEEP") {
      expect(["UP", "DOWN", "LEFT", "RIGHT"]).toContain(action.direction);
    } else {
      expect(action).toMatchObject({ type: "MOVE" });
    }
    expect(result.memory.roles[IDS.vanguard]?.kind).toBe("CORE_DEFENSE");
  });

  it("cutoffs advancing melee under freefire when not freefire-adjacent", () => {
    const freefirer = "00000000-0000-4000-8000-000000000351";
    const attacker = "00000000-0000-4000-8000-000000000352";
    const result = planTick(
      29,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [2, 0]),
        unit(attacker, "VANGUARD", [2, 1], { controlled: false, hp: 3 }),
        unit(freefirer, "RANGER", [0, 3], { controlled: false, hp: 2 }),
      ]),
      {
        ...emptyMemory(),
        posture: "HOLD",
        postureSinceTick: 1,
        enemies: {
          [attacker]: {
            id: attacker,
            kind: "UNIT",
            unitType: "VANGUARD",
            position: [2, 2],
            hp: 3,
            lastSeenTick: 28,
            lastMove: "UP",
            movementStreak: 2,
          },
        },
      },
    );

    const action = result.plan.unit_actions?.[IDS.vanguard];
    // Not adjacent to freefire: cutoff may MOVE onto the predicted cell, or
    // near-core adjacent rules may SWEEP. Must not ignore the melee entirely
    // by pathing only at the distant freefirer.
    expect(action?.type === "SWEEP" || action?.type === "MOVE").toBe(true);
    if (action?.type === "MOVE") {
      // Predicted cell is [2,0] (unit tile) or step closer to core/intercept —
      // importantly not a pure west march that abandons the melee lane.
      expect(action.direction).not.toBe("LEFT");
    }
  });

  it("prioritizes an enemy Ranger that can immediately damage the Core", () => {
    const result = planTick(
      33,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [1, 1]),
        unit(IDS.ranger, "RANGER", [0, 1]),
        unit(IDS.enemyVanguard, "VANGUARD", [1, 0], { controlled: false }),
        unit("00000000-0000-4000-8000-000000000123", "RANGER", [0, -2], {
          controlled: false,
        }),
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );

    expect(result.plan.unit_actions?.[IDS.ranger]).toMatchObject({
      type: "SHOOT",
      target_id: "00000000-0000-4000-8000-000000000123",
    });
  });

  it("intercepts direct Ranger fire before a nearer moving melee threat", () => {
    const directRanger = "00000000-0000-4000-8000-000000000123";
    const result = planTick(
      34,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [1, 0]),
        unit(IDS.enemyVanguard, "VANGUARD", [1, -2], {
          controlled: false,
        }),
        unit(directRanger, "RANGER", [3, 0], { controlled: false }),
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );

    expect(result.plan.unit_actions?.[IDS.vanguard]).toEqual({
      type: "MOVE",
      direction: "RIGHT",
    });
  });

  it("sweeps concentrated ranged Core fire before an adjacent melee attacker", () => {
    const secondRanger = "00000000-0000-4000-8000-000000000123";
    const result = planTick(
      33,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [0, 2]),
        unit(IDS.enemyVanguard, "VANGUARD", [0, 1], { controlled: false }),
        unit(IDS.enemyWorker, "RANGER", [0, 3], { controlled: false }),
        unit(secondRanger, "RANGER", [0, 3], { controlled: false }),
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );

    expect(result.plan.unit_actions?.[IDS.vanguard]).toEqual({
      type: "SWEEP",
      direction: "DOWN",
    });
  });

  it("splits Ranger fire after allocating lethal damage", () => {
    const ranger2 = "00000000-0000-4000-8000-000000000032";
    const enemy2 = "00000000-0000-4000-8000-000000000123";
    const result = planTick(
      32,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [0, 2]),
        unit(IDS.ranger, "RANGER", [0, -1]),
        unit(ranger2, "RANGER", [0, 1]),
        unit(IDS.enemyVanguard, "RANGER", [3, -1], {
          controlled: false,
          hp: 1,
        }),
        unit(enemy2, "RANGER", [3, 1], { controlled: false, hp: 2 }),
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );

    expect(result.plan.unit_actions?.[IDS.ranger]).toMatchObject({
      type: "SHOOT",
      target_id: IDS.enemyVanguard,
    });
    expect(result.plan.unit_actions?.[ranger2]).toMatchObject({
      type: "SHOOT",
      target_id: enemy2,
    });
  });

  it("leads a repeatedly advancing melee target by one cell", () => {
    const movingEnemy = unit(IDS.enemyVanguard, "VANGUARD", [3, 0], {
      controlled: false,
    });
    const result = planTick(
      42,
      state([core(), unit(IDS.ranger, "RANGER", [0, 0]), movingEnemy]),
      {
        ...emptyMemory(),
        enemies: {
          [IDS.enemyVanguard]: {
            id: IDS.enemyVanguard,
            kind: "UNIT",
            unitType: "VANGUARD",
            position: [4, 0],
            hp: 4,
            lastSeenTick: 41,
            lastMove: "LEFT",
            movementStreak: 1,
          },
        },
        posture: "HOLD",
        postureSinceTick: 1,
      },
    );

    expect(result.plan.unit_actions?.[IDS.ranger]).toEqual({
      type: "SHOOT",
      target_id: IDS.enemyVanguard,
      expected_cell: [2, 0],
    });
  });

  it("sweeps the predicted cell of an advancing melee target", () => {
    const result = planTick(
      42,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [-3, 0]),
        unit(IDS.enemyVanguard, "VANGUARD", [-5, 0], {
          controlled: false,
        }),
      ]),
      {
        ...emptyMemory(),
        enemies: {
          [IDS.enemyVanguard]: {
            id: IDS.enemyVanguard,
            kind: "UNIT",
            unitType: "VANGUARD",
            position: [-6, 0],
            hp: 4,
            lastSeenTick: 41,
            lastMove: "RIGHT",
            movementStreak: 1,
          },
        },
        posture: "HOLD",
        postureSinceTick: 1,
      },
    );

    expect(result.plan.unit_actions?.[IDS.vanguard]).toEqual({
      type: "SWEEP",
      direction: "LEFT",
    });
  });

  it("repositions instead of wasting Ranger fire on a moving Worker", () => {
    const result = planTick(
      42,
      state([
        core(),
        unit(IDS.ranger, "RANGER", [0, 0]),
        unit(IDS.enemyWorker, "WORKER", [3, 0], { controlled: false }),
      ]),
      {
        ...emptyMemory(),
        enemies: {
          [IDS.enemyWorker]: {
            id: IDS.enemyWorker,
            kind: "UNIT",
            unitType: "WORKER",
            position: [4, 0],
            hp: 2,
            lastSeenTick: 41,
          },
        },
        posture: "HOLD",
        postureSinceTick: 1,
      },
    );

    expect(result.plan.unit_actions?.[IDS.ranger]?.type).not.toBe("SHOOT");
  });

  it("keeps an unrefuted enemy Core as a long-range attack axis", () => {
    const rememberedCore = "40000000-0000-4000-8000-000000000001";
    const result = planTick(
      52,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [3, 0]),
        unit(IDS.ranger, "RANGER", [2, 1]),
      ]),
      {
        ...emptyMemory(),
        explored: exploredDiamond([0, 0], 12),
        enemies: {
          [rememberedCore]: {
            id: rememberedCore,
            kind: "CORE",
            position: [8, 0],
            hp: 3,
            lastSeenTick: 42,
          },
        },
        posture: "ATTACK",
        postureSinceTick: 50,
      },
    );

    expect(result.summary.posture).toBe("ATTACK");
    expect(
      Object.values(result.memory.roles).some(
        (role) =>
          (role.kind === "RALLY" || role.kind === "ADVANCE") &&
          role.anchor[0] === 8 &&
          role.anchor[1] === 0,
      ),
    ).toBe(true);
  });

  it("drops a remembered enemy Core when its visible cell is empty", () => {
    const rememberedCore = "40000000-0000-4000-8000-000000000001";
    const result = planTick(
      52,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [1, 0]),
        unit(IDS.ranger, "RANGER", [0, 1]),
      ]),
      {
        ...emptyMemory(),
        enemies: {
          [rememberedCore]: {
            id: rememberedCore,
            kind: "CORE",
            position: [4, 0],
            hp: 3,
            lastSeenTick: 51,
          },
        },
        posture: "ATTACK",
        postureSinceTick: 40,
      },
    );

    expect(result.memory.enemies[rememberedCore]).toBeUndefined();
    expect(result.summary.posture).not.toBe("ATTACK");
  });

  it("regroups after a completed attack before reopening map-control tasks", () => {
    const result = planTick(
      60,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [0, 9]),
        unit("00000000-0000-4000-8000-000000000022", "VANGUARD", [1, 9]),
        unit(IDS.ranger, "RANGER", [0, 8]),
      ]),
      {
        ...emptyMemory(),
        explored: exploredDiamond([0, 0], 12),
        posture: "ATTACK",
        postureSinceTick: 50,
      },
    );

    expect(result.summary.posture).toBe("REGROUP");
    expect(
      Object.values(result.memory.roles).some(
        (role) => role.kind === "WITHDRAW" || role.kind === "RESERVE",
      ),
    ).toBe(true);
  });

  it("recalls an overextended field force while recent pressure is remembered", () => {
    const result = planTick(
      61,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [0, 1]),
        unit(IDS.worker2, "WORKER", [-1, 0]),
        unit(IDS.worker3, "WORKER", [0, -1]),
        unit(IDS.vanguard, "VANGUARD", [9, 0]),
        unit("second-vanguard", "VANGUARD", [2, 0]),
        unit(IDS.ranger, "RANGER", [1, 1]),
        unit("second-ranger", "RANGER", [1, -1]),
      ]),
      {
        ...emptyMemory(),
        posture: "HOLD",
        postureSinceTick: 1,
        militaryPressureTicks: 6,
        explored: exploredDiamond([0, 0], 10),
      },
    );

    expect(result.summary.posture).toBe("REGROUP");
    expect(result.memory.roles[IDS.vanguard]?.kind).toBe("WITHDRAW");
    expect(result.plan.unit_actions?.[IDS.vanguard]).toEqual({
      type: "MOVE",
      direction: "LEFT",
    });
  });

  it("ends Beacon contest posture once a friendly Unit carries it", () => {
    const result = planTick(
      82,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [0, 1]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [0, -1]),
          unit(IDS.vanguard, "VANGUARD", [6, 0]),
          unit(IDS.ranger, "RANGER", [1, 0]),
        ],
        {
          resources: 20,
          champion_beacon: {
            position: [6, 0],
            status: "CARRIED",
            carrier_id: IDS.vanguard,
          },
        },
      ),
      { ...emptyMemory(), posture: "CONTEST", postureSinceTick: 1 },
    );

    expect(result.summary.posture).not.toBe("CONTEST");
    expect(
      Object.values(result.plan.unit_actions ?? {}).some(
        (action) => action.type === "PICKUP_BEACON",
      ),
    ).toBe(false);
  });

  it("keeps the Vanguard ahead of the Ranger during an organized withdrawal", () => {
    const enemies = Array.from({ length: 3 }, (_, index) =>
      unit(
        `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        "VANGUARD",
        [9, index - 1],
        { controlled: false },
      ),
    );
    const result = planTick(
      33,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [7, 0]),
        unit(IDS.ranger, "RANGER", [6, 1]),
        ...enemies,
      ]),
      { ...emptyMemory(), posture: "CONTEST", postureSinceTick: 1 },
    );

    expect(result.memory.roles[IDS.vanguard]?.kind).toBe("WITHDRAW");
    expect(result.memory.roles[IDS.ranger]?.kind).toBe("WITHDRAW");
    expect(
      distance(
        result.memory.roles[IDS.vanguard]?.anchor ?? [0, 0],
        enemies[0]?.position ?? [0, 0],
      ),
    ).toBeLessThan(
      distance(
        result.memory.roles[IDS.ranger]?.anchor ?? [0, 0],
        enemies[0]?.position ?? [0, 0],
      ),
    );
  });

  it("counterattacks a Core breach instead of continuing a strategic withdrawal", () => {
    const enemies = Array.from({ length: 5 }, (_, index) =>
      unit(
        `60000000-0000-4000-8000-${String(index + 30).padStart(12, "0")}`,
        index === 4 ? "RANGER" : "VANGUARD",
        [3 + Math.floor(index / 3), (index % 3) - 1],
        { controlled: false },
      ),
    );
    const result = planTick(
      34,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [1, 0]),
        unit(IDS.ranger, "RANGER", [0, -1]),
        ...enemies,
      ]),
      { ...emptyMemory(), posture: "CONTEST", postureSinceTick: 1 },
    );

    expect(result.summary.retreating).toBe(true);
    expect(result.memory.roles[IDS.vanguard]?.kind).toBe("CORE_DEFENSE");
    expect(result.memory.roles[IDS.ranger]?.kind).toBe("CORE_DEFENSE");
    expect(result.plan.unit_actions?.[IDS.vanguard]).toEqual({
      type: "MOVE",
      direction: "RIGHT",
    });
  });

  it("advances the screen and flanker against a ranged Core breach", () => {
    const flanker = "00000000-0000-4000-8000-000000000022";
    const secondRanger = "00000000-0000-4000-8000-000000000123";
    const result = planTick(
      34,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [0, 1]),
        unit(flanker, "VANGUARD", [-1, 2]),
        unit(IDS.ranger, "RANGER", [1, 0]),
        unit(IDS.enemyVanguard, "VANGUARD", [0, 3], { controlled: false }),
        unit(IDS.enemyWorker, "RANGER", [0, 3], { controlled: false }),
        unit(secondRanger, "RANGER", [-1, 4], { controlled: false }),
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );

    expect(result.plan.unit_actions?.[IDS.vanguard]).toEqual({
      type: "MOVE",
      direction: "DOWN",
    });
    expect(result.plan.unit_actions?.[flanker]).toEqual({
      type: "MOVE",
      direction: "DOWN",
    });
  });

  it("redirects spare interceptors after a nearer Core threat has lethal damage", () => {
    const secondVanguard = "00000000-0000-4000-8000-000000000032";
    const farRanger = "00000000-0000-4000-8000-000000000123";
    const result = planTick(
      34,
      state([
        core({ hp: 2, shield: 0 }),
        unit(IDS.vanguard, "VANGUARD", [0, 0]),
        unit(IDS.ranger, "RANGER", [-1, 1]),
        unit(secondVanguard, "VANGUARD", [1, 1]),
        unit(IDS.enemyWorker, "RANGER", [0, 1], {
          controlled: false,
          hp: 2,
        }),
        unit(farRanger, "RANGER", [3, 0], {
          controlled: false,
          hp: 2,
        }),
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );

    expect(result.plan.unit_actions?.[IDS.vanguard]).toEqual({
      type: "SWEEP",
      direction: "DOWN",
    });
    expect(result.plan.unit_actions?.[IDS.ranger]).toMatchObject({
      type: "SHOOT",
      target_id: IDS.enemyWorker,
    });
    const interceptorAction = result.plan.unit_actions?.[secondVanguard];
    expect(interceptorAction?.type).toBe("MOVE");
    if (interceptorAction?.type === "MOVE") {
      expect(
        distance(nextPosition([1, 1], interceptorAction.direction), [3, 0]),
      ).toBeLessThan(distance([1, 1], [3, 0]));
    }
  });

  it("shoots a live Core freefirer even when lead prediction lands on the Core", () => {
    const freefirer = "00000000-0000-4000-8000-000000000223";
    const result = planTick(
      34,
      state([
        core(),
        // Same row as the freefirer so the live cell is shootable, but leading it
        // onto the Core leaves the aim off-cardinal.
        unit(IDS.ranger, "RANGER", [3, 1]),
        unit(freefirer, "VANGUARD", [0, 1], { controlled: false, hp: 3 }),
      ]),
      {
        ...emptyMemory(),
        posture: "HOLD",
        postureSinceTick: 1,
        enemies: {
          [freefirer]: {
            id: freefirer,
            kind: "UNIT",
            unitType: "VANGUARD",
            position: [0, 2],
            hp: 3,
            lastSeenTick: 33,
            lastMove: "UP",
            movementStreak: 2,
          },
        },
      },
    );

    expect(result.plan.unit_actions?.[IDS.ranger]).toEqual({
      type: "SHOOT",
      target_id: freefirer,
      expected_cell: [0, 1],
    });
  });

  it("sweeps an advancing melee walking onto our near-Core tile", () => {
    const attacker = "00000000-0000-4000-8000-000000000331";
    const result = planTick(
      20,
      state([
        core(),
        // Defender already anchors near Core (d<=3): on-tile intercept should
        // sweep instead of stepping off for a cutoff (I5c multiwave-safe micro).
        unit(IDS.vanguard, "VANGUARD", [0, 2]),
        unit(attacker, "VANGUARD", [0, 3], { controlled: false, hp: 3 }),
      ]),
      {
        ...emptyMemory(),
        posture: "HOLD",
        postureSinceTick: 1,
        enemies: {
          [attacker]: {
            id: attacker,
            kind: "UNIT",
            unitType: "VANGUARD",
            position: [0, 4],
            hp: 3,
            lastSeenTick: 19,
            lastMove: "UP",
            movementStreak: 2,
          },
        },
      },
    );

    expect(result.plan.unit_actions?.[IDS.vanguard]).toEqual({
      type: "SWEEP",
      direction: "DOWN",
    });
  });

  it("keeps an adjacent free hit on a Core freefirer even if another unit already claimed it", () => {
    const secondVanguard = "00000000-0000-4000-8000-000000000032";
    const north = "00000000-0000-4000-8000-000000000221";
    const south = "00000000-0000-4000-8000-000000000222";
    const result = planTick(
      34,
      state([
        core(),
        // Far unit sorts first by id and would otherwise claim the northern freefirer.
        unit(secondVanguard, "VANGUARD", [3, -1]),
        unit(IDS.vanguard, "VANGUARD", [0, -2]),
        unit(north, "VANGUARD", [0, -1], { controlled: false, hp: 3 }),
        unit(south, "VANGUARD", [0, 1], { controlled: false, hp: 4 }),
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );

    expect(result.plan.unit_actions?.[IDS.vanguard]).toEqual({
      type: "SWEEP",
      direction: "DOWN",
    });
    const far = result.plan.unit_actions?.[secondVanguard];
    expect(far?.type).toBe("MOVE");
    if (far?.type === "MOVE") {
      expect(
        distance(nextPosition([3, -1], far.direction), [0, 1]),
      ).toBeLessThan(distance([3, -1], [0, 1]));
    }
  });

  it("splits moving interceptors across simultaneous direct Core attackers", () => {
    const secondVanguard = "00000000-0000-4000-8000-000000000032";
    const directRanger = "00000000-0000-4000-8000-000000000123";
    const result = planTick(
      34,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [4, -1]),
        unit(secondVanguard, "VANGUARD", [1, -1]),
        unit(IDS.enemyVanguard, "VANGUARD", [0, 1], {
          controlled: false,
        }),
        unit(directRanger, "RANGER", [3, 0], { controlled: false }),
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );

    const action = result.plan.unit_actions?.[secondVanguard];
    expect(action?.type).toBe("MOVE");
    if (action?.type === "MOVE") {
      expect(
        distance(nextPosition([1, -1], action.direction), [0, 1]),
      ).toBeLessThan(distance([1, -1], [0, 1]));
    }
  });

  it("cuts across a moving melee breach instead of sweeping its vacated cell", () => {
    const result = planTick(
      34,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [2, -2]),
        unit(IDS.enemyVanguard, "VANGUARD", [2, -1], {
          controlled: false,
        }),
      ]),
      {
        ...emptyMemory(),
        posture: "HOLD",
        postureSinceTick: 1,
        enemies: {
          [IDS.enemyVanguard]: {
            id: IDS.enemyVanguard,
            kind: "UNIT",
            unitType: "VANGUARD",
            position: [3, -1],
            hp: 4,
            lastSeenTick: 33,
            lastMove: "LEFT",
            movementStreak: 2,
          },
        },
      },
    );

    expect(result.plan.unit_actions?.[IDS.vanguard]).toEqual({
      type: "MOVE",
      direction: "LEFT",
    });
  });

  it("returns along the attack axis when an advancing threat is already ahead", () => {
    const result = planTick(
      34,
      state([
        core(),
        unit(IDS.vanguard, "VANGUARD", [8, -2]),
        unit(IDS.enemyVanguard, "VANGUARD", [5, -1], {
          controlled: false,
        }),
      ]),
      {
        ...emptyMemory(),
        posture: "HOLD",
        postureSinceTick: 1,
        enemies: {
          [IDS.enemyVanguard]: {
            id: IDS.enemyVanguard,
            kind: "UNIT",
            unitType: "VANGUARD",
            position: [6, -1],
            hp: 4,
            lastSeenTick: 33,
            lastMove: "LEFT",
            movementStreak: 2,
          },
        },
      },
    );

    expect(result.plan.unit_actions?.[IDS.vanguard]).toEqual({
      type: "MOVE",
      direction: "LEFT",
    });
  });

  it.each([
    {
      label: "below",
      vanguard: [0, 7] as Position,
      ranger: [1, 6] as Position,
      enemyCenter: [0, 9] as Position,
      frontIsAhead: (frontY: number, rearY: number) => frontY > rearY,
    },
    {
      label: "above",
      vanguard: [0, -7] as Position,
      ranger: [1, -6] as Position,
      enemyCenter: [0, -9] as Position,
      frontIsAhead: (frontY: number, rearY: number) => frontY < rearY,
    },
  ])(
    "keeps a vertical Vanguard screen during withdrawal from a threat $label",
    ({ vanguard, ranger, enemyCenter, frontIsAhead }) => {
      const enemies = [-1, 0, 1].map((x, index) =>
        unit(
          `60000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
          "VANGUARD",
          [x, enemyCenter[1]],
          { controlled: false },
        ),
      );
      const result = planTick(
        34,
        state([
          core(),
          unit(IDS.vanguard, "VANGUARD", vanguard),
          unit(IDS.ranger, "RANGER", ranger),
          ...enemies,
        ]),
        { ...emptyMemory(), posture: "CONTEST", postureSinceTick: 1 },
      );
      const vanguardAnchor =
        result.memory.roles[IDS.vanguard]?.anchor ?? ([0, 0] as Position);
      const rangerAnchor =
        result.memory.roles[IDS.ranger]?.anchor ?? ([0, 0] as Position);

      expect(result.memory.roles[IDS.vanguard]?.kind).toBe("WITHDRAW");
      expect(result.memory.roles[IDS.ranger]?.kind).toBe("WITHDRAW");
      expect(frontIsAhead(vanguardAnchor[1], rangerAnchor[1])).toBe(true);
      expect(distance(vanguardAnchor, enemyCenter)).toBeLessThan(
        distance(rangerAnchor, enemyCenter),
      );
    },
  );

  it("holds a known chokepoint before generic long-range patrol", () => {
    const obstacles: WorldObject = {
      kind: "OBSTACLE",
      positions: [
        [2, -1],
        [2, 1],
      ],
    };
    const result = planTick(
      20,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [0, 0]),
          unit(IDS.worker2, "WORKER", [1, 0]),
          unit(IDS.worker3, "WORKER", [-1, 0]),
          unit(IDS.vanguard, "VANGUARD", [0, 1]),
          unit(IDS.ranger, "RANGER", [0, -1]),
          obstacles,
          {
            kind: "RESOURCE",
            positions: [
              [1, 1],
              [-1, -1],
              [3, 0],
            ],
          },
        ],
        { resources: 15 },
      ),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 10 },
    );
    const roles = Object.values(result.memory.roles);
    expect(
      roles.some(
        (role) =>
          (role.kind === "HOLD_POINT" || role.kind === "WATCH_POINT") &&
          role.anchor[0] === 2,
      ),
    ).toBe(true);
  });

  it("converts a safe occupied chokepoint into supported visual control", () => {
    const obstacles: WorldObject = {
      kind: "OBSTACLE",
      positions: [
        [2, -1],
        [2, 1],
      ],
    };
    const memory = {
      ...emptyMemory(),
      posture: "HOLD" as const,
      postureSinceTick: 1,
      roles: {
        [IDS.vanguard]: {
          kind: "HOLD_POINT" as const,
          anchor: [2, 0] as const,
          sinceTick: 18,
        },
      },
      patrolVisits: { "2,0": 20 },
    };
    const result = planTick(
      21,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [0, 0]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [1, 1]),
          unit(IDS.vanguard, "VANGUARD", [2, 0]),
          obstacles,
          { kind: "RESOURCE", positions: [[3, 0]] },
        ],
        { resources: 15 },
      ),
      memory,
    );
    expect(result.plan.unit_actions?.[IDS.vanguard]?.type).toBe("MOVE");
    expect(result.memory.roles[IDS.vanguard]).toMatchObject({
      kind: "WATCH_POINT",
      anchor: [2, 0],
      sinceTick: 18,
    });
  });

  it("lets an empty Worker scout beyond the control ring with a known escape", () => {
    const explored: Record<string, readonly [number, number]> = {};
    for (let x = -7; x <= 7; x += 1) {
      for (let y = -7; y <= 7; y += 1) {
        if (Math.abs(x) + Math.abs(y) <= 7) explored[`${x},${y}`] = [x, y];
      }
    }
    const result = planTick(
      100,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [5, 0]),
          unit(IDS.worker2, "WORKER", [0, 1]),
          unit(IDS.worker3, "WORKER", [-1, 0]),
        ],
        { resources: 5 },
      ),
      {
        ...emptyMemory(),
        posture: "HOLD",
        postureSinceTick: 1,
        explored,
        resources: {
          "10,0": {
            position: [10, 0],
            lastSeenTick: 99,
            depletedAtTick: 99,
          },
        },
      },
    );
    const action = result.plan.unit_actions?.[IDS.worker1];
    expect(action?.type).toBe("MOVE");
    expect(action).not.toEqual({ type: "MOVE", direction: "LEFT" });
  });

  it("lets a Worker pursue a supported resource just beyond the control ring", () => {
    const explored: Record<string, readonly [number, number]> = {};
    for (let x = -8; x <= 8; x += 1) {
      for (let y = -8; y <= 8; y += 1) {
        if (Math.abs(x) + Math.abs(y) <= 8) explored[`${x},${y}`] = [x, y];
      }
    }
    const result = planTick(
      102,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [5, 0]),
          unit(IDS.worker2, "WORKER", [0, 1]),
          unit(IDS.worker3, "WORKER", [-1, 0]),
          { kind: "RESOURCE", positions: [[8, 0]] },
        ],
        { resources: 5 },
      ),
      {
        ...emptyMemory(),
        posture: "HOLD",
        postureSinceTick: 1,
        explored,
      },
    );
    expect(result.plan.unit_actions?.[IDS.worker1]).toEqual({
      type: "MOVE",
      direction: "RIGHT",
    });
  });

  it("confirms one supported fog resource through the scarcity extension", () => {
    const explored: Record<string, readonly [number, number]> = {};
    for (let x = -10; x <= 15; x += 1) explored[`${x},0`] = [x, 0];
    const result = planTick(
      110,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [11, 0]),
          unit(IDS.worker2, "WORKER", [0, 1]),
          unit(IDS.worker3, "WORKER", [-1, 0]),
        ],
        { resources: 20 },
      ),
      {
        ...emptyMemory(),
        explored,
        resources: { "15,0": { position: [15, 0], lastSeenTick: 109 } },
        posture: "HOLD",
        postureSinceTick: 1,
      },
    );

    expect(result.summary.controlRadius).toBeLessThan(12);
    expect(result.plan.unit_actions?.[IDS.worker1]).toEqual({
      type: "MOVE",
      direction: "RIGHT",
    });
  });

  it("uses the nearest distributed reserve to support a fog resource", () => {
    const explored: Record<string, readonly [number, number]> = {};
    for (let x = -14; x <= 14; x += 1) explored[`${x},0`] = [x, 0];
    const result = planTick(
      111,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [10, 0]),
          unit(IDS.worker2, "WORKER", [-3, 0]),
          unit(IDS.vanguard, "VANGUARD", [6, 0]),
        ],
        { resources: 20 },
      ),
      {
        ...emptyMemory(),
        explored,
        resources: {
          "-3,0": { position: [-3, 0], lastSeenTick: 110 },
          "14,0": { position: [14, 0], lastSeenTick: 110 },
        },
        posture: "HOLD",
        postureSinceTick: 1,
      },
    );

    expect(result.plan.unit_actions?.[IDS.worker1]).toEqual({
      type: "MOVE",
      direction: "RIGHT",
    });
  });

  it("does not let unreachable resource memory suppress frontier exploration", () => {
    const explored: Record<string, readonly [number, number]> = {};
    for (let x = -5; x <= 5; x += 1) {
      for (let y = -5; y <= 5; y += 1) {
        if (Math.abs(x) + Math.abs(y) <= 5) explored[`${x},${y}`] = [x, y];
      }
    }
    const obstaclePositions = [
      [9, 0],
      [11, 0],
      [10, -1],
      [10, 1],
    ] as const;
    const obstacles = Object.fromEntries(
      obstaclePositions.map((position) => [
        `${position[0]},${position[1]}`,
        position,
      ]),
    );
    const workerPositions = new Map([
      [IDS.worker1, [3, 2] as const],
      [IDS.worker2, [-3, 2] as const],
      [IDS.worker3, [-3, -2] as const],
    ]);
    const result = planTick(
      112,
      state([
        core(),
        ...[...workerPositions].map(([id, position]) =>
          unit(id, "WORKER", position),
        ),
      ]),
      {
        ...emptyMemory(),
        explored,
        obstacles,
        resources: { "10,0": { position: [10, 0], lastSeenTick: 111 } },
        posture: "ECONOMY",
        postureSinceTick: 1,
        safeExpansionTicks: 8,
      },
    );

    const delta = {
      UP: [0, -1],
      RIGHT: [1, 0],
      DOWN: [0, 1],
      LEFT: [-1, 0],
    } as const;
    const fogDestinations = new Set(
      [...workerPositions].flatMap(([id, position]) => {
        const action = result.plan.unit_actions?.[id];
        if (action?.type !== "MOVE") return [];
        const step = delta[action.direction];
        const destination = [position[0] + step[0], position[1] + step[1]];
        return explored[`${destination[0]},${destination[1]}`]
          ? []
          : [`${destination[0]},${destination[1]}`];
      }),
    );
    expect(fogDestinations.size).toBeGreaterThanOrEqual(2);
  });

  it("rotates scarce exploration so three Workers cover all four sectors", () => {
    const input = state([
      core(),
      unit(IDS.worker1, "WORKER", [1, 0]),
      unit(IDS.worker2, "WORKER", [0, 1]),
      unit(IDS.worker3, "WORKER", [-1, 0]),
    ]);
    const first = planTick(1, input, emptyMemory(), DEFAULT_CONFIG, () => 0);
    const rotated = planTick(7, input, emptyMemory(), DEFAULT_CONFIG, () => 0);
    const directions = new Set(
      [first, rotated].flatMap((result) =>
        [IDS.worker1, IDS.worker2, IDS.worker3].flatMap((id) => {
          const action = result.plan.unit_actions?.[id];
          return action?.type === "MOVE" ? [action.direction] : [];
        }),
      ),
    );

    expect(directions.size).toBe(4);
  });

  it("fills shallow frontier sectors before extending an elongated search ray", () => {
    const explored: Record<string, Position> = {};
    for (let x = -5; x <= 5; x += 1) {
      for (let y = -5; y <= 5; y += 1) {
        if (Math.abs(x) + Math.abs(y) <= 5) explored[`${x},${y}`] = [x, y];
      }
    }
    for (let x = 6; x <= 20; x += 1) {
      for (let y = -1; y <= 1; y += 1) explored[`${x},${y}`] = [x, y];
    }
    const result = planTick(
      14,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [5, 0]),
        unit(IDS.worker2, "WORKER", [0, 5]),
        unit(IDS.worker3, "WORKER", [-5, 0]),
      ]),
      {
        ...emptyMemory(),
        explored,
        posture: "ECONOMY",
        postureSinceTick: 1,
      },
    );

    expect(result.plan.unit_actions?.[IDS.worker1]).not.toEqual({
      type: "MOVE",
      direction: "RIGHT",
    });
  });

  it("keeps an uncontested resource location beyond the memory window", () => {
    const result = planTick(100, state([core()]), {
      ...emptyMemory(),
      resources: { "4,0": { position: [4, 0], lastSeenTick: 1 } },
    });

    expect(result.memory.resources["4,0"]).toMatchObject({
      position: [4, 0],
      lastSeenTick: 1,
    });
  });

  it("starts resource-memory aging only when an enemy enters its area", () => {
    const result = planTick(
      100,
      state([
        core(),
        unit(IDS.enemyWorker, "WORKER", [6, 0], { controlled: false }),
      ]),
      {
        ...emptyMemory(),
        resources: { "4,0": { position: [4, 0], lastSeenTick: 1 } },
      },
    );

    expect(result.memory.resources["4,0"]?.contestedAtTick).toBe(100);
  });

  it("expires only a contested resource after the uncertainty window", () => {
    const result = planTick(134, state([core()]), {
      ...emptyMemory(),
      resources: {
        "4,0": {
          position: [4, 0],
          lastSeenTick: 1,
          contestedAtTick: 101,
        },
      },
    });

    expect(result.memory.resources["4,0"]).toBeUndefined();
  });

  it("clears contested aging when the resource is seen again", () => {
    const result = planTick(
      134,
      state([core(), { kind: "RESOURCE", positions: [[4, 0]] }]),
      {
        ...emptyMemory(),
        resources: {
          "4,0": {
            position: [4, 0],
            lastSeenTick: 1,
            contestedAtTick: 101,
          },
        },
      },
    );

    expect(result.memory.resources["4,0"]).toEqual({
      position: [4, 0],
      lastSeenTick: 134,
    });
  });

  it("assigns only one Worker to a distant fog resource", () => {
    const explored: Record<string, readonly [number, number]> = {};
    for (let x = -8; x <= 14; x += 1) explored[`${x},0`] = [x, 0];
    for (let y = -8; y <= 8; y += 1) explored[`0,${y}`] = [0, y];
    const result = planTick(
      113,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [8, 0]),
          unit(IDS.worker2, "WORKER", [0, -8]),
        ],
        { resources: 20 },
      ),
      {
        ...emptyMemory(),
        explored,
        resources: { "14,0": { position: [14, 0], lastSeenTick: 112 } },
        posture: "HOLD",
        postureSinceTick: 1,
      },
    );

    expect(result.plan.unit_actions?.[IDS.worker1]).toEqual({
      type: "MOVE",
      direction: "RIGHT",
    });
    expect(result.plan.unit_actions?.[IDS.worker2]?.type).toBe("MOVE");
    expect(result.plan.unit_actions?.[IDS.worker2]).not.toEqual({
      type: "MOVE",
      direction: "RIGHT",
    });
  });

  it("assigns distinct workers to distinct reachable fog resources", () => {
    const explored: Record<string, readonly [number, number]> = {};
    for (let x = -14; x <= 14; x += 1) explored[`${x},0`] = [x, 0];
    for (let y = -8; y <= 8; y += 1) explored[`0,${y}`] = [0, y];
    const result = planTick(
      120,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [6, 0]),
          unit(IDS.worker2, "WORKER", [-6, 0]),
        ],
        { resources: 20 },
      ),
      {
        ...emptyMemory(),
        explored,
        resources: {
          "12,0": { position: [12, 0], lastSeenTick: 119 },
          "-12,0": { position: [-12, 0], lastSeenTick: 119 },
        },
        posture: "HOLD",
        postureSinceTick: 1,
      },
    );

    expect(result.plan.unit_actions?.[IDS.worker1]).toEqual({
      type: "MOVE",
      direction: "RIGHT",
    });
    expect(result.plan.unit_actions?.[IDS.worker2]).toEqual({
      type: "MOVE",
      direction: "LEFT",
    });
  });

  it("recalls a live fog resource beyond combat support instead of orbiting vision", () => {
    const explored: Record<string, readonly [number, number]> = {};
    for (let x = 0; x <= 18; x += 1) explored[`${x},0`] = [x, 0];
    const result = planTick(
      121,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [4, 0]),
          // Keep combat parked on the Core so fog recall cannot lean on field support.
          unit(IDS.vanguard, "VANGUARD", [0, 1]),
          unit(IDS.ranger, "RANGER", [0, -1]),
        ],
        { resources: 20 },
      ),
      {
        ...emptyMemory(),
        explored,
        resources: {
          "18,0": { position: [18, 0], lastSeenTick: 120 },
        },
        posture: "ECONOMY",
        postureSinceTick: 1,
        safeExpansionTicks: 8,
        workerDutyScoutUntil: { [IDS.worker1]: 200 },
      },
    );

    expect(result.plan.unit_actions?.[IDS.worker1]).toEqual({
      type: "MOVE",
      direction: "RIGHT",
    });
  });

  it("starts distributed search immediately when only resource memories remain", () => {
    const explored: Record<string, readonly [number, number]> = {};
    for (let x = -8; x <= 8; x += 1) {
      for (let y = -8; y <= 8; y += 1) {
        if (Math.abs(x) + Math.abs(y) <= 8) explored[`${x},${y}`] = [x, y];
      }
    }
    const workers = [
      unit(IDS.worker1, "WORKER", [5, 3]),
      unit(IDS.worker2, "WORKER", [-5, 3]),
      unit(IDS.worker3, "WORKER", [-5, -3]),
    ];
    const result = planTick(
      114,
      state([core(), ...workers], { resources: 20 }),
      {
        ...emptyMemory(),
        explored,
        resources: {
          "10,0": { position: [10, 0], lastSeenTick: 113 },
          "0,10": { position: [0, 10], lastSeenTick: 113 },
          "-10,0": { position: [-10, 0], lastSeenTick: 113 },
        },
        posture: "ECONOMY",
        postureSinceTick: 1,
        safeExpansionTicks: 8,
      },
    );

    const moves = workers.map(
      (worker) => result.plan.unit_actions?.[worker.id],
    );
    expect(moves.filter((action) => action?.type === "MOVE")).toHaveLength(3);
    const delta = {
      UP: [0, -1],
      RIGHT: [1, 0],
      DOWN: [0, 1],
      LEFT: [-1, 0],
    } as const;
    const destinations = new Set(
      workers.flatMap((worker, index) => {
        const action = moves[index];
        if (action?.type !== "MOVE") return [];
        const step = delta[action.direction];
        return [
          `${worker.position[0] + step[0]},${worker.position[1] + step[1]}`,
        ];
      }),
    );
    expect(destinations.size).toBe(3);
  });

  it("keeps scouting beyond the former control and support limit", () => {
    const explored: Record<string, readonly [number, number]> = {};
    for (let x = -30; x <= 30; x += 1) {
      for (let y = -30; y <= 30; y += 1) {
        if (Math.abs(x) + Math.abs(y) <= 30) explored[`${x},${y}`] = [x, y];
      }
    }
    const result = planTick(
      115,
      state([core(), unit(IDS.worker1, "WORKER", [14, 14])]),
      {
        ...emptyMemory(),
        explored,
        posture: "ECONOMY",
        postureSinceTick: 1,
        safeExpansionTicks: 20,
      },
    );

    expect(result.plan.unit_actions?.[IDS.worker1]?.type).toBe("MOVE");
  });

  it("uses a friendly cell's free slot to break an exploration traffic jam", () => {
    const explored: Record<string, readonly [number, number]> = {};
    for (let x = 0; x <= 6; x += 1) {
      for (let y = -1; y <= 1; y += 1) explored[`${x},${y}`] = [x, y];
    }
    const obstacles: Position[] = [
      [2, 0],
      [3, -1],
      [3, 1],
    ];
    const result = planTick(
      116,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [3, 0]),
        unit(IDS.worker2, "WORKER", [4, 0]),
        { kind: "OBSTACLE", positions: obstacles },
      ]),
      {
        ...emptyMemory(),
        explored,
        posture: "ECONOMY",
        postureSinceTick: 1,
      },
    );

    expect(result.plan.unit_actions?.[IDS.worker1]).toEqual({
      type: "MOVE",
      direction: "RIGHT",
    });
  });

  it("recalls a threatened Worker even before it leaves the control ring", () => {
    const result = planTick(
      101,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [2, 0]),
        unit(IDS.worker2, "WORKER", [0, 1]),
        unit(IDS.worker3, "WORKER", [-1, 0]),
        unit(IDS.enemyVanguard, "VANGUARD", [3, 0], { controlled: false }),
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );
    expect(result.plan.unit_actions?.[IDS.worker1]).toEqual({
      type: "MOVE",
      direction: "LEFT",
    });
  });

  it("keeps a diagonally offset Worker on a safe scouting move", () => {
    const objects = [
      core(),
      unit(IDS.worker1, "WORKER", [2, 1]),
      unit(IDS.worker2, "WORKER", [0, 1]),
      unit(IDS.worker3, "WORKER", [-1, 0]),
    ];
    const memory = {
      ...emptyMemory(),
      posture: "HOLD" as const,
      postureSinceTick: 1,
    };
    const result = planTick(
      103,
      state([
        ...objects,
        unit(IDS.enemyWorker, "RANGER", [3, 0], { controlled: false }),
      ]),
      memory,
    );
    const action = result.plan.unit_actions?.[IDS.worker1];
    expect(action?.type).toBe("MOVE");
    if (action?.type !== "MOVE") throw new Error("expected Worker movement");
    const destinations: Record<string, Position> = {
      UP: [2, 0],
      RIGHT: [3, 1],
      DOWN: [2, 2],
      LEFT: [1, 1],
    };
    const destination = destinations[action.direction];
    expect(destination).toBeDefined();
    if (!destination) throw new Error("missing direction destination");
    expect(lineClear([3, 0], destination, new Set())).toBe(false);
  });

  it("does not mistake a mapped dead end for a chokepoint", () => {
    const result = planTick(
      22,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [0, 0]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [1, 1]),
          unit(IDS.vanguard, "VANGUARD", [2, 0]),
          {
            kind: "OBSTACLE",
            positions: [
              [2, -1],
              [2, 1],
              [3, 0],
            ],
          },
        ],
        { resources: 15 },
      ),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );
    expect(result.memory.roles[IDS.vanguard]?.kind).toBe("RESERVE");
  });

  it("never parks a combat reserve on the Core cell so cargo can deposit", () => {
    // Core counts as one friendly occupant: a Vanguard standing on Core fills the
    // only free stack slot and blocks worker DEPOSIT / SPAWN.
    const result = planTick(
      30,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [2, 0], { cargo: 1 }),
          unit(IDS.worker2, "WORKER", [3, 0]),
          unit(IDS.worker3, "WORKER", [0, 2]),
          unit(IDS.vanguard, "VANGUARD", [0, 0]),
          unit(IDS.ranger, "RANGER", [0, -2]),
        ],
        { resources: 15 },
      ),
      {
        ...emptyMemory(),
        posture: "HOLD",
        postureSinceTick: 1,
        explored: exploredDiamond([0, 0], 6),
        militaryPressureTicks: 0,
      },
    );

    const vanguardAction = result.plan.unit_actions?.[IDS.vanguard];
    expect(result.memory.roles[IDS.vanguard]?.kind).toBe("RESERVE");
    expect(result.memory.roles[IDS.vanguard]?.anchor).not.toEqual([0, 0]);
    // Must step off Core (or already be planning a non-Core seat).
    expect(vanguardAction).toEqual(expect.objectContaining({ type: "MOVE" }));
    if (vanguardAction?.type === "MOVE") {
      const next = nextPosition([0, 0], vanguardAction.direction);
      expect(next).not.toEqual([0, 0]);
      expect(Math.abs(next[0]) + Math.abs(next[1])).toBe(1);
    }

    // Cargo worker keeps a path onto the Core cell for DEPOSIT.
    const workerAction = result.plan.unit_actions?.[IDS.worker1];
    expect(workerAction).toEqual({ type: "MOVE", direction: "LEFT" });
  });

  it("holds between-wave combat units on a Core perimeter, not the Core cell", () => {
    const result = planTick(
      40,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [3, 0], { cargo: 1 }),
          unit(IDS.worker2, "WORKER", [-3, 0]),
          unit(IDS.worker3, "WORKER", [0, 3]),
          // Already on Core: must step off even under between-wave hold.
          unit(IDS.vanguard, "VANGUARD", [0, 0]),
          unit("00000000-0000-4000-8000-000000000022", "VANGUARD", [5, 1]),
          unit(IDS.ranger, "RANGER", [4, 1]),
        ],
        { resources: 20 },
      ),
      {
        ...emptyMemory(),
        posture: "HOLD",
        postureSinceTick: 1,
        explored: exploredDiamond([0, 0], 8),
        militaryPressureTicks: 8,
        recentCombatLosses: 1,
      },
    );

    const onCoreVanguard = result.plan.unit_actions?.[IDS.vanguard];
    expect(result.memory.roles[IDS.vanguard]?.kind).toBe("RESERVE");
    expect(result.memory.roles[IDS.vanguard]?.anchor).not.toEqual([0, 0]);
    expect(onCoreVanguard).toEqual(expect.objectContaining({ type: "MOVE" }));
    if (onCoreVanguard?.type === "MOVE") {
      const next = nextPosition([0, 0], onCoreVanguard.direction);
      expect(Math.abs(next[0]) + Math.abs(next[1])).toBe(1);
    }

    for (const id of ["00000000-0000-4000-8000-000000000022", IDS.ranger]) {
      const role = result.memory.roles[id];
      expect(role?.kind).toBe("RESERVE");
      expect(role?.anchor).not.toEqual([0, 0]);
      if (role) {
        expect(distance([0, 0], role.anchor)).toBeGreaterThanOrEqual(1);
      }
    }

    const cargo = result.plan.unit_actions?.[IDS.worker1];
    expect(cargo?.type).toBe("MOVE");
  });

  it("keeps at least one combat Unit in the reaction reserve", () => {
    const result = planTick(
      25,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [0, 0]),
          unit(IDS.worker2, "WORKER", [1, 0]),
          unit(IDS.worker3, "WORKER", [-1, 0]),
          unit(IDS.vanguard, "VANGUARD", [1, 1]),
          unit(IDS.ranger, "RANGER", [-1, -1]),
          core({
            id: IDS.enemyCore,
            owner_username: "enemy",
            controlled: false,
            position: [8, 0],
            shield: 0,
          }),
        ],
        { resources: 20 },
      ),
      { ...emptyMemory(), posture: "ATTACK", postureSinceTick: 1 },
    );
    expect(
      Object.values(result.memory.roles).some(
        (role) => role.kind === "RESERVE",
      ),
    ).toBe(true);
  });

  it("attacks a visible weak Core despite incomplete economy knowledge", () => {
    const result = planTick(
      40,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [0, 1]),
          unit(IDS.vanguard, "VANGUARD", [2, 0]),
          unit("00000000-0000-4000-8000-000000000022", "VANGUARD", [2, 1]),
          unit(IDS.ranger, "RANGER", [1, -1]),
          core({
            id: IDS.enemyCore,
            owner_username: "enemy",
            controlled: false,
            position: [8, 0],
            hp: 3,
            shield: 0,
          }),
        ],
        { resources: 5 },
      ),
      { ...emptyMemory(), posture: "ECONOMY", postureSinceTick: 1 },
    );

    expect(result.summary.posture).toBe("ATTACK");
    expect(
      Object.values(result.memory.roles).filter(
        (role) => role.kind === "RALLY" || role.kind === "ADVANCE",
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(result.summary.reserveCount).toBeGreaterThanOrEqual(1);
  });

  it("keeps building the economy when a visible Core is not safely attackable", () => {
    const result = planTick(
      40,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [0, 1]),
        unit(IDS.vanguard, "VANGUARD", [2, 0]),
        core({
          id: IDS.enemyCore,
          owner_username: "enemy",
          controlled: false,
          position: [8, 0],
        }),
      ]),
      { ...emptyMemory(), posture: "ECONOMY", postureSinceTick: 1 },
    );

    expect(result.summary.posture).toBe("ECONOMY");
  });

  it("keeps the prior posture during ordinary dwell time", () => {
    const result = planTick(
      3,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [0, 0]),
          unit(IDS.worker2, "WORKER", [1, 0]),
          unit(IDS.worker3, "WORKER", [-1, 0]),
        ],
        { resources: 15 },
      ),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
      DEFAULT_CONFIG,
    );
    expect(result.summary.posture).toBe("HOLD");
  });

  it("uses a safe fallback that only deposits immediately valid cargo", () => {
    const fallback = safeFallbackPlan(
      30,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [0, 0], { cargo: 1 }),
        unit(IDS.worker2, "WORKER", [1, 0], { cargo: 1 }),
        unit(IDS.vanguard, "VANGUARD", [0, 1]),
      ]),
    );
    expect(fallback.unit_actions).toEqual({
      [IDS.worker1]: { type: "DEPOSIT" },
    });
  });

  it("is deterministic for identical state and memory", () => {
    const input = state([
      core(),
      unit(IDS.worker1, "WORKER", [1, 0]),
      unit(IDS.vanguard, "VANGUARD", [0, 1]),
      { kind: "RESOURCE", positions: [[2, 0]] },
    ]);
    const first = planTick(40, input, emptyMemory(), DEFAULT_CONFIG, () => 0);
    const second = planTick(40, input, emptyMemory(), DEFAULT_CONFIG, () => 0);
    expect(first.plan).toEqual(second.plan);
    expect(first.memory).toEqual(second.memory);
  });

  it("picks up a ground Beacon with the Core before discretionary spawning", () => {
    const result = planTick(
      41,
      state([core(), unit(IDS.worker1, "WORKER", [1, 0])], {
        resources: 20,
        champion_beacon: { position: [0, 0], status: "GROUND" },
      }),
      emptyMemory(),
    );
    expect(result.plan.core_action).toEqual({ type: "PICKUP_BEACON" });
  });

  it("spends only resources above the dynamic survival reserve", () => {
    const held = planTick(
      42,
      state([core(), unit(IDS.worker1, "WORKER", [1, 0])], {
        resources: 4,
      }),
      emptyMemory(),
    );
    const aboveReserve = planTick(
      43,
      state([core(), unit(IDS.worker1, "WORKER", [1, 0])], {
        resources: 5,
      }),
      emptyMemory(),
    );
    const formerManualThreshold = planTick(
      44,
      state([core(), unit(IDS.worker1, "WORKER", [1, 0])], {
        resources: 30,
      }),
      emptyMemory(),
    );

    expect(held.summary.threatened).toBe(false);
    expect(held.summary.reserve).toBe(0);
    expect(held.plan.core_action).toBeUndefined();
    expect(aboveReserve.plan.core_action).toEqual({
      type: "SPAWN",
      unit_type: "WORKER",
    });
    expect(formerManualThreshold.summary.reserve).toBe(0);
    expect(formerManualThreshold.plan.core_action).toEqual({
      type: "SPAWN",
      unit_type: "WORKER",
    });
  });

  it("uses a full low-capacity Core for ordinary production", () => {
    const result = planTick(
      44,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [1, 0]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [0, 1]),
          unit(IDS.vanguard, "VANGUARD", [0, -1]),
          unit(IDS.ranger, "RANGER", [1, 1]),
        ],
        { resources: 25 },
      ),
      emptyMemory(),
    );

    expect(result.summary.reserve).toBe(0);
    expect(result.plan.core_action?.type).toBe("SPAWN");
  });

  it("unlocks capacity while an empty Worker is leaving the Core cell", () => {
    const result = planTick(
      44,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [0, 0]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [0, 1]),
          unit(IDS.vanguard, "VANGUARD", [0, -1]),
          unit(IDS.ranger, "RANGER", [1, 1]),
          { kind: "RESOURCE", positions: [[3, 0]] },
        ],
        { resources: 25 },
      ),
      emptyMemory(),
    );

    expect(result.plan.unit_actions?.[IDS.worker1]?.type).toBe("MOVE");
    expect(result.plan.core_action?.type).toBe("SPAWN");
  });

  it("does not spend an emergency reserve on a Worker during an assault", () => {
    const result = planTick(
      45,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [1, 0]),
          unit(IDS.enemyVanguard, "VANGUARD", [5, 0], {
            controlled: false,
          }),
        ],
        { resources: 8 },
      ),
      emptyMemory(),
    );

    expect(result.summary.threatened).toBe(true);
    expect(result.plan.core_action).toBeUndefined();
  });

  it("uses emergency surplus for a combat defender", () => {
    const result = planTick(
      46,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [1, 0]),
          unit(IDS.enemyVanguard, "VANGUARD", [5, 0], {
            controlled: false,
          }),
        ],
        { resources: 10 },
      ),
      emptyMemory(),
    );

    expect(result.plan.core_action).toEqual({
      type: "SPAWN",
      unit_type: "VANGUARD",
    });
  });

  it("preserves the three Worker, one Vanguard, one Ranger opening", () => {
    const workers = [
      unit(IDS.worker1, "WORKER", [1, 0]),
      unit(IDS.worker2, "WORKER", [-1, 0]),
      unit(IDS.worker3, "WORKER", [0, 1]),
    ];
    const workerStep = planTick(
      47,
      state([core()], { resources: 30 }),
      emptyMemory(),
    );
    const vanguardStep = planTick(
      48,
      state([core(), ...workers], { resources: 30 }),
      emptyMemory(),
    );
    const rangerStep = planTick(
      49,
      state([core(), ...workers, unit(IDS.vanguard, "VANGUARD", [0, -1])], {
        resources: 30,
      }),
      emptyMemory(),
    );

    expect(workerStep.plan.core_action).toEqual({
      type: "SPAWN",
      unit_type: "WORKER",
    });
    expect(vanguardStep.plan.core_action).toEqual({
      type: "SPAWN",
      unit_type: "VANGUARD",
    });
    expect(rangerStep.plan.core_action).toEqual({
      type: "SPAWN",
      unit_type: "RANGER",
    });
  });

  it("builds combat depth before another Worker when below the safe floor", () => {
    const result = planTick(
      50,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [1, 0]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [0, 1]),
          unit("worker-4", "WORKER", [0, -1]),
          unit(IDS.vanguard, "VANGUARD", [2, 0]),
          unit(IDS.ranger, "RANGER", [-2, 0]),
        ],
        { resources: 30 },
      ),
      emptyMemory(),
    );

    expect(result.summary.combatCountDeficit).toBeGreaterThan(0);
    expect(result.plan.core_action).toEqual({
      type: "SPAWN",
      unit_type: "VANGUARD",
    });
  });

  it("detects a confirmed combat loss and prioritizes replacement", () => {
    const result = planTick(
      51,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [1, 0]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [0, 1]),
          unit(IDS.vanguard, "VANGUARD", [2, 0]),
          unit(IDS.ranger, "RANGER", [-2, 0]),
        ],
        { resources: 30 },
      ),
      {
        ...emptyMemory(),
        previousCombatUnitIds: [IDS.vanguard, IDS.ranger, "lost-vanguard"],
      },
    );

    expect(result.memory.recentCombatLosses).toBe(1);
    expect(result.summary.militaryPressureTicks).toBe(
      DEFAULT_CONFIG.militaryPressureHorizonTicks,
    );
    expect(result.plan.core_action).toMatchObject({ type: "SPAWN" });
    expect(result.plan.core_action).not.toMatchObject({ unit_type: "WORKER" });
  });

  it("keeps remembered pressure bounded, then resumes safe Worker growth", () => {
    const roster: UnitObject[] = [
      unit(IDS.worker1, "WORKER", [1, 0]),
      unit(IDS.worker2, "WORKER", [-1, 0]),
      unit(IDS.worker3, "WORKER", [0, 1]),
      unit(IDS.vanguard, "VANGUARD", [2, 0]),
      unit("vanguard-2", "VANGUARD", [0, -2]),
      unit("vanguard-3", "VANGUARD", [2, 1]),
      unit(IDS.ranger, "RANGER", [-2, 0]),
      unit("ranger-2", "RANGER", [0, 2]),
    ];
    const pressured = planTick(
      52,
      state([core(), ...roster], { resources: 30 }),
      { ...emptyMemory(), militaryPressureTicks: 5 },
    );
    const recovered = planTick(
      53,
      state([core(), ...roster], { resources: 30 }),
      {
        ...emptyMemory(),
        recentCombatLosses: 1,
        militaryCalmTicks: DEFAULT_CONFIG.combatLossDecayTicks - 1,
      },
    );

    expect(pressured.summary.targetWorkerShare).toBe(
      DEFAULT_CONFIG.pressuredWorkerShare,
    );
    expect(pressured.plan.core_action).not.toMatchObject({
      unit_type: "WORKER",
    });
    expect(recovered.memory.recentCombatLosses).toBe(0);
    expect(recovered.summary.targetWorkerShare).toBe(
      DEFAULT_CONFIG.safeWorkerShare,
    );
    expect(recovered.plan.core_action).toEqual({
      type: "SPAWN",
      unit_type: "WORKER",
    });
  });

  it("fills pure combat-count deficit with Vanguard when formation roles are already met", () => {
    const result = planTick(
      57,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [1, 0]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [0, 1]),
          unit(IDS.vanguard, "VANGUARD", [2, 0]),
          unit("vanguard-2", "VANGUARD", [0, -2]),
          unit(IDS.ranger, "RANGER", [-2, 0]),
        ],
        { resources: 24 },
      ),
      emptyMemory(),
    );

    expect(result.summary.combatCountDeficit).toBeGreaterThan(0);
    expect(result.plan.core_action).toEqual({
      type: "SPAWN",
      unit_type: "VANGUARD",
    });
  });

  it("banks combat-replacement resources instead of soft-repairing under deficit", () => {
    const result = planTick(
      58,
      state(
        [
          core({ shield: 2, hp: 5 }),
          unit(IDS.worker1, "WORKER", [1, 0]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [0, 1]),
          unit(IDS.vanguard, "VANGUARD", [2, 0]),
          unit(IDS.ranger, "RANGER", [-2, 0]),
          unit(IDS.enemyVanguard, "VANGUARD", [3, 0], { controlled: false }),
        ],
        { resources: 8 },
      ),
      {
        ...emptyMemory(),
        recentCombatLosses: 1,
        militaryPressureTicks: DEFAULT_CONFIG.militaryPressureHorizonTicks,
        previousCombatUnitIds: [IDS.vanguard, IDS.ranger, "lost-vanguard"],
      },
    );

    expect(result.summary.combatCountDeficit).toBeGreaterThan(0);
    expect(result.summary.threatened).toBe(true);
    expect(result.plan.core_action).toBeUndefined();
  });

  it("tops off shield between waves instead of surplus combat while the floor is met", () => {
    const result = planTick(
      59,
      state(
        [
          core({ shield: 3, hp: 5 }),
          unit(IDS.worker1, "WORKER", [1, 0]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [0, 1]),
          unit(IDS.vanguard, "VANGUARD", [2, 0]),
          unit("vanguard-2", "VANGUARD", [0, -2]),
          unit("vanguard-3", "VANGUARD", [1, 1]),
          unit(IDS.ranger, "RANGER", [-2, 0]),
        ],
        { resources: 9 },
      ),
      {
        ...emptyMemory(),
        // Residual pressure memory with no live hostiles should still spend on
        // shield recovery rather than banking forever for an unaffordable body.
        militaryPressureTicks: 2,
        previousCombatUnitIds: [
          IDS.vanguard,
          "vanguard-2",
          "vanguard-3",
          IDS.ranger,
        ],
      },
    );

    expect(result.summary.combatCountDeficit).toBe(0);
    expect(result.summary.threatened).toBe(false);
    expect(result.plan.core_action).toEqual({ type: "REPAIR_SHIELD" });
  });

  it("holds a peacetime replacement bank instead of surplus combat after the floor is met", () => {
    const result = planTick(
      60,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [1, 0]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [0, 1]),
          unit(IDS.vanguard, "VANGUARD", [2, 0]),
          unit("vanguard-2", "VANGUARD", [0, -2]),
          unit("vanguard-3", "VANGUARD", [1, 1]),
          unit(IDS.ranger, "RANGER", [-2, 0]),
        ],
        { resources: 14 },
      ),
      emptyMemory(),
    );

    expect(result.summary.combatCountDeficit).toBe(0);
    expect(result.plan.core_action).toBeUndefined();
  });

  it("preserves reserve resources when a combat replacement is unaffordable", () => {
    const result = planTick(
      54,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [1, 0]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [0, 1]),
          unit(IDS.vanguard, "VANGUARD", [2, 0]),
          unit(IDS.ranger, "RANGER", [-2, 0]),
        ],
        { resources: 11, upkeep_next_tick: 1 },
      ),
      emptyMemory(),
    );

    expect(result.summary.reserve).toBe(2);
    expect(result.summary.combatCountDeficit).toBeGreaterThan(0);
    expect(result.plan.core_action).toBeUndefined();
  });

  it("allows only upkeep-safe combat-floor replacement through population 19", () => {
    const roster = Array.from({ length: 19 }, (_, index) =>
      unit(
        `population-19-${index}`,
        index < 9 ? "WORKER" : index < 14 ? "VANGUARD" : "RANGER",
        [index + 1, 0],
      ),
    );
    const affordable = planTick(
      55,
      state([core(), ...roster], { resources: 12 }),
      emptyMemory(),
    );
    const unsafe = planTick(
      56,
      state([core(), ...roster], { resources: 11 }),
      emptyMemory(),
    );

    expect(affordable.summary.combatCountDeficit).toBe(1);
    expect(affordable.plan.core_action).toEqual({
      type: "SPAWN",
      unit_type: "VANGUARD",
    });
    expect(unsafe.plan.core_action).toBeUndefined();
  });

  it("loads legacy strategy memory and caps confirmed combat loss growth", () => {
    const legacy = { ...emptyMemory() } as Partial<StrategyMemory>;
    delete legacy.previousCombatUnitIds;
    delete legacy.recentCombatLosses;
    delete legacy.militaryPressureTicks;
    delete legacy.militaryCalmTicks;
    const compatible = planTick(
      57,
      state([core()], { resources: 0 }),
      legacy as StrategyMemory,
    );
    const bounded = planTick(58, state([core()], { resources: 0 }), {
      ...emptyMemory(),
      previousCombatUnitIds: Array.from(
        { length: DEFAULT_CONFIG.combatLossMemoryCap + 5 },
        (_, index) => `lost-${index}`,
      ),
    });

    expect(compatible.memory.previousCombatUnitIds).toEqual([]);
    expect(compatible.memory.recentCombatLosses).toBe(0);
    expect(bounded.memory.recentCombatLosses).toBe(
      DEFAULT_CONFIG.combatLossMemoryCap,
    );
  });

  it("does not remember a planned combat self-destruct as an enemy loss", () => {
    const combatUnits = Array.from({ length: 20 }, (_, index) =>
      unit(`upkeep-combat-${index}`, "RANGER", [index + 1, 0]),
    );
    const first = planTick(
      59,
      state([core(), ...combatUnits], {
        resources: 0,
        population: 20,
        population_tier: 1,
        upkeep_next_tick: 1,
      }),
      emptyMemory(),
    );
    const destructId = Object.entries(first.plan.unit_actions ?? {}).find(
      ([, action]) => action.type === "SELF_DESTRUCT",
    )?.[0];
    expect(destructId).toBeDefined();
    const remaining = combatUnits.filter((unit) => unit.id !== destructId);
    const second = planTick(
      60,
      state([core(), ...remaining], { resources: 0 }),
      first.memory,
    );

    expect(second.memory.recentCombatLosses).toBe(0);
  });

  it("escorts a threatened cargo Worker with a non-reserve combat Unit", () => {
    const result = planTick(
      45,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [6, 0], { cargo: 1 }),
        unit(IDS.vanguard, "VANGUARD", [4, 0]),
        unit(IDS.ranger, "RANGER", [1, 0]),
        unit(IDS.enemyVanguard, "VANGUARD", [7, 0], { controlled: false }),
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );
    expect(
      Object.values(result.memory.roles).some((role) => role.kind === "ESCORT"),
    ).toBe(true);
  });

  it("starts Core migration only after sustained nearby resource scarcity", () => {
    const memory = {
      ...emptyMemory(),
      posture: "HOLD" as const,
      postureSinceTick: 1,
      nearbyResourceDryTicks: 12,
      explored: { "1,0": [1, 0] as const },
      resources: {
        "8,0": { position: [8, 0] as const, lastSeenTick: 49 },
      },
    };
    const result = planTick(
      50,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [2, 0]),
          unit(IDS.worker2, "WORKER", [-2, 0]),
          unit(IDS.worker3, "WORKER", [0, 2]),
          unit(IDS.vanguard, "VANGUARD", [0, -2]),
          unit(IDS.ranger, "RANGER", [-1, -2]),
        ],
        { resources: 5 },
      ),
      memory,
    );
    expect(result.plan.core_action).toEqual({
      type: "START_MOVE",
      direction: "RIGHT",
    });
  });

  it("waits through the normal resource replenishment window before migrating", () => {
    const memory = {
      ...emptyMemory(),
      posture: "HOLD" as const,
      postureSinceTick: 1,
      nearbyResourceDryTicks: 12,
      explored: { "1,0": [1, 0] as const },
      resources: {
        "2,0": {
          position: [2, 0] as const,
          lastSeenTick: 79,
          depletedAtTick: 79,
        },
        "8,0": { position: [8, 0] as const, lastSeenTick: 79 },
      },
    };
    const result = planTick(
      80,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [2, 0]),
          unit(IDS.worker2, "WORKER", [-2, 0]),
          unit(IDS.worker3, "WORKER", [0, 2]),
          unit(IDS.vanguard, "VANGUARD", [0, -2]),
          unit(IDS.ranger, "RANGER", [-1, -2]),
        ],
        { resources: 20 },
      ),
      memory,
    );
    expect(result.plan.core_action?.type).not.toBe("START_MOVE");
    expect(result.memory.nearbyResourceDryTicks).toBeLessThan(12);
  });

  it("does not retarget a depleted resource while its empty cell is visible", () => {
    const result = planTick(
      84,
      state([core(), unit(IDS.worker1, "WORKER", [1, 0])]),
      {
        ...emptyMemory(),
        posture: "HOLD",
        postureSinceTick: 1,
        explored: Object.fromEntries(
          Array.from({ length: 6 }, (_, index) => {
            const position: Position = [index + 1, 0];
            return [`${position[0]},${position[1]}`, position];
          }),
        ),
        resources: {
          "1,-1": {
            position: [1, -1],
            lastSeenTick: 79,
            depletedAtTick: 79,
          },
          "6,0": { position: [6, 0], lastSeenTick: 79 },
        },
      },
    );
    expect(result.plan.unit_actions?.[IDS.worker1]).toEqual({
      type: "MOVE",
      direction: "RIGHT",
    });
  });

  it("uses the Beacon only to break an equally good migration direction tie", () => {
    const memory = {
      ...emptyMemory(),
      posture: "HOLD" as const,
      postureSinceTick: 1,
      nearbyResourceDryTicks: 12,
      explored: { "1,0": [1, 0] as const, "-1,0": [-1, 0] as const },
      resources: {
        "8,0": { position: [8, 0] as const, lastSeenTick: 89 },
        "-8,0": { position: [-8, 0] as const, lastSeenTick: 89 },
      },
    };
    const result = planTick(
      90,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [2, 0]),
          unit(IDS.worker2, "WORKER", [-2, 0]),
          unit(IDS.worker3, "WORKER", [0, 2]),
          unit(IDS.vanguard, "VANGUARD", [0, -2]),
          unit(IDS.ranger, "RANGER", [-1, -2]),
        ],
        {
          resources: 5,
          champion_beacon: { position: [-20, 0] },
        },
      ),
      memory,
    );
    expect(result.plan.core_action).toEqual({
      type: "START_MOVE",
      direction: "LEFT",
    });
  });

  it("drifts a safe idle Core toward the resource-rich central chunk ring", () => {
    const movingCore = core({ position: [70, 10] });
    const result = planTick(
      120,
      state(
        [
          movingCore,
          unit(IDS.worker1, "WORKER", [68, 10]),
          unit(IDS.worker2, "WORKER", [70, 12]),
          unit(IDS.worker3, "WORKER", [70, 8]),
          unit(IDS.vanguard, "VANGUARD", [68, 11]),
          unit(IDS.ranger, "RANGER", [68, 9]),
        ],
        { resources: 5 },
      ),
      {
        ...emptyMemory(),
        posture: "HOLD",
        postureSinceTick: 1,
        nearbyResourceDryTicks: 12,
      },
    );

    expect(result.plan.core_action).toEqual({
      type: "START_MOVE",
      direction: "LEFT",
    });
  });

  it("moves an outer positive-x Core left even when a resource is farther right", () => {
    const result = planTick(
      120,
      state(
        [
          core({ position: [70, 10] }),
          unit(IDS.worker1, "WORKER", [68, 10]),
          unit(IDS.worker2, "WORKER", [70, 12]),
          unit(IDS.worker3, "WORKER", [70, 8]),
          unit(IDS.vanguard, "VANGUARD", [68, 11]),
          unit(IDS.ranger, "RANGER", [68, 9]),
        ],
        { resources: 5 },
      ),
      {
        ...emptyMemory(),
        posture: "HOLD",
        postureSinceTick: 1,
        nearbyResourceDryTicks: 12,
        resources: {
          "80,10": { position: [80, 10], lastSeenTick: 119 },
        },
      },
    );

    expect(result.plan.core_action).toEqual({
      type: "START_MOVE",
      direction: "LEFT",
    });
  });

  it.each([
    { position: [0, 70] as Position, direction: "UP" as const },
    { position: [0, -70] as Position, direction: "DOWN" as const },
  ])(
    "uses screen-y direction $direction to drift from $position toward center",
    ({ position, direction }) => {
      const result = planTick(
        121,
        state(
          [
            core({ position }),
            unit(IDS.worker1, "WORKER", [position[0] + 2, position[1] + 2]),
            unit(IDS.worker2, "WORKER", [position[0] - 2, position[1] + 2]),
            unit(IDS.worker3, "WORKER", [position[0] + 2, position[1] - 2]),
            unit(IDS.vanguard, "VANGUARD", [position[0] - 2, position[1] - 2]),
            unit(IDS.ranger, "RANGER", [position[0] + 3, position[1]]),
          ],
          { resources: 5 },
        ),
        {
          ...emptyMemory(),
          posture: "HOLD",
          postureSinceTick: 1,
          nearbyResourceDryTicks: 12,
        },
      );

      expect(result.plan.core_action).toEqual({
        type: "START_MOVE",
        direction,
      });
    },
  );

  it("stops background drift after entering the central chunk ring", () => {
    const result = planTick(
      122,
      state(
        [
          core({ position: [20, 20] }),
          unit(IDS.worker1, "WORKER", [22, 22]),
          unit(IDS.worker2, "WORKER", [18, 22]),
          unit(IDS.worker3, "WORKER", [22, 18]),
          unit(IDS.vanguard, "VANGUARD", [18, 18]),
          unit(IDS.ranger, "RANGER", [23, 20]),
        ],
        { resources: 5 },
      ),
      {
        ...emptyMemory(),
        posture: "HOLD",
        postureSinceTick: 1,
        nearbyResourceDryTicks: 12,
      },
    );

    expect(result.plan.core_action?.type).not.toBe("START_MOVE");
  });

  it("prioritizes production over idle center drift", () => {
    const result = planTick(
      122,
      state(
        [core({ position: [70, 10] }), unit(IDS.worker1, "WORKER", [68, 10])],
        {
          resources: 35,
        },
      ),
      {
        ...emptyMemory(),
        posture: "ECONOMY",
        postureSinceTick: 1,
        nearbyResourceDryTicks: 12,
      },
    );

    expect(result.plan.core_action).toEqual({
      type: "SPAWN",
      unit_type: "WORKER",
    });
  });

  it("cancels idle center drift when a production task becomes available", () => {
    const result = planTick(
      123,
      state(
        [
          core({
            position: [70, 10],
            state: "MOVING",
            move_direction: "LEFT",
            move_progress: 2,
            move_required_ticks: 4,
            destination: [69, 10],
          }),
          unit(IDS.worker1, "WORKER", [68, 10]),
        ],
        { resources: 35 },
      ),
      emptyMemory(),
    );

    expect(result.plan.core_action).toEqual({ type: "CANCEL_MOVE" });
  });

  it("cancels idle center drift when a resource appears", () => {
    const result = planTick(
      124,
      state(
        [
          core({
            position: [70, 10],
            state: "MOVING",
            move_direction: "LEFT",
            move_progress: 2,
            move_required_ticks: 4,
            destination: [69, 10],
          }),
          unit(IDS.worker1, "WORKER", [68, 10]),
          { kind: "RESOURCE", positions: [[67, 10]] },
        ],
        { resources: 0 },
      ),
      emptyMemory(),
    );

    expect(result.plan.core_action).toEqual({ type: "CANCEL_MOVE" });
  });

  it("does not start Core migration while nearby cargo is returning", () => {
    const result = planTick(
      125,
      state(
        [
          core({ position: [70, 10] }),
          unit(IDS.worker1, "WORKER", [68, 10], { cargo: 1 }),
          unit(IDS.worker2, "WORKER", [70, 12]),
          unit(IDS.worker3, "WORKER", [70, 8]),
          unit(IDS.vanguard, "VANGUARD", [68, 11]),
          unit(IDS.ranger, "RANGER", [68, 9]),
        ],
        { resources: 5 },
      ),
      {
        ...emptyMemory(),
        posture: "HOLD",
        postureSinceTick: 1,
        nearbyResourceDryTicks: 12,
      },
    );

    expect(result.plan.unit_actions?.[IDS.worker1]).toEqual({
      type: "MOVE",
      direction: "RIGHT",
    });
    expect(result.plan.core_action?.type).not.toBe("START_MOVE");
  });

  it("cancels Core migration when nearby cargo enters the deposit queue", () => {
    const result = planTick(
      126,
      state(
        [
          core({
            position: [70, 10],
            state: "MOVING",
            move_direction: "LEFT",
            move_progress: 2,
            move_required_ticks: 4,
            destination: [69, 10],
          }),
          unit(IDS.worker1, "WORKER", [68, 10], { cargo: 1 }),
        ],
        { resources: 0 },
      ),
      emptyMemory(),
    );

    expect(result.plan.core_action).toEqual({ type: "CANCEL_MOVE" });
  });

  it("does not cancel Core migration for cargo still far from deposit", () => {
    const result = planTick(
      127,
      state(
        [
          core({
            position: [70, 10],
            state: "MOVING",
            move_direction: "LEFT",
            move_progress: 2,
            move_required_ticks: 4,
            destination: [69, 10],
          }),
          unit(IDS.worker1, "WORKER", [66, 10], { cargo: 1 }),
        ],
        { resources: 0 },
      ),
      emptyMemory(),
    );

    expect(result.plan.core_action).toBeUndefined();
  });

  it("cancels Core migration when a credible threat appears", () => {
    const movingCore = core({
      state: "MOVING",
      move_direction: "RIGHT",
      move_progress: 2,
      move_required_ticks: 4,
      destination: [1, 0],
    });
    const result = planTick(
      51,
      state([
        movingCore,
        unit(IDS.worker1, "WORKER", [0, 1]),
        unit(IDS.enemyVanguard, "VANGUARD", [2, 0], { controlled: false }),
      ]),
      emptyMemory(),
    );
    expect(result.plan.core_action).toEqual({ type: "CANCEL_MOVE" });
  });

  it("self-destructs the minimum low-value Unit set needed to afford upkeep", () => {
    const manyUnits = Array.from({ length: 20 }, (_, index) =>
      unit(
        index === 0
          ? IDS.worker1
          : `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
        index < 10 ? "WORKER" : "VANGUARD",
        [index + 1, 0],
      ),
    );
    const result = planTick(
      60,
      state([core(), ...manyUnits], {
        resources: 0,
        population: 20,
        population_tier: 1,
        upkeep_next_tick: 1,
      }),
      { ...emptyMemory(), previousPopulation: 20 },
    );
    expect(
      Object.values(result.plan.unit_actions ?? {}).filter(
        (action) => action.type === "SELF_DESTRUCT",
      ),
    ).toHaveLength(1);
  });

  it("expands the control radius and reaction reserve with force and economy", () => {
    const small = planTick(
      70,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [0, 1]),
        unit(IDS.vanguard, "VANGUARD", [1, 0]),
      ]),
      emptyMemory(),
    );
    const largeUnits = Array.from({ length: 12 }, (_, index) =>
      unit(
        `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        index < 6 ? "WORKER" : index < 10 ? "VANGUARD" : "RANGER",
        [index + 1, index % 2],
      ),
    );
    const large = planTick(
      70,
      state([core(), ...largeUnits], { resources: 30 }),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
    );
    expect(large.summary.controlRadius).toBeGreaterThan(
      small.summary.controlRadius,
    );
    expect(large.summary.reserveCount).toBeGreaterThan(
      small.summary.reserveCount,
    );
  });

  it("commits the reaction reserve to a supported threat inside the control ring", () => {
    const result = planTick(
      71,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [0, 1]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [0, -1]),
          unit(IDS.vanguard, "VANGUARD", [1, 0]),
          unit(IDS.ranger, "RANGER", [2, 0]),
          unit(IDS.enemyWorker, "WORKER", [3, 0], { controlled: false }),
          unit(IDS.enemyVanguard, "VANGUARD", [6, 0], { controlled: false }),
        ],
        { resources: 20 },
      ),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
      { ...DEFAULT_CONFIG, threatCoreRadius: 4 },
    );
    const reserveRole = result.memory.roles[IDS.vanguard];
    expect(result.summary.threatened).toBe(false);
    expect(reserveRole).toMatchObject({
      kind: "CORE_DEFENSE",
      anchor: [6, 0],
    });
  });

  it("reorients the reserve and field formation before a visible threat breaches", () => {
    const result = planTick(
      71,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [0, 1]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [0, -1]),
          unit(IDS.vanguard, "VANGUARD", [-4, 0]),
          unit("forward-vanguard", "VANGUARD", [-3, -1]),
          unit(IDS.ranger, "RANGER", [-3, 1]),
          unit("forward-ranger", "RANGER", [-2, 0]),
          unit(IDS.enemyVanguard, "VANGUARD", [13, 0], {
            controlled: false,
          }),
        ],
        { resources: 20 },
      ),
      {
        ...emptyMemory(),
        posture: "ECONOMY",
        postureSinceTick: 1,
        explored: exploredDiamond([0, 0], 12),
        roles: {
          [IDS.vanguard]: {
            kind: "RESERVE",
            anchor: [-5, 0],
            sinceTick: 60,
          },
        },
      },
      { ...DEFAULT_CONFIG, threatCoreRadius: 4 },
    );

    expect(result.summary.threatened).toBe(false);
    expect(["RESERVE", "CORE_DEFENSE"]).toContain(
      result.memory.roles[IDS.vanguard]?.kind,
    );
    expect(result.memory.roles[IDS.vanguard]?.anchor[0]).toBeGreaterThan(0);
    expect(
      Object.values(result.memory.roles).some(
        (role) => role.kind === "RALLY" && role.anchor[0] === 13,
      ),
    ).toBe(true);
  });

  it("uses a supported outer post for low-cost vision control", () => {
    const result = planTick(
      72,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [0, 1]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [0, -1]),
          unit(IDS.vanguard, "VANGUARD", [1, 0]),
          unit(IDS.ranger, "RANGER", [2, 0]),
          unit("00000000-0000-4000-8000-000000000032", "RANGER", [0, 2]),
          { kind: "RESOURCE", positions: [[5, 0]] },
        ],
        { resources: 20 },
      ),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 71 },
    );
    expect(
      Object.values(result.memory.roles).some(
        (role) =>
          role.kind === "OBSERVE" &&
          Math.abs(role.anchor[0]) + Math.abs(role.anchor[1]) >= 4,
      ),
    ).toBe(true);
  });

  it("keeps positional controllers while the field group contests the Beacon", () => {
    const combatUnits = Array.from({ length: 6 }, (_, index) =>
      unit(
        `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        index < 4 ? "VANGUARD" : "RANGER",
        [index - 2, index % 2],
      ),
    );
    const resources = {
      "3,0": { position: [3, 0] as Position, lastSeenTick: 79 },
      "0,3": { position: [0, 3] as Position, lastSeenTick: 79 },
      "-3,0": { position: [-3, 0] as Position, lastSeenTick: 79 },
    };
    const result = planTick(
      80,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [0, 1]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [0, -1]),
          ...combatUnits,
        ],
        {
          resources: 20,
          champion_beacon: { position: [6, 0], status: "GROUND" },
        },
      ),
      {
        ...emptyMemory(),
        resources,
        posture: "HOLD",
        postureSinceTick: 1,
      },
    );
    const roles = Object.values(result.memory.roles);
    const reserve = roles.filter((role) => role.kind === "RESERVE").length;
    const positional = roles.filter((role) =>
      ["PATROL", "OBSERVE", "WATCH_POINT", "HOLD_POINT"].includes(role.kind),
    ).length;
    const advancing = roles.filter((role) => role.kind === "ADVANCE").length;

    expect(result.summary.posture).toBe("CONTEST");
    expect(reserve).toBe(result.summary.reserveCount);
    expect(positional).toBeGreaterThanOrEqual(1);
    expect(advancing).toBeGreaterThanOrEqual(2);
  });

  it("stages the reaction reserve on the forward support line when safe", () => {
    const explored: Record<string, readonly [number, number]> = {};
    for (let x = -8; x <= 8; x += 1) {
      for (let y = -8; y <= 8; y += 1) {
        if (Math.abs(x) + Math.abs(y) <= 8) explored[`${x},${y}`] = [x, y];
      }
    }
    const result = planTick(
      74,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [0, 1]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [0, -1]),
          unit(IDS.vanguard, "VANGUARD", [1, 0]),
          unit(IDS.ranger, "RANGER", [2, 0]),
          unit("00000000-0000-4000-8000-000000000032", "RANGER", [0, 2]),
          { kind: "RESOURCE", positions: [[8, 0]] },
        ],
        { resources: 20 },
      ),
      {
        ...emptyMemory(),
        explored,
        resources: { "8,0": { position: [8, 0], lastSeenTick: 73 } },
        posture: "HOLD",
        postureSinceTick: 1,
      },
    );
    const reserveRole = result.memory.roles[IDS.vanguard];
    expect(
      Math.abs(reserveRole?.anchor[0] ?? 0) +
        Math.abs(reserveRole?.anchor[1] ?? 0),
    ).toBeGreaterThanOrEqual(3);
  });

  it("spreads idle defenders across separated outer sectors", () => {
    const explored: Record<string, readonly [number, number]> = {};
    for (let x = -10; x <= 10; x += 1) {
      for (let y = -10; y <= 10; y += 1) {
        if (Math.abs(x) + Math.abs(y) <= 10) explored[`${x},${y}`] = [x, y];
      }
    }
    const defenders = Array.from({ length: 6 }, (_, index) =>
      unit(
        `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        index < 4 ? "VANGUARD" : "RANGER",
        [index - 3, 0],
      ),
    );
    const result = planTick(
      80,
      state([core(), ...defenders], { resources: 20 }),
      {
        ...emptyMemory(),
        explored,
        posture: "HOLD",
        postureSinceTick: 1,
        safeExpansionTicks: 12,
      },
    );
    const anchors = Object.values(result.memory.roles)
      .filter((role) =>
        ["CONTROL_RALLY", "PATROL", "OBSERVE"].includes(role.kind),
      )
      .map((role) => role.anchor);
    expect(
      new Set(anchors.map(([x, y]) => `${x},${y}`)).size,
    ).toBeGreaterThanOrEqual(3);
    expect(
      anchors.filter(([x, y]) => Math.abs(x) + Math.abs(y) >= 7).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("expands after sustained safety and contracts under credible pressure", () => {
    const explored: Record<string, readonly [number, number]> = {};
    for (let x = -12; x <= 12; x += 1) {
      for (let y = -12; y <= 12; y += 1) {
        if (Math.abs(x) + Math.abs(y) <= 12) explored[`${x},${y}`] = [x, y];
      }
    }
    const defenders = Array.from({ length: 4 }, (_, index) =>
      unit(
        `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        "VANGUARD",
        [index, 0],
      ),
    );
    const safe = planTick(
      90,
      state([core(), ...defenders], { resources: 20 }),
      {
        ...emptyMemory(),
        explored,
        posture: "HOLD",
        postureSinceTick: 1,
        safeExpansionTicks: 12,
      },
    );
    const pressured = planTick(
      90,
      state([
        core(),
        ...defenders,
        unit(IDS.enemyVanguard, "VANGUARD", [5, 0], { controlled: false }),
      ]),
      {
        ...emptyMemory(),
        explored,
        posture: "HOLD",
        postureSinceTick: 1,
        safeExpansionTicks: 12,
      },
    );
    expect(safe.summary.controlRadius).toBeGreaterThanOrEqual(10);
    expect(pressured.summary.controlRadius).toBeLessThan(
      safe.summary.controlRadius,
    );
  });

  it("withdraws combat Units and recalls exposed Workers from an overwhelming cluster", () => {
    const enemies = Array.from({ length: 3 }, (_, index) =>
      unit(
        `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        "VANGUARD",
        [7, index - 1],
        { controlled: false },
      ),
    );
    const result = planTick(
      73,
      state(
        [
          core(),
          unit(IDS.worker1, "WORKER", [8, 2]),
          unit(IDS.worker2, "WORKER", [-1, 0]),
          unit(IDS.worker3, "WORKER", [0, -1]),
          unit(IDS.vanguard, "VANGUARD", [6, 0]),
          unit(IDS.ranger, "RANGER", [5, 1]),
          ...enemies,
        ],
        { resources: 20 },
      ),
      { ...emptyMemory(), posture: "CONTEST", postureSinceTick: 1 },
    );
    expect(result.summary.posture).toBe("REGROUP");
    expect(result.summary.retreating).toBe(true);
    expect(result.memory.roles[IDS.vanguard]?.kind).toBe("WITHDRAW");
    expect(result.memory.roles[IDS.ranger]?.kind).toBe("WITHDRAW");
    const workerAction = result.plan.unit_actions?.[IDS.worker1];
    expect(workerAction?.type).toBe("MOVE");
    expect(workerAction).not.toEqual({ type: "MOVE", direction: "UP" });
    expect(workerAction).not.toEqual({ type: "MOVE", direction: "LEFT" });
  });

  it("uses responsive local power instead of distant nominal force for stop-loss", () => {
    const result = planTick(
      74,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [0, 1]),
        unit(IDS.vanguard, "VANGUARD", [4, 0]),
        unit("distant-vanguard", "VANGUARD", [-10, 0]),
        unit(IDS.ranger, "RANGER", [-10, 1]),
        unit("distant-ranger", "RANGER", [-10, -1]),
        unit(IDS.enemyVanguard, "VANGUARD", [7, -1], {
          controlled: false,
        }),
        unit("enemy-vanguard-2", "VANGUARD", [7, 1], {
          controlled: false,
        }),
        unit("enemy-ranger", "RANGER", [8, 0], { controlled: false }),
      ]),
      { ...emptyMemory(), posture: "HOLD", postureSinceTick: 1 },
      { ...DEFAULT_CONFIG, threatCoreRadius: 4 },
    );

    expect(result.summary.retreating).toBe(true);
    expect(result.memory.roles[IDS.vanguard]?.kind).toBe("WITHDRAW");
  });

  it("does not recall a distant Worker for an unrelated overwhelming cluster", () => {
    const enemies = Array.from({ length: 3 }, (_, index) =>
      unit(
        `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        "VANGUARD",
        [6, index - 1],
        { controlled: false },
      ),
    );
    const result = planTick(
      74,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [-6, 0]),
        unit(IDS.vanguard, "VANGUARD", [5, 0]),
        ...enemies,
        { kind: "RESOURCE", positions: [[-6, 0]] },
      ]),
      { ...emptyMemory(), posture: "CONTEST", postureSinceTick: 1 },
    );
    expect(result.summary.retreating).toBe(true);
    expect(result.plan.unit_actions?.[IDS.worker1]).toEqual({
      type: "HARVEST",
    });
  });

  it("discards partial decisions and uses the safe fallback after its deadline", () => {
    let clock = 0;
    const now = (): number => {
      clock += 2;
      return clock;
    };
    const result = planTick(
      61,
      state([
        core(),
        unit(IDS.worker1, "WORKER", [0, 0], { cargo: 1 }),
        unit(IDS.worker2, "WORKER", [1, 0]),
        unit(IDS.vanguard, "VANGUARD", [0, 1]),
      ]),
      emptyMemory(),
      { ...DEFAULT_CONFIG, computeBudgetMs: 1 },
      now,
    );
    expect(result.plan).toEqual({
      tick: 61,
      unit_actions: { [IDS.worker1]: { type: "DEPOSIT" } },
    });
  });
});

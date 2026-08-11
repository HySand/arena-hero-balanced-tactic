import { describe, expect, it } from "vitest";

import {
  compactStrategyMemory,
  decodeStrategyMemory,
  encodeStrategyMemory,
  strategyMemorySize,
} from "../src/memory-storage";
import { core, state, unit, IDS } from "./fixtures";
import { emptyMemory } from "../src/strategy/planner";

describe("strategy memory storage", () => {
  it("round-trips compressed strategy memory", async () => {
    const memory = emptyMemory();
    memory.explored["12,34"] = [12, 34];
    memory.resources["7,8"] = {
      position: [7, 8],
      lastSeenTick: 42,
    };

    const encoded = await encodeStrategyMemory(memory);
    const decoded = await decodeStrategyMemory(encoded);

    expect(decoded).toEqual(memory);
    expect(encoded.byteLength).toBeLessThan(
      new TextEncoder().encode(JSON.stringify(memory)).byteLength,
    );
  });

  it("bounds large map memory around active strategic anchors", () => {
    const memory = emptyMemory();
    for (let index = 0; index < 6000; index += 1) {
      const position = [index - 3000, index % 17] as const;
      const positionKey = `${position[0]},${position[1]}`;
      memory.explored[positionKey] = position;
      memory.workerExplored[positionKey] = position;
      if (index < 1200) memory.obstacles[positionKey] = position;
      if (index < 50) {
        memory.resources[positionKey] = {
          position,
          lastSeenTick: index,
        };
      }
    }

    const compacted = compactStrategyMemory(
      memory,
      state([core(), unit(IDS.worker1, "WORKER", [1, 0])]),
    );
    const size = strategyMemorySize(compacted);

    expect(size).toEqual({
      explored: 2400,
      workerExplored: 1200,
      obstacles: 800,
      resources: 32,
    });
    expect(compacted.explored["0,8"]).toBeDefined();
    expect(compacted.resources["-2951,15"]).toBeDefined();
  });
});

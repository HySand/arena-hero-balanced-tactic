import { describe, expect, it } from "vitest";

import {
  decodeStrategyMemory,
  encodeStrategyMemory,
} from "../src/memory-storage";
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
});

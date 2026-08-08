import { describe, expect, it } from "vitest";

import {
  directionBetween,
  findStep,
  hasVision,
  key,
  lineClear,
  nextPosition,
} from "../src/strategy/geometry";

describe("geometry", () => {
  it("uses screen coordinates with positive y pointing down", () => {
    expect(directionBetween([0, 0], [0, 1])).toBe("DOWN");
    expect(directionBetween([0, 0], [0, -1])).toBe("UP");
    expect(nextPosition([4, 5], "DOWN")).toEqual([4, 6]);
    expect(nextPosition([4, 5], "UP")).toEqual([4, 4]);
  });

  it("routes around a known obstacle", () => {
    const step = findStep([0, 0], [2, 0], new Set([key([1, 0])]), new Map());
    expect(step).toBe("UP");
  });

  it("reports whether an intermediate cell blocks a straight Ranger line", () => {
    expect(lineClear([0, 0], [0, 3], new Set([key([0, 1])]))).toBe(false);
    expect(lineClear([0, 0], [0, 3], new Set())).toBe(true);
  });

  it("keeps cells behind an obstacle outside authoritative vision", () => {
    expect(hasVision([0, 0], [2, 0], 3, new Set([key([1, 0])]))).toBe(false);
    expect(hasVision([0, 0], [0, 2], 3, new Set())).toBe(true);
  });
});

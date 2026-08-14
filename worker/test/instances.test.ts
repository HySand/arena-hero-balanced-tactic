import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_STATE_INSTANCE,
  PRIMARY_STATE_INSTANCE,
  PYTHON_STRATEGY_INSTANCE,
} from "../src/instances";

describe("Durable Object instance routing", () => {
  it("keeps control state and diagnostics isolated", () => {
    expect(PRIMARY_STATE_INSTANCE).toBe("arena-hero-primary");
    expect(DIAGNOSTIC_STATE_INSTANCE).toBe("arena-hero-diagnostics");
    expect(PYTHON_STRATEGY_INSTANCE).toBe("arena-hero-python-v2");
    expect(DIAGNOSTIC_STATE_INSTANCE).not.toBe(PRIMARY_STATE_INSTANCE);
  });
});

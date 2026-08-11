import { describe, expect, it } from "vitest";

import {
  commandStateInstance,
  DIAGNOSTIC_STATE_INSTANCE,
  PRIMARY_STATE_INSTANCE,
} from "../src/instances";

describe("Durable Object instance routing", () => {
  it("keeps control state and diagnostics isolated", () => {
    expect(PRIMARY_STATE_INSTANCE).toBe("arena-hero-primary");
    expect(DIAGNOSTIC_STATE_INSTANCE).toBe("arena-hero-diagnostics");
    expect(DIAGNOSTIC_STATE_INSTANCE).not.toBe(PRIMARY_STATE_INSTANCE);
  });

  it("isolates each command by idempotency key", () => {
    expect(commandStateInstance("agent-42-primary")).toBe(
      "command-agent-42-primary",
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { submitArenaCommand } from "../src/arena-command";

const submission = {
  tick: 42,
  key: "agent-42-primary",
  body: JSON.stringify({ tick: 42, unit_actions: {} }),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Arena command submission", () => {
  it("reports accepted commands", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 202 }))),
    );

    const result = await submitArenaCommand(submission, "arena-token");

    expect(result).toMatchObject({
      event: "command_accepted",
      tick: 42,
      details: { status: 202 },
    });
  });

  it("preserves Arena rejection codes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({ error: "TICK_MISMATCH" }, { status: 409 }),
        ),
      ),
    );

    const result = await submitArenaCommand(submission, "arena-token");

    expect(result).toMatchObject({
      event: "command_rejected",
      tick: 42,
      details: { status: 409, error: "TICK_MISMATCH" },
    });
  });

  it("reports transport failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const result = await submitArenaCommand(submission, "arena-token");

    expect(result).toMatchObject({
      event: "command_submit_failed",
      tick: 42,
      details: { reason: "Error" },
    });
  });
});

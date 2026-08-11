import { afterEach, describe, expect, it, vi } from "vitest";

import { consumeCommandMessages } from "../src/command-consumer";

const submission = {
  tick: 42,
  key: "agent-42-primary",
  body: JSON.stringify({ tick: 42, unit_actions: {} }),
};

function testContext() {
  const results: unknown[] = [];
  const ack = vi.fn();
  const retry = vi.fn();
  const env = {
    ARENA_HERO_API_KEY: "arena-token",
    STATE: {
      getByName: vi.fn(() => ({
        fetch: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
          const body = typeof init?.body === "string" ? init.body : "{}";
          results.push(JSON.parse(body) as unknown);
          return Promise.resolve(new Response(null, { status: 204 }));
        }),
      })),
    },
  };
  const message = { body: submission, attempts: 1, ack, retry };
  return { env, message, results, ack, retry };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("command queue consumer", () => {
  it("acknowledges accepted Arena commands and reports the result", async () => {
    const context = testContext();
    const arenaFetch = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 202 })),
    );
    vi.stubGlobal("fetch", arenaFetch);

    await consumeCommandMessages([context.message], context.env);

    expect(context.ack).toHaveBeenCalledOnce();
    expect(context.retry).not.toHaveBeenCalled();
    expect(context.results).toHaveLength(1);
    expect(context.results[0]).toMatchObject({
      event: "command_accepted",
      tick: 42,
      details: { status: 202, attempts: 1 },
    });
    expect(arenaFetch).toHaveBeenCalledWith(
      "https://api.arenahero.io/api/v1/game/commands",
      expect.objectContaining({ method: "POST", body: submission.body }),
    );
  });

  it("retries a command when the Arena request times out", async () => {
    vi.useFakeTimers();
    const context = testContext();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    const consumption = consumeCommandMessages([context.message], context.env);
    await vi.advanceTimersByTimeAsync(5000);
    await consumption;

    expect(context.ack).not.toHaveBeenCalled();
    expect(context.retry).toHaveBeenCalledWith({ delaySeconds: 1 });
    expect(context.results).toHaveLength(1);
    expect(context.results[0]).toMatchObject({
      event: "command_retry_scheduled",
      tick: 42,
      details: { reason: "TimeoutError", attempts: 1 },
    });
  });

  it("acks non-retryable command rejections", async () => {
    const context = testContext();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 400 }))),
    );

    await consumeCommandMessages([context.message], context.env);

    expect(context.ack).toHaveBeenCalledOnce();
    expect(context.retry).not.toHaveBeenCalled();
    expect(context.results).toHaveLength(1);
    expect(context.results[0]).toMatchObject({
      event: "command_rejected",
      tick: 42,
      details: { status: 400, attempts: 1 },
    });
  });

  it("retries Arena concurrency-limit responses", async () => {
    const context = testContext();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            { error: "COMMAND_CONCURRENCY_LIMIT" },
            { status: 409 },
          ),
        ),
      ),
    );

    await consumeCommandMessages([context.message], context.env);

    expect(context.ack).not.toHaveBeenCalled();
    expect(context.retry).toHaveBeenCalledWith({ delaySeconds: 1 });
    expect(context.results).toHaveLength(1);
    expect(context.results[0]).toMatchObject({
      event: "command_retry_scheduled",
      tick: 42,
      details: {
        status: 409,
        attempts: 1,
        error: "COMMAND_CONCURRENCY_LIMIT",
      },
    });
  });
});

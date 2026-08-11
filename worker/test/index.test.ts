import { describe, expect, it } from "vitest";

import { authorized } from "../src/control";
import { handleRequest } from "../src/router";
import { DEFAULT_CONFIG } from "../src/strategy/config";

interface InternalFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface TestEnvironment {
  ADMIN_CONTROL_SECRET: string;
  AGENT: { getByName(name: string): InternalFetcher };
  STATE: { getByName(name: string): InternalFetcher };
  ASSETS: InternalFetcher;
}

function testEnvironment() {
  const agentRequests: Request[] = [];
  const stateRequests: Request[] = [];
  const assetRequests: Request[] = [];
  const env: TestEnvironment = {
    ADMIN_CONTROL_SECRET: "secret-value",
    AGENT: {
      getByName: (name) => {
        expect(name).toBe("arena-hero-primary");
        return {
          fetch: (input, init) => {
            const request = new Request(input, init);
            agentRequests.push(request);
            return Promise.resolve(new Response(null, { status: 204 }));
          },
        };
      },
    },
    STATE: {
      getByName: (name) => {
        expect(name).toBe("arena-hero-primary");
        return {
          fetch: (input, init) => {
            const request = new Request(input, init);
            stateRequests.push(request);
            return Promise.resolve(
              Response.json({
                ok: true,
                forwardedPath: new URL(request.url).pathname,
              }),
            );
          },
        };
      },
    },
    ASSETS: {
      fetch: (input, init) => {
        const request = new Request(input, init);
        assetRequests.push(request);
        return Promise.resolve(new Response("asset", { status: 200 }));
      },
    },
  };
  return { env, agentRequests, stateRequests, assetRequests };
}

describe("control authentication", () => {
  it("accepts only the exact administrator bearer value", () => {
    expect(authorized("Bearer secret-value", "secret-value")).toBe(true);
    expect(authorized("Bearer secret-valuE", "secret-value")).toBe(false);
    expect(authorized("Bearer short", "secret-value")).toBe(false);
    expect(authorized(null, "secret-value")).toBe(false);
    expect(authorized("Bearer ", "")).toBe(false);
  });
});

describe("worker request routing", () => {
  it("serves public metadata without calling Durable Objects", async () => {
    const { env, agentRequests, stateRequests } = testEnvironment();
    const health = await handleRequest(
      new Request("https://worker.example/api/health"),
      env,
    );
    const schema = await handleRequest(
      new Request("https://worker.example/api/schema"),
      env,
    );

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      ok: true,
      service: "arena-hero-worker",
    });
    expect(schema.status).toBe(200);
    expect(await schema.json()).toMatchObject({ version: 1 });
    expect(agentRequests).toHaveLength(0);
    expect(stateRequests).toHaveLength(0);
  });

  it("forwards frontend routes to the static assets binding", async () => {
    const { env, assetRequests } = testEnvironment();
    const response = await handleRequest(
      new Request("https://worker.example/"),
      env,
    );

    expect(await response.text()).toBe("asset");
    expect(assetRequests).toHaveLength(1);
    expect(new URL(assetRequests[0]!.url).pathname).toBe("/");
  });

  it("forwards configuration and status reads to the State DO", async () => {
    const { env, agentRequests, stateRequests } = testEnvironment();
    const config = await handleRequest(
      new Request("https://worker.example/api/config"),
      env,
    );
    const status = await handleRequest(
      new Request("https://worker.example/api/status"),
      env,
    );

    expect(config.status).toBe(200);
    expect(status.status).toBe(200);
    expect(
      stateRequests.map((request) => new URL(request.url).pathname),
    ).toEqual(["/config", "/status"]);
    expect(agentRequests).toHaveLength(0);
  });

  it("hides protected endpoints when the bearer token is missing", async () => {
    const { env, agentRequests, stateRequests } = testEnvironment();
    const response = await handleRequest(
      new Request("https://worker.example/api/config", {
        method: "PUT",
        body: JSON.stringify(DEFAULT_CONFIG),
      }),
      env,
    );

    expect(response.status).toBe(404);
    expect(agentRequests).toHaveLength(0);
    expect(stateRequests).toHaveLength(0);
  });

  it("protects and forwards diagnostic logs to the State DO", async () => {
    const { env, agentRequests, stateRequests } = testEnvironment();
    const hidden = await handleRequest(
      new Request("https://worker.example/api/logs"),
      env,
    );
    const visible = await handleRequest(
      new Request("https://worker.example/api/logs", {
        headers: { Authorization: "Bearer secret-value" },
      }),
      env,
    );

    expect(hidden.status).toBe(404);
    expect(visible.status).toBe(200);
    expect(stateRequests).toHaveLength(1);
    expect(new URL(stateRequests[0]!.url).pathname).toBe("/logs");
    expect(agentRequests).toHaveLength(0);
  });

  it("forwards authorized configuration writes to the State DO", async () => {
    const { env, agentRequests, stateRequests } = testEnvironment();
    const body = JSON.stringify(DEFAULT_CONFIG);
    const response = await handleRequest(
      new Request("https://worker.example/api/config", {
        method: "PUT",
        headers: { Authorization: "Bearer secret-value" },
        body,
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(stateRequests).toHaveLength(1);
    expect(stateRequests[0]!.method).toBe("PUT");
    expect(await stateRequests[0]!.text()).toBe(body);
    expect(agentRequests).toHaveLength(0);
  });

  it("rejects oversized protected requests before forwarding", async () => {
    const { env, agentRequests, stateRequests } = testEnvironment();
    const response = await handleRequest(
      new Request("https://worker.example/api/config", {
        method: "PUT",
        headers: {
          Authorization: "Bearer secret-value",
          "Content-Length": String(64 * 1024 + 1),
        },
        body: "{}",
      }),
      env,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "REQUEST_TOO_LARGE" });
    expect(agentRequests).toHaveLength(0);
    expect(stateRequests).toHaveLength(0);
  });

  it("persists control actions before notifying the Agent", async () => {
    const { env, agentRequests, stateRequests } = testEnvironment();
    const background: Promise<unknown>[] = [];
    const context = {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    };
    const invalid = await handleRequest(
      new Request("https://worker.example/api/control", {
        method: "POST",
        headers: { Authorization: "Bearer secret-value" },
        body: JSON.stringify({ action: "restart" }),
      }),
      env,
      context,
    );
    const valid = await handleRequest(
      new Request("https://worker.example/control", {
        method: "POST",
        headers: { Authorization: "Bearer secret-value" },
        body: JSON.stringify({ action: "start" }),
      }),
      env,
      context,
    );
    await Promise.all(background);

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "INVALID_CONTROL" });
    expect(valid.status).toBe(200);
    expect(stateRequests).toHaveLength(1);
    expect(new URL(stateRequests[0]!.url).pathname).toBe("/control");
    expect(agentRequests).toHaveLength(1);
    expect(new URL(agentRequests[0]!.url).pathname).toBe("/ensure");
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const { env, assetRequests } = testEnvironment();
    const response = await handleRequest(
      new Request("https://worker.example/api/missing"),
      env,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
    expect(assetRequests).toHaveLength(0);
  });
});

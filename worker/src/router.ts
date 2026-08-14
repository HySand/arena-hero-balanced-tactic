import { authorized, isControlAction } from "./control";
import { DIAGNOSTIC_STATE_INSTANCE, PRIMARY_STATE_INSTANCE } from "./instances";
import {
  CONFIG_SCHEMA,
  parsePythonStrategyConfig,
  type PythonStrategyConfig,
} from "./python-strategy/config";

const MAX_REQUEST_BYTES = 64 * 1024;

interface InternalFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface RequestEnvironment {
  ADMIN_CONTROL_SECRET: string;
  AGENT: {
    getByName(name: string): InternalFetcher;
  };
  STATE: {
    getByName(name: string): InternalFetcher;
  };
  ASSETS: InternalFetcher;
}

interface RequestContext {
  waitUntil(promise: Promise<unknown>): void;
}

export async function handleRequest(
  request: Request,
  env: RequestEnvironment,
  context?: RequestContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/health" && request.method === "GET") {
    return Response.json({ ok: true, service: "arena-hero-worker" });
  }
  if (url.pathname === "/api/schema" && request.method === "GET") {
    return Response.json(CONFIG_SCHEMA);
  }
  if (url.pathname === "/api/config" && request.method === "GET") {
    return state(env).fetch("https://state.internal/config");
  }
  if (url.pathname === "/api/config" && request.method === "PUT") {
    if (!authorizedRequest(request, env.ADMIN_CONTROL_SECRET)) {
      return new Response(null, { status: 404 });
    }
    const body = await readRequestBody(request);
    if (body instanceof Response) return body;
    return state(env).fetch("https://state.internal/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    });
  }
  if (url.pathname === "/api/status" && request.method === "GET") {
    return statusResponse(env);
  }
  if (url.pathname === "/api/logs" && request.method === "GET") {
    if (!authorizedRequest(request, env.ADMIN_CONTROL_SECRET)) {
      return new Response(null, { status: 404 });
    }
    return diagnostics(env).fetch("https://state.internal/logs");
  }
  if (url.pathname === "/api/control" && request.method === "GET") {
    return state(env).fetch("https://state.internal/manual-control");
  }
  if (url.pathname === "/api/control" && request.method === "POST") {
    if (!authorizedRequest(request, env.ADMIN_CONTROL_SECRET)) {
      return new Response(null, { status: 404 });
    }
    const body = await readRequestBody(request);
    if (body instanceof Response) return body;
    return state(env).fetch("https://state.internal/manual-control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  }
  if (url.pathname === "/api/control" && request.method === "DELETE") {
    if (!authorizedRequest(request, env.ADMIN_CONTROL_SECRET)) {
      return new Response(null, { status: 404 });
    }
    return state(env).fetch("https://state.internal/manual-control", {
      method: "DELETE",
    });
  }
  if (url.pathname === "/control" && request.method === "POST") {
    if (!authorizedRequest(request, env.ADMIN_CONTROL_SECRET)) {
      return new Response(null, { status: 404 });
    }
    const body = await readRequestBody(request);
    if (body instanceof Response) return body;
    let action: unknown;
    try {
      action = JSON.parse(body);
    } catch {
      return Response.json({ error: "INVALID_CONTROL" }, { status: 400 });
    }
    if (!isControlAction(action)) {
      return Response.json({ error: "INVALID_CONTROL" }, { status: 400 });
    }
    const response = await state(env).fetch("https://state.internal/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (response.ok && context) {
      context.waitUntil(
        agent(env)
          .fetch("https://agent.internal/ensure", { method: "POST" })
          .then(() => undefined),
      );
    }
    return response;
  }
  if (url.pathname.startsWith("/api/") || url.pathname === "/control") {
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  return env.ASSETS.fetch(request);
}

function agent(env: RequestEnvironment): InternalFetcher {
  return env.AGENT.getByName(PRIMARY_STATE_INSTANCE);
}

function state(env: RequestEnvironment): InternalFetcher {
  return env.STATE.getByName(PRIMARY_STATE_INSTANCE);
}

function diagnostics(env: RequestEnvironment): InternalFetcher {
  return env.STATE.getByName(DIAGNOSTIC_STATE_INSTANCE);
}

async function statusResponse(env: RequestEnvironment): Promise<Response> {
  const stateStub = state(env);
  const response = await stateStub.fetch("https://state.internal/status");
  if (!response.ok) return response;

  const status = await response.json<unknown>();
  const configResponse = await stateStub.fetch("https://state.internal/config");
  if (!configResponse.ok) return Response.json(status);

  try {
    const config = parsePythonStrategyConfig(await configResponse.json());
    return Response.json(reconcileDashboardPhase(status, config));
  } catch {
    return Response.json(status);
  }
}

export function reconcileDashboardPhase(
  status: unknown,
  config: PythonStrategyConfig,
): unknown {
  if (!isRecord(status)) return status;
  const population = status.population;
  if (typeof population !== "number" || !Number.isSafeInteger(population)) {
    return status;
  }
  if (
    config.pacing.enabled &&
    population < config.pacing.early_population &&
    status.strategy_phase !== "EARLY"
  ) {
    return {
      ...status,
      strategy_phase: "EARLY",
      resource_radius: config.pacing.early_resource_radius,
      exploration_radius: config.pacing.early_exploration_radius,
    };
  }
  if (
    status.strategy_phase !== "LATE" ||
    !config.pacing.enabled ||
    population >= config.pacing.mid_population
  ) {
    return status;
  }
  return {
    ...status,
    strategy_phase: "MID",
    resource_radius: config.pacing.mid_resource_radius,
    exploration_radius: config.pacing.mid_exploration_radius,
  };
}

function authorizedRequest(request: Request, secret: string): boolean {
  return authorized(request.headers.get("Authorization"), secret);
}

async function readRequestBody(request: Request): Promise<string | Response> {
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "REQUEST_TOO_LARGE" }, { status: 413 });
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "REQUEST_TOO_LARGE" }, { status: 413 });
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

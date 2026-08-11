import { authorized, isControlAction } from "./control";
import { CONFIG_SCHEMA } from "./strategy/config";

const INSTANCE_NAME = "arena-hero-primary";
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
    return state(env).fetch("https://state.internal/status");
  }
  if (url.pathname === "/api/logs" && request.method === "GET") {
    if (!authorizedRequest(request, env.ADMIN_CONTROL_SECRET)) {
      return new Response(null, { status: 404 });
    }
    return state(env).fetch("https://state.internal/logs");
  }
  if (
    (url.pathname === "/api/control" || url.pathname === "/control") &&
    request.method === "POST"
  ) {
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
  return env.AGENT.getByName(INSTANCE_NAME);
}

function state(env: RequestEnvironment): InternalFetcher {
  return env.STATE.getByName(INSTANCE_NAME);
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

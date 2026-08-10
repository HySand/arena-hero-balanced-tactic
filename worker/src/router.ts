import { authorized, isControlAction } from "./control";
import { CONFIG_SCHEMA } from "./strategy/config";

const AGENT_NAME = "arena-hero-primary";
const MAX_REQUEST_BYTES = 64 * 1024;

interface AgentFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface RequestEnvironment {
  ADMIN_CONTROL_SECRET: string;
  AGENT: {
    getByName(name: string): AgentFetcher;
  };
  ASSETS: AgentFetcher;
}

export async function handleRequest(
  request: Request,
  env: RequestEnvironment,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/health" && request.method === "GET") {
    return Response.json({ ok: true, service: "arena-hero-worker" });
  }
  if (url.pathname === "/api/schema" && request.method === "GET") {
    return Response.json(CONFIG_SCHEMA);
  }
  if (url.pathname === "/api/config" && request.method === "GET") {
    return agent(env).fetch("https://agent.internal/config");
  }
  if (url.pathname === "/api/config" && request.method === "PUT") {
    if (!authorizedRequest(request, env.ADMIN_CONTROL_SECRET)) {
      return new Response(null, { status: 404 });
    }
    const body = await readRequestBody(request);
    if (body instanceof Response) return body;
    return agent(env).fetch("https://agent.internal/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    });
  }
  if (url.pathname === "/api/status" && request.method === "GET") {
    return agent(env).fetch("https://agent.internal/status");
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
    return agent(env).fetch("https://agent.internal/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  }
  if (url.pathname.startsWith("/api/") || url.pathname === "/control") {
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  return env.ASSETS.fetch(request);
}

function agent(env: RequestEnvironment): AgentFetcher {
  return env.AGENT.getByName(AGENT_NAME);
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

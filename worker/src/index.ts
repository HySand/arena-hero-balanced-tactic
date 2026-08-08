import type { Env } from "./supervisor";
import { authorized, isControlAction } from "./control";

export { ArenaHeroAgent } from "./supervisor";

const AGENT_NAME = "arena-hero-primary";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/control") {
      return new Response(null, { status: 404 });
    }
    if (
      !authorized(
        request.headers.get("Authorization"),
        env.ADMIN_CONTROL_SECRET,
      )
    ) {
      return new Response(null, { status: 404 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "INVALID_CONTROL" }, { status: 400 });
    }
    if (!isControlAction(body)) {
      return Response.json({ error: "INVALID_CONTROL" }, { status: 400 });
    }
    const stub = env.AGENT.getByName(AGENT_NAME);
    return stub.fetch("https://agent.internal/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const stub = env.AGENT.getByName(AGENT_NAME);
    const response = await stub.fetch("https://agent.internal/ensure", {
      method: "POST",
    });
    if (!response.ok)
      throw new Error(`Scheduled ensure failed: ${response.status}`);
  },
} satisfies ExportedHandler<Env>;

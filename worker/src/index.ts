import type { Env } from "./supervisor";
import { handleRequest } from "./router";

export { handleRequest } from "./router";
export { ArenaHeroAgent } from "./supervisor";

const AGENT_NAME = "arena-hero-primary";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
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

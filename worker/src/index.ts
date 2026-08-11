import { handleRequest } from "./router";
import { PRIMARY_STATE_INSTANCE } from "./instances";
import type { Env } from "./supervisor";

export { handleRequest } from "./router";
export { ArenaHeroState } from "./state";
export { ArenaHeroAgent } from "./supervisor";

export default {
  fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    return handleRequest(request, env, context);
  },

  scheduled(
    _controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): void {
    const stub = env.AGENT.getByName(PRIMARY_STATE_INSTANCE);
    context.waitUntil(
      stub
        .fetch("https://agent.internal/ensure", { method: "POST" })
        .then(() => undefined),
    );
  },
} satisfies ExportedHandler<Env>;

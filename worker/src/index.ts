import { consumeCommandMessages } from "./command-consumer";
import type { WorkerQueueMessage } from "./queue-message";
import { handleRequest } from "./router";
import type { Env } from "./supervisor";

export { handleRequest } from "./router";
export { ArenaHeroState } from "./state";
export { ArenaHeroAgent } from "./supervisor";

const INSTANCE_NAME = "arena-hero-primary";

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
    const stub = env.AGENT.getByName(INSTANCE_NAME);
    context.waitUntil(
      stub
        .fetch("https://agent.internal/ensure", { method: "POST" })
        .then(() => undefined),
    );
  },

  async queue(
    batch: MessageBatch<WorkerQueueMessage>,
    env: Env,
  ): Promise<void> {
    await consumeCommandMessages(batch.messages, env);
  },
} satisfies ExportedHandler<Env, WorkerQueueMessage>;

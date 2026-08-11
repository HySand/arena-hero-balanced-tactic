import { consumeCommandMessages } from "./command-consumer";
import { handleRequest } from "./router";
import type { Env, StoredSubmission } from "./supervisor";

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

  async queue(batch: MessageBatch<StoredSubmission>, env: Env): Promise<void> {
    await consumeCommandMessages(batch.messages, env);
  },
} satisfies ExportedHandler<Env, StoredSubmission>;

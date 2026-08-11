import type { Env, StoredSubmission } from "./supervisor";
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

  async queue(batch: MessageBatch<StoredSubmission>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const submission = message.body;
      const response = await fetch(
        "https://api.arenahero.io/api/v1/game/commands",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.ARENA_HERO_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": submission.key,
          },
          body: submission.body,
        },
      );
      const stub = env.AGENT.getByName(AGENT_NAME);
      await stub.fetch("https://agent.internal/submission-result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event:
            response.status === 202 ? "command_accepted" : "command_rejected",
          tick: submission.tick,
          details: { status: response.status, attempts: message.attempts },
        }),
      });
      if (response.status >= 500) {
        message.retry({ delaySeconds: 1 });
      } else {
        message.ack();
      }
    }
  },
} satisfies ExportedHandler<Env, StoredSubmission>;

import { DurableObject } from "cloudflare:workers";

import { submitArenaCommand, type StoredSubmission } from "./arena-command";
import type { ArenaHeroState, DiagnosticRecord } from "./state";

interface BrokerEnv extends Cloudflare.Env {
  STATE: DurableObjectNamespace<ArenaHeroState>;
  ARENA_HERO_API_KEY: string;
}

export class ArenaHeroCommandBroker extends DurableObject<BrokerEnv> {
  private submitting = false;

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== "/submit" || request.method !== "POST") {
      return new Response(null, { status: 404 });
    }
    const submission = await request.json<StoredSubmission>();
    if (
      !Number.isInteger(submission.tick) ||
      typeof submission.key !== "string" ||
      typeof submission.body !== "string"
    ) {
      return Response.json({ error: "INVALID_SUBMISSION" }, { status: 400 });
    }
    if (!this.submitting) {
      this.submitting = true;
      void this.submit(submission)
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              event: "broker_submit_failed",
              reason: errorName(error),
              tick: submission.tick,
            }),
          );
        })
        .finally(() => {
          this.submitting = false;
        });
    }
    return new Response(null, { status: 202 });
  }

  private async submit(submission: StoredSubmission): Promise<void> {
    const result = await submitArenaCommand(
      submission,
      this.env.ARENA_HERO_API_KEY,
    );
    const record: DiagnosticRecord = {
      at: new Date().toISOString(),
      event: result.event,
      tick: result.tick,
      details: result.details,
    };
    const response = await this.env.STATE.getByName("arena-hero-primary").fetch(
      "https://state.internal/diagnostic",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      },
    );
    if (!response.ok) {
      throw new Error(`Broker diagnostic rejected: ${response.status}`);
    }
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

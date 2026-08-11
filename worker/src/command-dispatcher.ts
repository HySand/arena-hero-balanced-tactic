import { WorkerEntrypoint } from "cloudflare:workers";

import { submitArenaCommand, type StoredSubmission } from "./arena-command";
import { DIAGNOSTIC_STATE_INSTANCE } from "./instances";
import type { ArenaHeroState, DiagnosticRecord } from "./state";

interface DispatcherEnv extends Cloudflare.Env {
  STATE: DurableObjectNamespace<ArenaHeroState>;
  ARENA_HERO_API_KEY: string;
}

export class ArenaCommandDispatcher extends WorkerEntrypoint<DispatcherEnv> {
  submit(submission: StoredSubmission): void {
    this.ctx.waitUntil(this.dispatch(submission));
  }

  private async dispatch(submission: StoredSubmission): Promise<void> {
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
    try {
      const response = await this.env.STATE.getByName(
        DIAGNOSTIC_STATE_INSTANCE,
      ).fetch("https://state.internal/diagnostic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      });
      if (!response.ok) {
        console.error(
          JSON.stringify({
            event: "command_diagnostic_rejected",
            status: response.status,
            tick: submission.tick,
          }),
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "command_diagnostic_failed",
          reason: errorName(error),
          tick: submission.tick,
        }),
      );
    }
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

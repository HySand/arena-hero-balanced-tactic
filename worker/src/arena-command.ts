export interface StoredSubmission {
  tick: number;
  key: string;
  body: string;
}

export interface CommandResult {
  event: "command_accepted" | "command_rejected" | "command_submit_failed";
  tick: number;
  details: Record<string, string | number>;
}

export async function submitArenaCommand(
  submission: StoredSubmission,
  apiKey: string,
): Promise<CommandResult> {
  const startedAt = Date.now();
  try {
    const response = await fetch(
      "https://api.arenahero.io/api/v1/game/commands",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": submission.key,
        },
        body: submission.body,
      },
    );
    const payload = await safeJson(response);
    const errorCode =
      typeof payload?.error === "string" ? payload.error : undefined;
    return {
      event: response.status === 202 ? "command_accepted" : "command_rejected",
      tick: submission.tick,
      details: {
        status: response.status,
        durationMs: Date.now() - startedAt,
        ...(errorCode ? { error: errorCode } : {}),
      },
    };
  } catch (error) {
    return {
      event: "command_submit_failed",
      tick: submission.tick,
      details: {
        reason: errorName(error),
        durationMs: Date.now() - startedAt,
      },
    };
  }
}

async function safeJson(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await response.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

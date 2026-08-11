import type { StoredSubmission } from "./supervisor";

const COMMAND_URL = "https://api.arenahero.io/api/v1/game/commands";
const COMMAND_TIMEOUT_MS = 5000;
const RESULT_TIMEOUT_MS = 2000;

interface CommandConsumerEnv {
  AGENT: {
    getByName(name: string): {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };
  };
  ARENA_HERO_API_KEY: string;
}

interface CommandMessage {
  readonly body: StoredSubmission;
  readonly attempts: number;
  retry(options?: QueueRetryOptions): void;
  ack(): void;
}

interface SubmissionResult {
  event: "command_accepted" | "command_rejected" | "command_retry_scheduled";
  tick: number;
  details: Record<string, string | number>;
}

export async function consumeCommandMessages(
  messages: readonly CommandMessage[],
  env: CommandConsumerEnv,
): Promise<void> {
  for (const message of messages) {
    await consumeCommand(message, env);
  }
}

async function consumeCommand(
  message: CommandMessage,
  env: CommandConsumerEnv,
): Promise<void> {
  const submission = message.body;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      COMMAND_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.ARENA_HERO_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": submission.key,
        },
        body: submission.body,
      },
      COMMAND_TIMEOUT_MS,
    );
  } catch (error) {
    await reportSubmissionResult(env, {
      event: "command_retry_scheduled",
      tick: submission.tick,
      details: { reason: errorName(error), attempts: message.attempts },
    });
    message.retry({ delaySeconds: 1 });
    return;
  }

  void response.body?.cancel().catch(() => undefined);
  if (response.status === 202) {
    await reportSubmissionResult(env, {
      event: "command_accepted",
      tick: submission.tick,
      details: { status: response.status, attempts: message.attempts },
    });
    message.ack();
    return;
  }

  if (response.status >= 500) {
    await reportSubmissionResult(env, {
      event: "command_retry_scheduled",
      tick: submission.tick,
      details: { status: response.status, attempts: message.attempts },
    });
    message.retry({ delaySeconds: 1 });
    return;
  }

  await reportSubmissionResult(env, {
    event: "command_rejected",
    tick: submission.tick,
    details: { status: response.status, attempts: message.attempts },
  });
  message.ack();
}

async function reportSubmissionResult(
  env: CommandConsumerEnv,
  result: SubmissionResult,
): Promise<void> {
  const stub = env.AGENT.getByName("arena-hero-primary");
  try {
    const response = await promiseWithTimeout(
      stub.fetch("https://agent.internal/submission-result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      }),
      RESULT_TIMEOUT_MS,
    );
    if (!response.ok) {
      console.error(
        JSON.stringify({
          event: "submission_result_rejected",
          status: response.status,
          tick: result.tick,
        }),
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "submission_result_failed",
        reason: errorName(error),
        tick: result.tick,
      }),
    );
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  return promiseWithTimeout(
    fetch(input, { ...init, signal: controller.signal }),
    timeoutMs,
    () => controller.abort(),
  );
}

async function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout?.();
      reject(new DOMException("Request timeout", "TimeoutError"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

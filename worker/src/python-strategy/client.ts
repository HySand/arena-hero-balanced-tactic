import type { PythonStrategyRequest, PythonStrategyResult } from "./wire";
import {
  decodePythonStrategyResponse,
  PythonStrategyServiceError,
  stableStringify,
} from "./wire";

interface InternalFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

export async function requestPythonStrategy(
  fetcher: InternalFetcher,
  request: PythonStrategyRequest,
  timeoutMs: number,
): Promise<PythonStrategyResult> {
  const startedAt = Date.now();
  const requestBody = stableStringify(request);
  if (new TextEncoder().encode(requestBody).byteLength > MAX_REQUEST_BYTES) {
    throw new PythonStrategyServiceError(
      "REQUEST_TOO_LARGE",
      "Python strategy request exceeds the configured limit",
      false,
    );
  }
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(
        new PythonStrategyServiceError(
          "TIMEOUT",
          "Python strategy request timed out",
          true,
        ),
      );
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetcher.fetch("https://strategy.internal/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
        signal: controller.signal,
      }),
      timeout,
    ]);
    const responseBody = await response.text();
    return {
      ...decodePythonStrategyResponse(responseBody, request),
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof PythonStrategyServiceError) throw error;
    throw new PythonStrategyServiceError(
      "UNAVAILABLE",
      error instanceof Error ? error.name : "UnknownError",
      true,
    );
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

import { DurableObject } from "cloudflare:workers";

import type {
  CommandPlan,
  DecisionSummary,
  ReceivedData,
  StrategyMemory,
} from "./contracts";
import { isControlAction } from "./control";
import { decodeGameMessage, serializePlan } from "./protocol";
import { emptyMemory, planTick, safeFallbackPlan } from "./strategy/planner";
import {
  DEFAULT_CONFIG,
  parseStrategyConfig,
  type StrategyConfig,
} from "./strategy/config";
import { validatePlan } from "./strategy/validation";

const GAME_WS_URL = "https://api.arenahero.io/api/v1/game/ws";
const COMMAND_URL = "https://api.arenahero.io/api/v1/game/commands";
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5000;
const COMMAND_TIMEOUT_MS = 5000;

export interface Env extends Cloudflare.Env {
  ASSETS: Fetcher;
  ARENA_HERO_API_KEY: string;
  ADMIN_CONTROL_SECRET: string;
}

type DesiredState = "running" | "stopped";
type ConnectionPhase = "idle" | "connecting" | "open" | "blocked";

interface StoredState {
  desired: DesiredState;
  authBlocked: boolean;
  memory: StrategyMemory;
}

interface StoredSubmission {
  tick: number;
  key: string;
  body: string;
}

interface StoredStatus {
  tick: number;
  updatedAt: string;
  summary?: DecisionSummary;
}

interface StoredConnectionStatus {
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
  lastCloseCode?: number;
  lastError?: string | null;
  reconnectAttempt?: number;
  nextReconnectAt?: string | null;
}

interface DiagnosticRecord {
  at: string;
  event: string;
  tick?: number;
  details?: Record<string, string | number | boolean | null>;
}

interface DiagnosticSnapshot {
  current?: DiagnosticRecord;
  recent: DiagnosticRecord[];
}

function structuredLog(
  event: string,
  fields: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ event, ...fields }));
}

function jitteredBackoff(attempt: number): number {
  const base = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_MIN_MS * 2 ** Math.min(attempt, 5),
  );
  return Math.floor(base * (0.75 + Math.random() * 0.5));
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export class ArenaHeroAgent extends DurableObject<Env> {
  private socket: WebSocket | undefined;
  private phase: ConnectionPhase = "idle";
  private reconnectAttempt = 0;
  private announcedTick: number | undefined;
  private strategyConfig: StrategyConfig | undefined;
  private receipts: Partial<Record<"AGENT" | "MANUAL", ReceivedData>> = {};
  private messageChain: Promise<void> = Promise.resolve();
  private submissionActive = false;
  private pendingSubmission: StoredSubmission | undefined;

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/control") {
      const data: unknown = await request.json();
      if (!isControlAction(data))
        return jsonResponse({ error: "INVALID_CONTROL" }, 400);
      return this.setDesiredState(
        data.action === "start" ? "running" : "stopped",
      );
    }
    if (path === "/config" && request.method === "GET") {
      return jsonResponse(await this.getStrategyConfig());
    }
    if (path === "/config" && request.method === "PUT") {
      try {
        const config = parseStrategyConfig(await request.json());
        await this.ctx.storage.put({
          strategyConfig: config,
          configUpdatedAt: new Date().toISOString(),
        });
        this.strategyConfig = config;
        return jsonResponse({ ok: true, config });
      } catch (error) {
        return jsonResponse(
          { error: error instanceof Error ? error.message : "INVALID_CONFIG" },
          422,
        );
      }
    }
    if (path === "/status" && request.method === "GET") {
      return this.statusResponse();
    }
    if (path === "/logs" && request.method === "GET") {
      return jsonResponse(await this.diagnosticSnapshot());
    }
    if (request.method === "POST" && path === "/ensure") {
      await this.ensureRunning();
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }

  override async alarm(): Promise<void> {
    await this.ensureRunning();
  }

  private async loadState(): Promise<StoredState> {
    const [desired, authBlocked, memory] = await Promise.all([
      this.ctx.storage.get<DesiredState>("desired"),
      this.ctx.storage.get<boolean>("authBlocked"),
      this.ctx.storage.get<StrategyMemory>("strategyMemory"),
    ]);
    const resolvedDesired = desired ?? "running";
    if (!desired) await this.ctx.storage.put("desired", resolvedDesired);
    return {
      desired: resolvedDesired,
      authBlocked: authBlocked ?? false,
      memory: memory ?? emptyMemory(),
    };
  }

  private async getStrategyConfig(): Promise<StrategyConfig> {
    if (this.strategyConfig) return this.strategyConfig;
    this.strategyConfig =
      (await this.ctx.storage.get<StrategyConfig>("strategyConfig")) ??
      DEFAULT_CONFIG;
    return this.strategyConfig;
  }

  private async statusResponse(): Promise<Response> {
    if (this.phase === "idle") this.ctx.waitUntil(this.ensureRunning());
    const [desired, authBlocked, status, configUpdatedAt, connection] =
      await Promise.all([
        this.ctx.storage.get<DesiredState>("desired"),
        this.ctx.storage.get<boolean>("authBlocked"),
        this.ctx.storage.get<StoredStatus>("lastStatus"),
        this.ctx.storage.get<string>("configUpdatedAt"),
        this.ctx.storage.get<StoredConnectionStatus>("connectionStatus"),
      ]);
    return jsonResponse({
      desired: desired ?? "running",
      phase: this.phase,
      connected: this.phase === "open",
      authBlocked: authBlocked ?? false,
      tick: status?.tick,
      updatedAt: status?.updatedAt,
      configUpdatedAt,
      summary: status?.summary,
      connection,
    });
  }

  private async setDesiredState(desired: DesiredState): Promise<Response> {
    await this.ctx.storage.put("desired", desired);
    if (desired === "stopped") {
      this.phase = "idle";
      this.socket?.close(1000, "stopped");
      this.socket = undefined;
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.put("authBlocked", false);
      if (this.phase === "blocked") this.phase = "idle";
      await this.ensureRunning();
    }
    return jsonResponse({ desired });
  }

  private async ensureRunning(): Promise<void> {
    const stored = await this.loadState();
    if (stored.desired !== "running" || stored.authBlocked) {
      this.phase = stored.authBlocked ? "blocked" : "idle";
      return;
    }
    if (this.phase === "connecting" || this.phase === "open") return;
    await this.connectGame();
  }

  private async connectGame(): Promise<void> {
    this.phase = "connecting";
    await this.recordDiagnostic("connect_started");
    let response: Response;
    try {
      response = await fetch(GAME_WS_URL, {
        headers: {
          Authorization: `Bearer ${this.env.ARENA_HERO_API_KEY}`,
          Upgrade: "websocket",
        },
      });
    } catch (error) {
      const reason = errorName(error);
      structuredLog("ws_connect_failed", { reason });
      await this.updateConnectionStatus({
        lastError: `ws_connect_failed:${reason}`,
      });
      await this.scheduleReconnect();
      return;
    }

    if (response.status === 401 || response.status === 403) {
      await this.blockAuthentication(`handshake_${response.status}`);
      return;
    }
    if (response.status !== 101 || !response.webSocket) {
      structuredLog("ws_upgrade_failed", { status: response.status });
      await this.updateConnectionStatus({
        lastError: `ws_upgrade_failed:${response.status}`,
      });
      await this.scheduleReconnect();
      return;
    }

    const socket = response.webSocket;
    this.socket = socket;
    this.phase = "open";
    this.reconnectAttempt = 0;
    this.announcedTick = undefined;
    socket.accept();
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data !== "string") {
        structuredLog("ws_binary_ignored");
        return;
      }
      this.messageChain = this.messageChain
        .then(() => this.handleMessage(socket, event.data as string))
        .catch((error: unknown) => {
          const reason = errorName(error);
          structuredLog("message_failed", { reason });
          this.ctx.waitUntil(
            Promise.all([
              this.updateConnectionStatus({
                lastError: `message_failed:${reason}`,
              }),
              this.recordDiagnostic("message_failed", undefined, { reason }),
            ]).then(() => undefined),
          );
        });
    });
    socket.addEventListener("close", (event) => {
      this.ctx.waitUntil(this.handleClose(socket, event.code));
    });
    socket.addEventListener("error", () => {
      structuredLog("ws_error");
      this.ctx.waitUntil(
        this.updateConnectionStatus({ lastError: "ws_error" }),
      );
    });
    await Promise.all([
      this.ctx.storage.deleteAlarm(),
      this.updateConnectionStatus({
        lastConnectedAt: new Date().toISOString(),
        lastError: null,
        reconnectAttempt: 0,
        nextReconnectAt: null,
      }),
    ]);
    await this.recordDiagnostic("ws_connected");
    structuredLog("ws_connected");
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    if (this.socket !== socket) return;
    await this.recordDiagnostic("ws_text_received", undefined, {
      bytes: new TextEncoder().encode(raw).byteLength,
      envelope: messageEnvelopeHint(raw),
    });
    const message = decodeGameMessage(raw);
    if (!message) {
      structuredLog("ws_message_rejected");
      return;
    }
    switch (message.type) {
      case "tick":
        this.announcedTick = message.data;
        await this.recordDiagnostic("tick_received", message.data);
        return;
      case "received":
        this.receipts[message.data.source] = message.data;
        await this.recordDiagnostic("plan_received", message.data.tick, {
          source: message.data.source,
        });
        structuredLog("plan_received", {
          tick: message.data.tick,
          source: message.data.source,
        });
        return;
      case "state":
        if (!this.announcedTick) {
          structuredLog("state_without_tick");
          return;
        }
        await this.handleState(this.announcedTick, message.data);
    }
  }

  private async handleState(
    tick: number,
    state: Parameters<typeof planTick>[1],
  ): Promise<void> {
    await this.recordDiagnostic("state_received", tick, {
      population: state.population,
      objects: state.objects.length,
      events: state.events.length,
    });
    const existing =
      await this.ctx.storage.get<StoredSubmission>("lastSubmission");
    if (existing?.tick === tick) {
      structuredLog("plan_replay", { tick });
      await this.submitSerialized(existing);
      return;
    }
    const [storedMemory, config] = await Promise.all([
      this.ctx.storage.get<StrategyMemory>("strategyMemory"),
      this.getStrategyConfig(),
    ]);
    const memory = storedMemory ?? emptyMemory();
    let plan: CommandPlan;
    let nextMemory = memory;
    let summary: ReturnType<typeof planTick>["summary"] | undefined;
    await this.recordDiagnostic("planner_started", tick, {
      obstacles: Object.keys(memory.obstacles).length,
      explored: Object.keys(memory.explored).length,
      resources: Object.keys(memory.resources).length,
      enemies: Object.keys(memory.enemies).length,
    });
    try {
      const result = planTick(tick, state, memory, config);
      await this.recordDiagnostic("planner_completed", tick, {
        actions: Object.keys(result.plan.unit_actions ?? {}).length,
      });
      plan = validatePlan(result.plan, state)
        ? result.plan
        : safeFallbackPlan(tick, state);
      nextMemory = result.memory;
      summary = result.summary;
    } catch (error) {
      const reason = errorName(error);
      await this.recordDiagnostic("planner_failed", tick, { reason });
      structuredLog("planner_failed", { tick, reason });
      plan = safeFallbackPlan(tick, state);
    }
    await this.recordDiagnostic("status_save_started", tick);
    await this.ctx.storage.put({
      strategyMemory: nextMemory,
      lastStatus: {
        tick,
        updatedAt: new Date().toISOString(),
        ...(summary ? { summary } : {}),
      } satisfies StoredStatus,
    });
    await this.recordDiagnostic("status_saved", tick);
    structuredLog("plan_computed", {
      tick,
      posture: summary?.posture,
      threatened: summary?.threatened,
      retreating: summary?.retreating,
      controlRadius: summary?.controlRadius,
      reserveCount: summary?.reserveCount,
      planningMs: summary ? Math.round(summary.planningMs) : undefined,
      actions: summary?.actions ?? {},
    });
    const submission: StoredSubmission = {
      tick: plan.tick,
      key: `agent-${plan.tick}-primary`,
      body: serializePlan(plan),
    };
    await this.ctx.storage.put("lastSubmission", submission);
    await this.recordDiagnostic("command_submit_queued", tick);
    this.queueSubmission(submission);
  }

  private queueSubmission(submission: StoredSubmission): void {
    this.pendingSubmission = submission;
    if (this.submissionActive) return;
    this.submissionActive = true;
    const task = this.drainSubmissions().finally(() => {
      this.submissionActive = false;
      if (this.pendingSubmission) this.queueSubmission(this.pendingSubmission);
    });
    this.ctx.waitUntil(task);
  }

  private async drainSubmissions(): Promise<void> {
    while (this.pendingSubmission) {
      const submission = this.pendingSubmission;
      this.pendingSubmission = undefined;
      try {
        await this.submitSerialized(submission);
      } catch (error) {
        const reason = errorName(error);
        await this.recordDiagnostic("command_task_failed", submission.tick, {
          reason,
        });
        structuredLog("command_task_failed", {
          tick: submission.tick,
          reason,
        });
      }
    }
  }

  private async submitSerialized(submission: StoredSubmission): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        await this.recordDiagnostic("command_submit_started", submission.tick, {
          attempt,
        });
        response = await fetchWithTimeout(
          COMMAND_URL,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.env.ARENA_HERO_API_KEY}`,
              "Content-Type": "application/json",
              "Idempotency-Key": submission.key,
            },
            body: submission.body,
          },
          COMMAND_TIMEOUT_MS,
        );
      } catch (error) {
        const reason = errorName(error);
        await this.recordDiagnostic(
          "command_transport_failed",
          submission.tick,
          {
            attempt,
            reason,
          },
        );
        structuredLog("plan_transport_failed", {
          tick: submission.tick,
          attempt,
          reason,
        });
        if (attempt < 2) await delay(jitteredBackoff(attempt));
        continue;
      }

      if (response.status === 202) {
        void response.body?.cancel().catch(() => undefined);
        await this.recordDiagnostic("command_accepted", submission.tick, {
          attempt,
        });
        structuredLog("plan_accepted", { tick: submission.tick, attempt });
        return;
      }
      const payload = await safeJson(response, COMMAND_TIMEOUT_MS);
      const errorCode =
        typeof payload?.error === "string" ? payload.error : undefined;
      if (response.status === 401) {
        await this.blockAuthentication("command_401");
        return;
      }
      if (
        response.status === 500 ||
        errorCode === "COMMAND_CONCURRENCY_LIMIT"
      ) {
        if (attempt < 2) await delay(jitteredBackoff(attempt));
        continue;
      }
      structuredLog("plan_rejected", {
        tick: submission.tick,
        status: response.status,
        error: errorCode,
      });
      return;
    }
    structuredLog("plan_retry_exhausted", { tick: submission.tick });
  }

  private async handleClose(socket: WebSocket, code: number): Promise<void> {
    if (this.socket !== socket) {
      structuredLog("ws_close_stale", { code });
      return;
    }
    this.socket = undefined;
    this.announcedTick = undefined;
    await this.updateConnectionStatus({
      lastDisconnectedAt: new Date().toISOString(),
      lastCloseCode: code,
    });
    if (code === 1008) {
      await this.blockAuthentication("ws_1008");
      return;
    }
    structuredLog("ws_closed", { code });
    await this.scheduleReconnect(true);
  }

  private async blockAuthentication(reason: string): Promise<void> {
    this.phase = "blocked";
    this.socket?.close(1000, "blocked");
    this.socket = undefined;
    await this.ctx.storage.put("authBlocked", true);
    await this.ctx.storage.deleteAlarm();
    structuredLog("agent_blocked", { reason });
  }

  private async scheduleReconnect(retryInline = false): Promise<void> {
    const desired =
      (await this.ctx.storage.get<DesiredState>("desired")) ?? "running";
    if (desired !== "running" || this.phase === "blocked") return;
    this.phase = "idle";
    const waitMs = jitteredBackoff(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    const reconnectAt = Date.now() + waitMs;
    await Promise.all([
      this.ctx.storage.setAlarm(reconnectAt),
      this.updateConnectionStatus({
        reconnectAttempt: this.reconnectAttempt,
        nextReconnectAt: new Date(reconnectAt).toISOString(),
      }),
    ]);
    structuredLog("reconnect_scheduled", {
      attempt: this.reconnectAttempt,
      waitMs,
    });
    if (!retryInline) return;
    await delay(waitMs);
    if (this.phase === "idle") await this.ensureRunning();
  }

  private async diagnosticSnapshot(): Promise<DiagnosticSnapshot> {
    const [current, recent] = await Promise.all([
      this.ctx.storage.get<DiagnosticRecord>("diagnosticCurrent"),
      this.ctx.storage.get<DiagnosticRecord[]>("diagnosticRecent"),
    ]);
    return {
      ...(current === undefined ? {} : { current }),
      recent: recent ?? [],
    };
  }

  private async recordDiagnostic(
    event: string,
    tick?: number,
    details?: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    const record: DiagnosticRecord = {
      at: new Date().toISOString(),
      event,
      ...(tick === undefined ? {} : { tick }),
      ...(details === undefined ? {} : { details }),
    };
    const recent =
      (await this.ctx.storage.get<DiagnosticRecord[]>("diagnosticRecent")) ??
      [];
    await this.ctx.storage.put({
      diagnosticCurrent: record,
      diagnosticRecent: [...recent, record].slice(-40),
    });
  }

  private async updateConnectionStatus(
    update: Partial<StoredConnectionStatus>,
  ): Promise<void> {
    const current =
      (await this.ctx.storage.get<StoredConnectionStatus>(
        "connectionStatus",
      )) ?? {};
    await this.ctx.storage.put("connectionStatus", { ...current, ...update });
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new DOMException("Request timeout", "TimeoutError"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetch(input, { ...init, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function messageEnvelopeHint(raw: string): string {
  const prefix = raw.slice(0, 80);
  if (/"type"\s*:\s*"tick"/.test(prefix)) return "tick";
  if (/"type"\s*:\s*"state"/.test(prefix)) return "state";
  if (/"type"\s*:\s*"received"/.test(prefix)) return "received";
  return "unknown";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function safeJson(
  response: Response,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await Promise.race([
      response.json(),
      delay(timeoutMs).then(() => {
        throw new DOMException("Response body timeout", "TimeoutError");
      }),
    ]);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

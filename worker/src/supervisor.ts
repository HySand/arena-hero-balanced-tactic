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
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5000;
const WS_CONNECT_TIMEOUT_MS = 5000;
const CONNECTION_STALE_MS = 90_000;

export interface Env extends Cloudflare.Env {
  ASSETS: Fetcher;
  COMMAND_QUEUE: Queue<StoredSubmission>;
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

export interface StoredSubmission {
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
  private lastMessageAt = 0;
  private strategyConfig: StrategyConfig | undefined;
  private receipts: Partial<Record<"AGENT" | "MANUAL", ReceivedData>> = {};
  private messageChain: Promise<void> = Promise.resolve();

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
    if (path === "/submission-result" && request.method === "POST") {
      const value: unknown = await request.json();
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return jsonResponse({ error: "INVALID_RESULT" }, 400);
      }
      const result = value as Record<string, unknown>;
      if (typeof result.event !== "string" || !Number.isInteger(result.tick)) {
        return jsonResponse({ error: "INVALID_RESULT" }, 400);
      }
      const details = diagnosticDetails(result.details);
      await this.recordDiagnostic(result.event, result.tick as number, details);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && path === "/ensure") {
      await this.scheduleEnsure();
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
    if (this.phase === "idle") await this.scheduleEnsure();
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
      await this.scheduleEnsure();
    }
    return jsonResponse({ desired });
  }

  private async ensureRunning(): Promise<void> {
    const stored = await this.loadState();
    if (stored.desired !== "running" || stored.authBlocked) {
      this.phase = stored.authBlocked ? "blocked" : "idle";
      return;
    }
    if (this.phase === "connecting") return;
    if (
      this.phase === "open" &&
      Date.now() - this.lastMessageAt < CONNECTION_STALE_MS
    ) {
      return;
    }
    if (this.phase === "open") {
      structuredLog("ws_stale", { lastMessageAt: this.lastMessageAt });
      await this.recordDiagnostic("ws_stale", undefined, {
        idleMs: Date.now() - this.lastMessageAt,
      });
      this.socket?.close(1012, "stale");
      this.socket = undefined;
      this.phase = "idle";
    }
    await this.connectGame();
  }

  private async scheduleEnsure(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now());
  }

  private async connectGame(): Promise<void> {
    this.phase = "connecting";
    await this.recordDiagnostic("connect_started");
    let response: Response;
    try {
      response = await fetchWithTimeout(
        GAME_WS_URL,
        {
          headers: {
            Authorization: `Bearer ${this.env.ARENA_HERO_API_KEY}`,
            Upgrade: "websocket",
          },
        },
        WS_CONNECT_TIMEOUT_MS,
      );
    } catch (error) {
      const reason = errorName(error);
      structuredLog("ws_connect_failed", { reason });
      await Promise.all([
        this.updateConnectionStatus({
          lastError: `ws_connect_failed:${reason}`,
        }),
        this.recordDiagnostic("ws_connect_failed", undefined, { reason }),
      ]);
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
    this.lastMessageAt = Date.now();
    this.reconnectAttempt = 0;
    this.announcedTick = undefined;
    socket.accept();
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.lastMessageAt = Date.now();
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
      await this.env.COMMAND_QUEUE.send(existing, { contentType: "json" });
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
    await this.env.COMMAND_QUEUE.send(submission, {
      contentType: "json",
    });
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
    await this.scheduleReconnect();
  }

  private async blockAuthentication(reason: string): Promise<void> {
    this.phase = "blocked";
    this.socket?.close(1000, "blocked");
    this.socket = undefined;
    await this.ctx.storage.put("authBlocked", true);
    await this.ctx.storage.deleteAlarm();
    structuredLog("agent_blocked", { reason });
  }

  private async scheduleReconnect(): Promise<void> {
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

function diagnosticDetails(
  value: unknown,
): Record<string, string | number | boolean | null> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const details: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(source)) {
    if (
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean" ||
      item === null
    ) {
      details[key] = item;
    }
  }
  return details;
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

import { DurableObject } from "cloudflare:workers";

import type { CommandPlan, ReceivedData, StrategyMemory } from "./contracts";
import { decodeStrategyMemory, encodeStrategyMemory } from "./memory-storage";
import { decodeGameMessage, serializePlan } from "./protocol";
import type { StoredSubmission, WorkerQueueMessage } from "./queue-message";
import type {
  AgentRuntimeSnapshot,
  ArenaHeroState,
  DiagnosticRecord,
} from "./state";
import { emptyMemory, planTick, safeFallbackPlan } from "./strategy/planner";
import { validatePlan } from "./strategy/validation";

const GAME_WS_URL = "https://api.arenahero.io/api/v1/game/ws";
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5000;
const WS_CONNECT_TIMEOUT_MS = 5000;
const CONNECTION_STALE_MS = 90_000;

export interface Env extends Cloudflare.Env {
  ASSETS: Fetcher;
  COMMAND_QUEUE: Queue<WorkerQueueMessage>;
  STATE: DurableObjectNamespace<ArenaHeroState>;
  ARENA_HERO_API_KEY: string;
  ADMIN_CONTROL_SECRET: string;
}

type ConnectionPhase = "idle" | "connecting" | "open" | "blocked";

interface StoredConnectionStatus {
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
  lastCloseCode?: number;
  lastError?: string | null;
  reconnectAttempt?: number;
  nextReconnectAt?: string | null;
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

export class ArenaHeroAgent extends DurableObject<Env> {
  private socket: WebSocket | undefined;
  private phase: ConnectionPhase = "idle";
  private reconnectAttempt = 0;
  private announcedTick: number | undefined;
  private lastMessageAt = 0;
  private strategyMemory: StrategyMemory | undefined;
  private receipts: Partial<Record<"AGENT" | "MANUAL", ReceivedData>> = {};
  private messageChain: Promise<void> = Promise.resolve();

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/ensure") {
      await this.scheduleEnsure();
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }

  override async alarm(): Promise<void> {
    await this.ensureRunning();
  }

  private async runtimeSnapshot(): Promise<AgentRuntimeSnapshot> {
    const response = await this.state().fetch("https://state.internal/runtime");
    if (!response.ok) {
      throw new Error(`State runtime read failed: ${response.status}`);
    }
    return response.json<AgentRuntimeSnapshot>();
  }

  private async loadStrategyMemory(): Promise<StrategyMemory> {
    if (this.strategyMemory) return this.strategyMemory;
    const [compressed, legacy] = await Promise.all([
      this.ctx.storage.get<ArrayBuffer>("strategyMemoryGzip"),
      this.ctx.storage.get<StrategyMemory>("strategyMemory"),
    ]);
    this.strategyMemory = compressed
      ? await decodeStrategyMemory(compressed)
      : (legacy ?? emptyMemory());
    return this.strategyMemory;
  }

  private async ensureRunning(): Promise<void> {
    const runtime = await this.runtimeSnapshot();
    if (runtime.desired !== "running" || runtime.authBlocked) {
      this.phase = runtime.authBlocked ? "blocked" : "idle";
      this.socket?.close(1000, runtime.authBlocked ? "blocked" : "stopped");
      this.socket = undefined;
      await this.ctx.storage.deleteAlarm();
      await this.updateConnectionStatus({}, runtime.authBlocked);
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
    await Promise.all([
      this.updateConnectionStatus({}),
      this.recordDiagnostic("connect_started"),
    ]);
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
    const [memory, runtime] = await Promise.all([
      this.loadStrategyMemory(),
      this.runtimeSnapshot(),
    ]);
    const config = runtime.config;
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
    const submission: StoredSubmission = {
      tick: plan.tick,
      key: `agent-${plan.tick}-primary`,
      body: serializePlan(plan),
    };
    await this.env.COMMAND_QUEUE.send(submission, {
      contentType: "json",
    });
    await this.recordDiagnostic("command_submit_queued", tick);

    const status = {
      tick,
      updatedAt: new Date().toISOString(),
      ...(summary ? { summary } : {}),
    };
    const statusResponse = await this.state().fetch(
      "https://state.internal/status-update",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(status),
      },
    );
    if (!statusResponse.ok) {
      throw new Error(`State status update failed: ${statusResponse.status}`);
    }
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

    const checkpointStartedAt = Date.now();
    this.strategyMemory = nextMemory;
    const compressedMemory = await encodeStrategyMemory(nextMemory);
    await this.ctx.storage.put({
      strategyMemoryGzip: compressedMemory,
      lastSubmission: submission,
    });
    await this.recordDiagnostic("memory_checkpoint_saved", tick, {
      bytes: compressedMemory.byteLength,
      durationMs: Date.now() - checkpointStartedAt,
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
    await Promise.all([
      this.ctx.storage.deleteAlarm(),
      this.updateConnectionStatus({}, true),
    ]);
    structuredLog("agent_blocked", { reason });
  }

  private async scheduleReconnect(): Promise<void> {
    const runtime = await this.runtimeSnapshot();
    if (runtime.desired !== "running" || this.phase === "blocked") return;
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
    await this.state().fetch("https://state.internal/diagnostic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
  }

  private async updateConnectionStatus(
    update: Partial<StoredConnectionStatus>,
    authBlocked?: boolean,
  ): Promise<void> {
    await this.state().fetch("https://state.internal/connection-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phase: this.phase,
        ...(authBlocked === undefined ? {} : { authBlocked }),
        connection: update,
      }),
    });
  }

  private state(): DurableObjectStub {
    return this.env.STATE.getByName("arena-hero-primary");
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

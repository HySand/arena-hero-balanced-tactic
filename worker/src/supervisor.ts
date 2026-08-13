import { DurableObject } from "cloudflare:workers";

import type { StoredSubmission } from "./arena-command";
import type {
  ReceivedData,
  StrategyMemory,
  StrategyRuntimeStatus,
} from "./contracts";
import { PRIMARY_STATE_INSTANCE } from "./instances";
import {
  compactStrategyMemory,
  decodeJsonGzip,
  decodeStrategyMemory,
  encodeJsonGzip,
  encodeStrategyMemory,
  strategyMemorySize,
} from "./memory-storage";
import { decodeGameMessage, serializePlan } from "./protocol";
import {
  applyStrategyStatusHistory,
  runStrategyBackend,
} from "./python-strategy/backend";
import { requestPythonStrategy } from "./python-strategy/client";
import {
  buildPythonStrategyRequest,
  emptyPythonMemory,
  isPythonStrategyMemory,
  type PythonStrategyMemory,
} from "./python-strategy/wire";
import type { AgentRuntimeSnapshot, ArenaHeroState } from "./state";
import { emptyMemory, planTick, safeFallbackPlan } from "./strategy/planner";
import { validatePlan } from "./strategy/validation";

const GAME_WS_URL = "https://api.arenahero.io/api/v1/game/ws";
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5000;
const WS_CONNECT_TIMEOUT_MS = 5000;
const CONNECTION_STALE_MS = 90_000;
const PYTHON_STRATEGY_TIMEOUT_MS = 2500;

export interface Env extends Cloudflare.Env {
  ASSETS: Fetcher;
  STATE: DurableObjectNamespace<ArenaHeroState>;
  PYTHON_STRATEGY: DurableObjectNamespace;
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
  private pythonStrategyMemory: PythonStrategyMemory | undefined;
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

  private async loadPythonStrategyMemory(): Promise<PythonStrategyMemory> {
    if (this.pythonStrategyMemory) return this.pythonStrategyMemory;
    const [compressed, legacy] = await Promise.all([
      this.ctx.storage.get<ArrayBuffer>("pythonStrategyMemoryGzip"),
      this.ctx.storage.get<unknown>("pythonStrategyMemory"),
    ]);
    const decoded = compressed
      ? await decodeJsonGzip<unknown>(compressed)
      : legacy;
    this.pythonStrategyMemory = isPythonStrategyMemory(decoded)
      ? decoded
      : emptyPythonMemory();
    return this.pythonStrategyMemory;
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
      this.recordDiagnostic("ws_stale", undefined, {
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
    this.recordDiagnostic("connect_started");
    await this.updateConnectionStatus({});
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
      this.recordDiagnostic("ws_connect_failed", undefined, { reason });
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
          this.recordDiagnostic("message_failed", undefined, { reason });
          this.ctx.waitUntil(
            this.updateConnectionStatus({
              lastError: `message_failed:${reason}`,
            }),
          );
        });
      this.ctx.waitUntil(this.messageChain);
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
    this.recordDiagnostic("ws_connected");
    structuredLog("ws_connected");
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    if (this.socket !== socket) return;
    this.recordDiagnostic("ws_text_received", undefined, {
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
        this.recordDiagnostic("tick_received", message.data);
        return;
      case "received":
        this.receipts[message.data.source] = message.data;
        this.recordDiagnostic("plan_received", message.data.tick, {
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
    this.recordDiagnostic("state_received", tick, {
      population: state.population,
      objects: state.objects.length,
      events: state.events.length,
    });
    const existing =
      await this.ctx.storage.get<StoredSubmission>("lastSubmission");
    if (existing?.tick === tick) {
      structuredLog("plan_replay", { tick });
      this.dispatchSubmission(existing);
      return;
    }
    if (existing && existing.tick > tick) {
      structuredLog("stale_state_discarded", {
        tick,
        lastSubmissionTick: existing.tick,
      });
      this.recordDiagnostic("stale_state_discarded", tick, {
        lastSubmissionTick: existing.tick,
      });
      return;
    }
    const runtime = await this.runtimeSnapshot();
    const needsTypeScript = runtime.backend !== "python_primary";
    const needsPython = runtime.backend !== "typescript_primary";
    const [storedTypeScriptMemory, pythonMemory, previousStatus] =
      await Promise.all([
        needsTypeScript
          ? this.loadStrategyMemory()
          : Promise.resolve(undefined),
        needsPython
          ? this.loadPythonStrategyMemory()
          : Promise.resolve(undefined),
        this.ctx.storage.get<StrategyRuntimeStatus>("strategyRuntimeStatus"),
      ]);
    let typeScriptMemory = storedTypeScriptMemory;
    let compactedSize =
      storedTypeScriptMemory === undefined
        ? undefined
        : strategyMemorySize(storedTypeScriptMemory);
    if (storedTypeScriptMemory !== undefined) {
      const originalSize = strategyMemorySize(storedTypeScriptMemory);
      typeScriptMemory = compactStrategyMemory(storedTypeScriptMemory, state);
      compactedSize = strategyMemorySize(typeScriptMemory);
      if (typeScriptMemory !== storedTypeScriptMemory) {
        structuredLog("strategy_memory_compacted", {
          tick,
          before: originalSize,
          after: compactedSize,
        });
      }
    }
    this.recordDiagnostic("planner_started", tick, {
      backend: runtime.backend,
      obstacles: compactedSize?.obstacles ?? 0,
      explored: compactedSize?.explored ?? 0,
      resources: compactedSize?.resources ?? 0,
      enemies: Object.keys(typeScriptMemory?.enemies ?? {}).length,
    });
    const outcome = await runStrategyBackend({
      backend: runtime.backend,
      tick,
      state,
      runTypeScript: () => {
        if (!typeScriptMemory) {
          throw new Error("TYPESCRIPT_MEMORY_UNAVAILABLE");
        }
        return planTick(tick, state, typeScriptMemory, runtime.config);
      },
      runPython: async () => {
        if (!pythonMemory) {
          throw new Error("PYTHON_MEMORY_UNAVAILABLE");
        }
        const request = buildPythonStrategyRequest(
          PRIMARY_STATE_INSTANCE,
          tick,
          state,
          pythonMemory,
        );
        return requestPythonStrategy(
          this.pythonStrategy(),
          request,
          PYTHON_STRATEGY_TIMEOUT_MS,
        );
      },
      validate: validatePlan,
      fallback: () => safeFallbackPlan(tick, state),
    });
    const strategyStatus = applyStrategyStatusHistory(
      outcome.status,
      previousStatus,
      tick,
      runtime.strategyFailureThreshold,
    );
    const plan = outcome.plan;
    const summary = outcome.summary;
    this.recordDiagnostic("planner_completed", tick, {
      backend: strategyStatus.backend,
      submittedBackend: strategyStatus.submittedBackend,
      actions: Object.keys(plan.unit_actions ?? {}).length,
      fallbackUsed: strategyStatus.fallbackUsed,
      consecutiveFailures: strategyStatus.consecutiveFailures,
      blocked: strategyStatus.blocked,
    });
    const submission: StoredSubmission = {
      tick: plan.tick,
      key: `agent-${plan.tick}-primary`,
      body: serializePlan(plan),
    };
    const checkpointStartedAt = Date.now();
    const [compressedTypeScriptMemory, compressedPythonMemory] =
      await Promise.all([
        outcome.typescriptMemory
          ? encodeStrategyMemory(outcome.typescriptMemory)
          : Promise.resolve(undefined),
        outcome.pythonMemory
          ? encodeJsonGzip(outcome.pythonMemory)
          : Promise.resolve(undefined),
      ]);
    await this.ctx.storage.put({
      lastSubmission: submission,
      strategyRuntimeStatus: strategyStatus,
      ...(compressedTypeScriptMemory === undefined
        ? {}
        : { strategyMemoryGzip: compressedTypeScriptMemory }),
      ...(compressedPythonMemory === undefined
        ? {}
        : { pythonStrategyMemoryGzip: compressedPythonMemory }),
    });
    if (outcome.typescriptMemory) {
      this.strategyMemory = outcome.typescriptMemory;
    }
    if (outcome.pythonMemory) {
      this.pythonStrategyMemory = outcome.pythonMemory;
    }
    this.recordDiagnostic("memory_checkpoint_saved", tick, {
      typescriptBytes: compressedTypeScriptMemory?.byteLength ?? 0,
      pythonBytes: compressedPythonMemory?.byteLength ?? 0,
      durationMs: Date.now() - checkpointStartedAt,
    });
    this.dispatchSubmission(submission);
    this.recordDiagnostic("command_submit_dispatched", tick);
    const status = {
      tick,
      updatedAt: new Date().toISOString(),
      ...(summary ? { summary } : {}),
      strategy: strategyStatus,
    };
    const statusResponse = await this.state().fetch(
      "https://state.internal/status-update",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(status),
      },
    );
    if (statusResponse.ok) {
      this.recordDiagnostic("status_saved", tick);
    } else {
      structuredLog("status_save_failed", {
        tick,
        status: statusResponse.status,
      });
    }
    structuredLog("plan_computed", {
      tick,
      backend: strategyStatus.backend,
      submittedBackend: strategyStatus.submittedBackend,
      strategyVersion: strategyStatus.strategyVersion,
      contractVersion: strategyStatus.contractVersion,
      latencyMs: strategyStatus.latencyMs,
      lastError: strategyStatus.lastError,
      consecutiveFailures: strategyStatus.consecutiveFailures,
      blocked: strategyStatus.blocked,
      posture: summary?.posture,
      threatened: summary?.threatened,
      retreating: summary?.retreating,
      planningMs: summary ? Math.round(summary.planningMs) : undefined,
      actions: summary?.actions ?? {},
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

  private recordDiagnostic(
    event: string,
    tick?: number,
    details?: Record<string, string | number | boolean | null>,
  ): void {
    structuredLog(event, {
      ...(tick === undefined ? {} : { tick }),
      ...(details === undefined ? {} : { details }),
    });
  }

  private dispatchSubmission(submission: StoredSubmission): void {
    const startedAt = Date.now();
    this.ctx.waitUntil(
      this.ctx.exports.ArenaCommandDispatcher.submit(submission)
        .then(() => {
          structuredLog("command_submit_dispatched", {
            tick: submission.tick,
            durationMs: Date.now() - startedAt,
          });
        })
        .catch((error: unknown) => {
          structuredLog("command_dispatch_failed", {
            reason: errorName(error),
            tick: submission.tick,
            durationMs: Date.now() - startedAt,
          });
        }),
    );
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

  private state(): DurableObjectStub<ArenaHeroState> {
    return this.env.STATE.getByName(PRIMARY_STATE_INSTANCE);
  }

  private pythonStrategy(): DurableObjectStub {
    return this.env.PYTHON_STRATEGY.getByName(PRIMARY_STATE_INSTANCE);
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

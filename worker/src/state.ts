import { DurableObject } from "cloudflare:workers";

import type {
  CommandPlan,
  PlayerState,
  StrategyRuntimeStatus,
  StrategyStatusSummary,
} from "./contracts";
import { isControlAction } from "./control";
import { projectDashboardStatus } from "./dashboard-status";
import {
  enqueueManualControl,
  parseStoredManualControl,
  type ControlReceipt,
  type StoredManualControl,
} from "./manual-control";
import {
  DEFAULT_PYTHON_STRATEGY_CONFIG,
  parsePythonStrategyConfig,
  type PythonStrategyConfig,
} from "./python-strategy/config";
import {
  isPythonStrategyMemory,
  type PythonStrategyMemory,
} from "./python-strategy/wire";

export type DesiredState = "running" | "stopped";
export type ConnectionPhase = "idle" | "connecting" | "open" | "blocked";
export const STRATEGY_FAILURE_THRESHOLD = 3;

interface StoredStatus {
  tick: number;
  updatedAt: string;
  state: PlayerState;
  plan: CommandPlan;
  memory: PythonStrategyMemory;
  summary?: StrategyStatusSummary;
  strategy: StrategyRuntimeStatus;
  controlReceipts?: ControlReceipt[];
}

interface StoredConnectionStatus {
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
  lastCloseCode?: number;
  lastError?: string | null;
  reconnectAttempt?: number;
  nextReconnectAt?: string | null;
}

export interface AgentRuntimeSnapshot {
  desired: DesiredState;
  authBlocked: boolean;
  config: PythonStrategyConfig;
}

export interface DiagnosticRecord {
  at: string;
  event: string;
  tick?: number;
  details?: Record<string, string | number | boolean | null>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export class ArenaHeroState extends DurableObject<Cloudflare.Env> {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/config" && request.method === "GET") {
      return jsonResponse(await this.getConfig());
    }
    if (path === "/config" && request.method === "PUT") {
      try {
        const config = parsePythonStrategyConfig(await request.json());
        await this.ctx.storage.put({
          strategyConfig: config,
          configUpdatedAt: new Date().toISOString(),
        });
        return jsonResponse({
          ok: true,
          message: "Configuration saved; it will apply on the next Tick",
          config,
        });
      } catch (error) {
        return jsonResponse(
          { error: error instanceof Error ? error.message : "INVALID_CONFIG" },
          422,
        );
      }
    }
    if (path === "/control" && request.method === "POST") {
      const value: unknown = await request.json();
      if (!isControlAction(value)) {
        return jsonResponse({ error: "INVALID_CONTROL" }, 400);
      }
      const desired: DesiredState =
        value.action === "start" ? "running" : "stopped";
      await this.ctx.storage.put({
        desired,
        ...(desired === "running" ? { authBlocked: false } : {}),
      });
      return jsonResponse({ desired });
    }
    if (path === "/manual-control" && request.method === "GET") {
      return jsonResponse(await this.controlQueueResponse());
    }
    if (path === "/manual-control" && request.method === "POST") {
      try {
        const command = enqueueManualControl(
          await request.json(),
          crypto.randomUUID(),
        );
        const pending = await this.getControlQueue();
        await this.ctx.storage.put(
          "manualControlQueue",
          [...pending, command].slice(-100),
        );
        return jsonResponse({
          ok: true,
          message: "Command queued for the next eligible Tick",
          command,
        });
      } catch (error) {
        return jsonResponse(
          { error: error instanceof Error ? error.message : "INVALID_CONTROL" },
          422,
        );
      }
    }
    if (path === "/manual-control" && request.method === "DELETE") {
      const pending = await this.getControlQueue();
      await this.ctx.storage.put("manualControlQueue", []);
      return jsonResponse({ ok: true, removed: pending.length });
    }
    if (path === "/control-queue" && request.method === "GET") {
      return jsonResponse({ pending: await this.getControlQueue() });
    }
    if (path === "/control-queue/ack" && request.method === "POST") {
      const value = await request.json<{ receipts?: unknown }>();
      if (
        !Array.isArray(value.receipts) ||
        !value.receipts.every(isControlReceipt)
      ) {
        return jsonResponse({ error: "INVALID_CONTROL_RECEIPTS" }, 400);
      }
      const receipts = value.receipts;
      const consumed = new Set(receipts.map((receipt) => receipt.command_id));
      const pending = (await this.getControlQueue()).filter(
        (command) => !consumed.has(command.command_id),
      );
      await this.ctx.storage.put({
        manualControlQueue: pending,
        ...(receipts.length === 0
          ? {}
          : { lastControlReceipt: receipts[receipts.length - 1] }),
      });
      return new Response(null, { status: 204 });
    }
    if (path === "/runtime" && request.method === "GET") {
      return jsonResponse(await this.runtimeSnapshot());
    }
    if (path === "/status" && request.method === "GET") {
      return this.statusResponse();
    }
    if (path === "/logs" && request.method === "GET") {
      const [current, recent] = await Promise.all([
        this.ctx.storage.get<DiagnosticRecord>("diagnosticCurrent"),
        this.ctx.storage.get<DiagnosticRecord[]>("diagnosticRecent"),
      ]);
      return jsonResponse({
        ...(current === undefined ? {} : { current }),
        recent: recent ?? [],
      });
    }
    if (path === "/status-update" && request.method === "POST") {
      const status = await request.json<StoredStatus>();
      if (!isStoredStatus(status)) {
        return jsonResponse({ error: "INVALID_STATUS" }, 400);
      }
      await this.ctx.storage.put("lastStatus", status);
      return new Response(null, { status: 204 });
    }
    if (path === "/connection-update" && request.method === "POST") {
      const value = await request.json<{
        phase?: ConnectionPhase;
        authBlocked?: boolean;
        connection?: Partial<StoredConnectionStatus>;
      }>();
      const current =
        (await this.ctx.storage.get<StoredConnectionStatus>(
          "connectionStatus",
        )) ?? {};
      await this.ctx.storage.put({
        ...(value.phase ? { phase: value.phase } : {}),
        ...(typeof value.authBlocked === "boolean"
          ? { authBlocked: value.authBlocked }
          : {}),
        ...(value.connection
          ? { connectionStatus: { ...current, ...value.connection } }
          : {}),
      });
      return new Response(null, { status: 204 });
    }
    if (path === "/diagnostic" && request.method === "POST") {
      const record = await request.json<DiagnosticRecord>();
      if (typeof record.at !== "string" || typeof record.event !== "string") {
        return jsonResponse({ error: "INVALID_DIAGNOSTIC" }, 400);
      }
      const recent =
        (await this.ctx.storage.get<DiagnosticRecord[]>("diagnosticRecent")) ??
        [];
      await this.ctx.storage.put({
        diagnosticCurrent: record,
        diagnosticRecent: [...recent, record].slice(-40),
      });
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }

  private async getConfig(): Promise<PythonStrategyConfig> {
    const stored = await this.ctx.storage.get<unknown>("strategyConfig");
    try {
      return stored === undefined
        ? structuredClone(DEFAULT_PYTHON_STRATEGY_CONFIG)
        : parsePythonStrategyConfig(stored);
    } catch {
      const config = structuredClone(DEFAULT_PYTHON_STRATEGY_CONFIG);
      await this.ctx.storage.put("strategyConfig", config);
      return config;
    }
  }

  private async getControlQueue(): Promise<StoredManualControl[]> {
    const stored = await this.ctx.storage.get<unknown>("manualControlQueue");
    return Array.isArray(stored)
      ? stored
          .map(parseStoredManualControl)
          .filter((value): value is StoredManualControl => value !== undefined)
          .slice(-100)
      : [];
  }

  private async controlQueueResponse(): Promise<Record<string, unknown>> {
    const [pending, lastReceipt] = await Promise.all([
      this.getControlQueue(),
      this.ctx.storage.get<ControlReceipt>("lastControlReceipt"),
    ]);
    return {
      pending,
      last_receipt: lastReceipt ?? null,
    };
  }

  private async runtimeSnapshot(): Promise<AgentRuntimeSnapshot> {
    const [desired, authBlocked, config] = await Promise.all([
      this.ctx.storage.get<DesiredState>("desired"),
      this.ctx.storage.get<boolean>("authBlocked"),
      this.getConfig(),
    ]);
    return {
      desired: desired ?? "running",
      authBlocked: authBlocked ?? false,
      config,
    };
  }

  private async statusResponse(): Promise<Response> {
    const [
      desired,
      authBlocked,
      phase,
      status,
      config,
      configUpdatedAt,
      connection,
    ] = await Promise.all([
      this.ctx.storage.get<DesiredState>("desired"),
      this.ctx.storage.get<boolean>("authBlocked"),
      this.ctx.storage.get<ConnectionPhase>("phase"),
      this.ctx.storage.get<StoredStatus>("lastStatus"),
      this.getConfig(),
      this.ctx.storage.get<string>("configUpdatedAt"),
      this.ctx.storage.get<StoredConnectionStatus>("connectionStatus"),
    ]);
    const resolvedDesired = desired ?? "running";
    const resolvedPhase = phase ?? "idle";
    const resolvedAuthBlocked = authBlocked ?? false;
    if (!status || !isStoredStatus(status)) {
      return jsonResponse({
        desired: resolvedDesired,
        phase: resolvedPhase,
        connected: resolvedPhase === "open",
        authBlocked: resolvedAuthBlocked,
        online: false,
        stale: true,
        message: "Waiting for the first Arena Hero Tick",
        backend: "python_primary",
        connection,
      });
    }
    return jsonResponse(
      projectDashboardStatus({
        desired: resolvedDesired,
        phase: resolvedPhase,
        authBlocked: resolvedAuthBlocked,
        tick: status.tick,
        updatedAt: status.updatedAt,
        state: status.state,
        plan: status.plan,
        memory: status.memory,
        config,
        strategy: status.strategy,
        ...(status.summary ? { summary: status.summary } : {}),
        ...(connection ? { connection } : {}),
        ...(configUpdatedAt ? { configUpdatedAt } : {}),
      }),
    );
  }
}

function isStoredStatus(value: unknown): value is StoredStatus {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.tick) &&
    typeof value.updatedAt === "string" &&
    isPlayerState(value.state) &&
    isCommandPlan(value.plan) &&
    isPythonStrategyMemory(value.memory) &&
    isStrategyRuntimeStatus(value.strategy)
  );
}

function isStrategyRuntimeStatus(
  value: unknown,
): value is StrategyRuntimeStatus {
  if (!isRecord(value)) return false;
  return (
    value.backend === "python_primary" &&
    (value.submittedBackend === "python" ||
      value.submittedBackend === "safe_fallback") &&
    typeof value.strategyVersion === "string" &&
    typeof value.contractVersion === "string" &&
    (value.lastError === null || typeof value.lastError === "string") &&
    typeof value.fallbackUsed === "boolean" &&
    Number.isInteger(value.consecutiveFailures) &&
    typeof value.blocked === "boolean"
  );
}

function isPlayerState(value: unknown): value is PlayerState {
  if (!isRecord(value)) return false;
  return (
    (value.status === "ACTIVE" || value.status === "RESPAWNING") &&
    Number.isSafeInteger(value.resources) &&
    Number.isSafeInteger(value.population) &&
    Array.isArray(value.objects) &&
    Array.isArray(value.events)
  );
}

function isCommandPlan(value: unknown): value is CommandPlan {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.tick) &&
    Number(value.tick) >= 1
  );
}

function isControlReceipt(value: unknown): value is ControlReceipt {
  if (!isRecord(value)) return false;
  return (
    typeof value.command_id === "string" &&
    typeof value.target_id === "string" &&
    (value.target_type === "UNIT" || value.target_type === "CORE") &&
    typeof value.action === "string" &&
    Number.isSafeInteger(value.observed_tick) &&
    Number.isSafeInteger(value.applied_tick) &&
    (value.status === "applied" ||
      value.status === "rejected" ||
      value.status === "expired" ||
      value.status === "superseded") &&
    typeof value.message === "string" &&
    typeof value.updated_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

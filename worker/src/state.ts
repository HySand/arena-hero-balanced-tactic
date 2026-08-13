import { DurableObject } from "cloudflare:workers";

import type {
  StrategyBackend,
  StrategyRuntimeStatus,
  StrategyStatusSummary,
} from "./contracts";
import {
  isControlAction,
  isStrategyBackend,
  isStrategyBackendUpdate,
} from "./control";
import {
  DEFAULT_CONFIG,
  parseStrategyConfig,
  type StrategyConfig,
} from "./strategy/config";

type DesiredState = "running" | "stopped";
type ConnectionPhase = "idle" | "connecting" | "open" | "blocked";
export const DEFAULT_STRATEGY_BACKEND: StrategyBackend = "typescript_primary";
export const DEFAULT_STRATEGY_FAILURE_THRESHOLD = 3;

interface StoredStatus {
  tick: number;
  updatedAt: string;
  summary?: StrategyStatusSummary;
  strategy: StrategyRuntimeStatus;
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
  config: StrategyConfig;
  backend: StrategyBackend;
  strategyFailureThreshold: number;
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
        const config = parseStrategyConfig(await request.json());
        await this.ctx.storage.put({
          strategyConfig: config,
          configUpdatedAt: new Date().toISOString(),
        });
        return jsonResponse({ ok: true, config });
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
    if (path === "/backend" && request.method === "GET") {
      return jsonResponse({ backend: await this.getStrategyBackend() });
    }
    if (path === "/backend" && request.method === "PUT") {
      const value: unknown = await request.json();
      if (!isStrategyBackendUpdate(value)) {
        return jsonResponse({ error: "INVALID_BACKEND" }, 400);
      }
      await this.ctx.storage.put({
        strategyBackend: value.backend,
        ...(value.failureThreshold === undefined
          ? {}
          : { strategyFailureThreshold: value.failureThreshold }),
        backendUpdatedAt: new Date().toISOString(),
      });
      return jsonResponse({
        backend: value.backend,
        failureThreshold:
          value.failureThreshold ?? (await this.getStrategyFailureThreshold()),
      });
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
      if (
        !Number.isInteger(status.tick) ||
        typeof status.updatedAt !== "string" ||
        !isStrategyRuntimeStatus(status.strategy)
      ) {
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

  private async getConfig(): Promise<StrategyConfig> {
    return (
      (await this.ctx.storage.get<StrategyConfig>("strategyConfig")) ??
      DEFAULT_CONFIG
    );
  }

  private async getStrategyBackend(): Promise<StrategyBackend> {
    const backend =
      await this.ctx.storage.get<StrategyBackend>("strategyBackend");
    return isStrategyBackend(backend) ? backend : DEFAULT_STRATEGY_BACKEND;
  }

  private async getStrategyFailureThreshold(): Promise<number> {
    const threshold = await this.ctx.storage.get<number>(
      "strategyFailureThreshold",
    );
    return typeof threshold === "number" &&
      Number.isInteger(threshold) &&
      threshold >= 1 &&
      threshold <= 20
      ? threshold
      : DEFAULT_STRATEGY_FAILURE_THRESHOLD;
  }

  private async runtimeSnapshot(): Promise<AgentRuntimeSnapshot> {
    const [desired, authBlocked, config, backend, strategyFailureThreshold] =
      await Promise.all([
        this.ctx.storage.get<DesiredState>("desired"),
        this.ctx.storage.get<boolean>("authBlocked"),
        this.getConfig(),
        this.getStrategyBackend(),
        this.getStrategyFailureThreshold(),
      ]);
    return {
      desired: desired ?? "running",
      authBlocked: authBlocked ?? false,
      config,
      backend,
      strategyFailureThreshold,
    };
  }

  private async statusResponse(): Promise<Response> {
    const [
      desired,
      authBlocked,
      phase,
      status,
      configUpdatedAt,
      backendUpdatedAt,
      connection,
      backend,
      strategyFailureThreshold,
    ] = await Promise.all([
      this.ctx.storage.get<DesiredState>("desired"),
      this.ctx.storage.get<boolean>("authBlocked"),
      this.ctx.storage.get<ConnectionPhase>("phase"),
      this.ctx.storage.get<StoredStatus>("lastStatus"),
      this.ctx.storage.get<string>("configUpdatedAt"),
      this.ctx.storage.get<string>("backendUpdatedAt"),
      this.ctx.storage.get<StoredConnectionStatus>("connectionStatus"),
      this.getStrategyBackend(),
      this.getStrategyFailureThreshold(),
    ]);
    const resolvedPhase = phase ?? "idle";
    return jsonResponse({
      desired: desired ?? "running",
      phase: resolvedPhase,
      connected: resolvedPhase === "open",
      authBlocked: authBlocked ?? false,
      tick: status?.tick,
      updatedAt: status?.updatedAt,
      configUpdatedAt,
      backendUpdatedAt,
      backend,
      strategyFailureThreshold,
      summary: status?.summary,
      strategy: status?.strategy,
      connection,
    });
  }
}

function isStrategyRuntimeStatus(
  value: unknown,
): value is StrategyRuntimeStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const data = value as Record<string, unknown>;
  return (
    isStrategyBackend(data.backend) &&
    (data.submittedBackend === "typescript" ||
      data.submittedBackend === "python" ||
      data.submittedBackend === "safe_fallback") &&
    typeof data.strategyVersion === "string" &&
    typeof data.contractVersion === "string" &&
    (data.lastError === null || typeof data.lastError === "string") &&
    typeof data.fallbackUsed === "boolean" &&
    Number.isInteger(data.consecutiveFailures) &&
    typeof data.blocked === "boolean"
  );
}

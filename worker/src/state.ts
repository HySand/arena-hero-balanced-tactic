import { DurableObject } from "cloudflare:workers";

import type { DecisionSummary } from "./contracts";
import { isControlAction } from "./control";
import {
  DEFAULT_CONFIG,
  parseStrategyConfig,
  type StrategyConfig,
} from "./strategy/config";

type DesiredState = "running" | "stopped";
type ConnectionPhase = "idle" | "connecting" | "open" | "blocked";

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

export interface AgentRuntimeSnapshot {
  desired: DesiredState;
  authBlocked: boolean;
  config: StrategyConfig;
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
        typeof status.updatedAt !== "string"
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
    const [desired, authBlocked, phase, status, configUpdatedAt, connection] =
      await Promise.all([
        this.ctx.storage.get<DesiredState>("desired"),
        this.ctx.storage.get<boolean>("authBlocked"),
        this.ctx.storage.get<ConnectionPhase>("phase"),
        this.ctx.storage.get<StoredStatus>("lastStatus"),
        this.ctx.storage.get<string>("configUpdatedAt"),
        this.ctx.storage.get<StoredConnectionStatus>("connectionStatus"),
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
      summary: status?.summary,
      connection,
    });
  }
}

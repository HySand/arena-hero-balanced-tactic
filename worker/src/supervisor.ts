import { DurableObject } from "cloudflare:workers";

import type { CommandPlan, ReceivedData, StrategyMemory } from "./contracts";
import { isControlAction } from "./control";
import { decodeGameMessage, serializePlan } from "./protocol";
import { emptyMemory, planTick, safeFallbackPlan } from "./strategy/planner";
import { validatePlan } from "./strategy/validation";

const GAME_WS_URL = "https://api.arenahero.io/api/v1/game/ws";
const COMMAND_URL = "https://api.arenahero.io/api/v1/game/commands";
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5000;

export interface Env extends Cloudflare.Env {
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
  private announcedTick?: number;
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
    let response: Response;
    try {
      response = await fetch(GAME_WS_URL, {
        headers: {
          Authorization: `Bearer ${this.env.ARENA_HERO_API_KEY}`,
          Upgrade: "websocket",
        },
      });
    } catch (error) {
      structuredLog("ws_connect_failed", { reason: errorName(error) });
      await this.scheduleReconnect();
      return;
    }

    if (response.status === 401 || response.status === 403) {
      await this.blockAuthentication(`handshake_${response.status}`);
      return;
    }
    if (response.status !== 101 || !response.webSocket) {
      structuredLog("ws_upgrade_failed", { status: response.status });
      await this.scheduleReconnect();
      return;
    }

    const socket = response.webSocket;
    this.socket = socket;
    this.phase = "open";
    this.reconnectAttempt = 0;
    socket.accept();
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        structuredLog("ws_binary_ignored");
        return;
      }
      this.messageChain = this.messageChain
        .then(() => this.handleMessage(event.data as string))
        .catch((error: unknown) =>
          structuredLog("message_failed", { reason: errorName(error) }),
        );
    });
    socket.addEventListener("close", (event) => {
      void this.handleClose(event.code);
    });
    socket.addEventListener("error", () => {
      structuredLog("ws_error");
    });
    structuredLog("ws_connected");
  }

  private async handleMessage(raw: string): Promise<void> {
    const message = decodeGameMessage(raw);
    if (!message) {
      structuredLog("ws_message_rejected");
      return;
    }
    switch (message.type) {
      case "tick":
        this.announcedTick = message.data;
        return;
      case "received":
        this.receipts[message.data.source] = message.data;
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
    const existing =
      await this.ctx.storage.get<StoredSubmission>("lastSubmission");
    if (existing?.tick === tick) {
      structuredLog("plan_replay", { tick });
      await this.submitSerialized(existing);
      return;
    }
    const memory =
      (await this.ctx.storage.get<StrategyMemory>("strategyMemory")) ??
      emptyMemory();
    let plan: CommandPlan;
    let nextMemory = memory;
    let summary: ReturnType<typeof planTick>["summary"] | undefined;
    try {
      const result = planTick(tick, state, memory);
      plan = validatePlan(result.plan, state)
        ? result.plan
        : safeFallbackPlan(tick, state);
      nextMemory = result.memory;
      summary = result.summary;
    } catch (error) {
      structuredLog("planner_failed", { tick, reason: errorName(error) });
      plan = safeFallbackPlan(tick, state);
    }
    await this.ctx.storage.put("strategyMemory", nextMemory);
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
    await this.submitSerialized(submission);
  }

  private async submitSerialized(submission: StoredSubmission): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(COMMAND_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.ARENA_HERO_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": submission.key,
          },
          body: submission.body,
        });
      } catch (error) {
        structuredLog("plan_transport_failed", {
          tick: submission.tick,
          attempt,
          reason: errorName(error),
        });
        if (attempt < 2) await delay(jitteredBackoff(attempt));
        continue;
      }

      const payload = await safeJson(response);
      const errorCode =
        typeof payload?.error === "string" ? payload.error : undefined;
      if (response.status === 202) {
        structuredLog("plan_accepted", { tick: submission.tick, attempt });
        return;
      }
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

  private async handleClose(code: number): Promise<void> {
    this.socket = undefined;
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
    await this.ctx.storage.setAlarm(Date.now() + waitMs);
    structuredLog("reconnect_scheduled", {
      attempt: this.reconnectAttempt,
      waitMs,
    });
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

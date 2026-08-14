import { describe, expect, it } from "vitest";

import { decodeGameMessage, serializePlan } from "../src/protocol";
import { IDS } from "./fixtures";

describe("protocol decoder", () => {
  it("decodes a tick message", () => {
    expect(decodeGameMessage('{"type":"tick","data":42}')).toEqual({
      type: "tick",
      data: 42,
    });
  });

  it("decodes a complete active state", () => {
    const decoded = decodeGameMessage(
      JSON.stringify({
        type: "state",
        data: {
          status: "ACTIVE",
          resources: 5,
          population: 1,
          champion_beacon: { position: [0, 0] },
          objects: [
            {
              kind: "CORE",
              id: IDS.core,
              owner_username: "player",
              controlled: true,
              position: [1, 2],
              hp: 5,
              shield: 4,
              state: "NORMAL",
            },
            {
              kind: "UNIT",
              id: IDS.worker1,
              controlled: true,
              position: [2, 2],
              hp: 2,
              unit_type: "WORKER",
              cargo: 0,
            },
            { kind: "RESOURCE", positions: [[2, 2]] },
          ],
          events: [],
        },
      }),
    );
    expect(decoded?.type).toBe("state");
    if (decoded?.type === "state") {
      expect(decoded.data.objects).toHaveLength(3);
      expect(decoded.data.champion_beacon.position).toEqual([0, 0]);
    }
  });

  it("accepts a controlled worker when optional cargo is null", () => {
    const decoded = decodeGameMessage(
      JSON.stringify({
        type: "state",
        data: {
          status: "ACTIVE",
          resources: 5,
          population: 1,
          champion_beacon: { position: [0, 0] },
          objects: [
            {
              kind: "UNIT",
              id: IDS.worker1,
              controlled: true,
              position: [2, 2],
              hp: 2,
              unit_type: "WORKER",
              cargo: null,
            },
          ],
          events: [],
        },
      }),
    );

    expect(decoded).toMatchObject({
      type: "state",
      data: { objects: [{ id: IDS.worker1, unit_type: "WORKER" }] },
    });
  });

  it("forwards a valid respawning state and its authoritative target Tick", () => {
    const decoded = decodeGameMessage(
      JSON.stringify({
        type: "state",
        data: {
          status: "RESPAWNING",
          respawn_at_tick: 44,
          resources: 0,
          population: 0,
          champion_beacon: { position: [0, 0] },
          objects: [],
          events: [],
        },
      }),
    );

    expect(decoded).toMatchObject({
      type: "state",
      data: { status: "RESPAWNING", respawn_at_tick: 44 },
    });
  });

  it("rejects inconsistent respawn lifecycle fields", () => {
    const base = {
      resources: 0,
      population: 0,
      champion_beacon: { position: [0, 0] },
      objects: [],
      events: [],
    };
    expect(
      decodeGameMessage(
        JSON.stringify({
          type: "state",
          data: { ...base, status: "RESPAWNING" },
        }),
      ),
    ).toBeUndefined();
    expect(
      decodeGameMessage(
        JSON.stringify({
          type: "state",
          data: { ...base, status: "ACTIVE", respawn_at_tick: 44 },
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects malformed or unsupported messages", () => {
    expect(decodeGameMessage("{")).toBeUndefined();
    expect(decodeGameMessage('{"type":"tick","data":0}')).toBeUndefined();
    expect(decodeGameMessage('{"type":"unknown","data":1}')).toBeUndefined();
  });

  it("serializes one stable complete plan body", () => {
    const body = serializePlan({
      tick: 9,
      unit_actions: { [IDS.worker1]: { type: "HARVEST" } },
    });
    expect(body).toBe(
      `{"tick":9,"unit_actions":{"${IDS.worker1}":{"type":"HARVEST"}}}`,
    );
  });
});

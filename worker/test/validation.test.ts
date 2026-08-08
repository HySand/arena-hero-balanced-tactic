import { describe, expect, it } from "vitest";

import { validatePlan } from "../src/strategy/validation";
import { core, IDS, state, unit } from "./fixtures";

describe("local command validation", () => {
  it("accepts legal owned actions", () => {
    const current = state([
      core(),
      unit(IDS.worker1, "WORKER", [1, 0]),
      unit(IDS.ranger, "RANGER", [0, 1]),
    ]);
    expect(
      validatePlan(
        {
          tick: 4,
          unit_actions: {
            [IDS.worker1]: { type: "HARVEST" },
            [IDS.ranger]: {
              type: "SHOOT",
              target_id: IDS.enemyWorker,
              expected_cell: [0, 3],
            },
          },
        },
        current,
      ),
    ).toBe(true);
  });

  it("rejects wrong-unit and unowned actions", () => {
    const current = state([core(), unit(IDS.worker1, "WORKER", [1, 0])]);
    expect(
      validatePlan(
        {
          tick: 4,
          unit_actions: { [IDS.worker1]: { type: "SWEEP", direction: "UP" } },
        },
        current,
      ),
    ).toBe(false);
    expect(
      validatePlan(
        { tick: 4, unit_actions: { [IDS.enemyWorker]: { type: "WAIT" } } },
        current,
      ),
    ).toBe(false);
  });
});

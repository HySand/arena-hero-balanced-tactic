import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, parseStrategyConfig } from "../src/strategy/config";

function validConfig(): typeof DEFAULT_CONFIG {
  return structuredClone(DEFAULT_CONFIG);
}

describe("strategy configuration", () => {
  it("accepts the complete default configuration", () => {
    expect(parseStrategyConfig(validConfig())).toEqual(DEFAULT_CONFIG);
  });

  it("rejects unknown top-level and nested fields", () => {
    expect(() =>
      parseStrategyConfig({ ...validConfig(), unexpected: true }),
    ).toThrow("unknown configuration field: unexpected");

    const unknownPosture = validConfig() as typeof DEFAULT_CONFIG & {
      postureTaskWeights: typeof DEFAULT_CONFIG.postureTaskWeights & {
        UNKNOWN: Record<string, number>;
      };
    };
    unknownPosture.postureTaskWeights.UNKNOWN = { economy: 1 };
    expect(() => parseStrategyConfig(unknownPosture)).toThrow(
      "unknown postureTaskWeights posture: UNKNOWN",
    );

    const unknownTask = validConfig() as typeof DEFAULT_CONFIG & {
      postureTaskWeights: typeof DEFAULT_CONFIG.postureTaskWeights & {
        RECOVER: typeof DEFAULT_CONFIG.postureTaskWeights.RECOVER & {
          typo: number;
        };
      };
    };
    unknownTask.postureTaskWeights.RECOVER.typo = 1;
    expect(() => parseStrategyConfig(unknownTask)).toThrow(
      "unknown postureTaskWeights.RECOVER task: typo",
    );
  });

  it("rejects missing, non-finite, and out-of-range numeric values", () => {
    const missing = validConfig() as Partial<typeof DEFAULT_CONFIG>;
    delete missing.computeBudgetMs;
    expect(() => parseStrategyConfig(missing)).toThrow(
      "computeBudgetMs must be a finite number",
    );

    expect(() =>
      parseStrategyConfig({ ...validConfig(), computeBudgetMs: Number.NaN }),
    ).toThrow("computeBudgetMs must be a finite number");
    expect(() =>
      parseStrategyConfig({ ...validConfig(), reserveFraction: 2 }),
    ).toThrow("reserveFraction must be between 0 and 1");
  });

  it("rejects invalid posture weights", () => {
    const config = validConfig();
    config.postureTaskWeights.ATTACK.attack = 6;
    expect(() => parseStrategyConfig(config)).toThrow(
      "postureTaskWeights.ATTACK.attack must be between 0 and 5",
    );
  });

  it("rejects inconsistent control radii", () => {
    expect(() =>
      parseStrategyConfig({
        ...validConfig(),
        minControlRadius: 8,
        safeControlRadius: 7,
      }),
    ).toThrow(
      "control radii must satisfy minControlRadius <= safeControlRadius <= maxControlRadius",
    );
  });
});

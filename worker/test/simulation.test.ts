import { describe, expect, it } from "vitest";

import {
  SCENARIOS,
  runComprehensiveSimulation,
  runEpisode,
  type ScenarioKind,
  type SimulationMetrics,
} from "./simulation";

function total(
  episodes: readonly SimulationMetrics[],
  scenarios: readonly ScenarioKind[],
  metric: keyof SimulationMetrics,
): number {
  return episodes
    .filter((episode) => scenarios.includes(episode.scenario))
    .reduce((sum, episode) => {
      const value = episode[metric];
      return sum + (typeof value === "number" ? value : 0);
    }, 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

describe("140-episode comprehensive strategy simulation", () => {
  const report = runComprehensiveSimulation();

  it("runs ten multi-Tick seeds for all fourteen strategy archetypes", () => {
    expect(report.episodes).toHaveLength(140);
    for (const scenario of SCENARIOS)
      expect(
        report.episodes.filter((episode) => episode.scenario === scenario),
      ).toHaveLength(10);
    expect(report.totals.ticks).toBeGreaterThanOrEqual(2500);
  });

  it("never emits an invalid plan or creates friendly over-capacity", () => {
    expect(report.totals.invalidPlans).toBe(0);
    expect(report.totals.friendlyOverCapacity).toBe(0);
  });

  it("closes the harvest and deposit loop in economic scenarios", () => {
    const economy: ScenarioKind[] = [
      "RESOURCE_RICH",
      "CHOKEPOINT_ECONOMY",
      "WORKER_HARASSMENT",
      "MIXED_CAMPAIGN",
    ];
    expect(
      total(report.episodes, economy, "resourcesHarvested"),
    ).toBeGreaterThan(200);
    expect(
      total(report.episodes, economy, "resourcesDeposited"),
    ).toBeGreaterThan(150);
    expect(report.totals.harvestFailures).toBe(0);
    expect(
      ratio(
        total(report.episodes, economy, "deliveredOrInTransit"),
        total(report.episodes, economy, "resourcesHarvested"),
      ),
    ).toBeGreaterThanOrEqual(0.98);
    expect(
      ratio(
        total(report.episodes, economy, "emptyWorkerWaitTicks"),
        total(report.episodes, economy, "workerActions"),
      ),
    ).toBeLessThanOrEqual(0.05);
    expect(
      ratio(
        total(report.episodes, economy, "resourceResponseTicks"),
        total(report.episodes, economy, "resourceResponseSamples"),
      ),
    ).toBeLessThanOrEqual(4);
    const rich = report.episodes.filter(
      (episode) => episode.scenario === "RESOURCE_RICH",
    );
    expect(rich.every((episode) => episode.unitsSpawned > 0)).toBe(true);
    expect(total(rich, ["RESOURCE_RICH"], "peakPopulation")).toBeGreaterThan(
      50,
    );
    const productiveEpisodes = report.episodes.filter(
      (episode) =>
        economy.includes(episode.scenario) && episode.resourcesHarvested > 0,
    );
    expect(
      productiveEpisodes.every(
        (episode) =>
          ratio(episode.deliveredOrInTransit, episode.resourcesHarvested) >=
            0.9 &&
          ratio(episode.emptyWorkerWaitTicks, episode.workerActions) <= 0.065,
      ),
    ).toBe(true);
    const sustainedRich = Array.from({ length: 3 }, (_, index) =>
      runEpisode("RESOURCE_RICH", index + 1, 64),
    );
    expect(sustainedRich.every((episode) => episode.peakPopulation >= 6)).toBe(
      true,
    );
    expect(sustainedRich.every((episode) => episode.endingResources >= 0)).toBe(
      true,
    );
  });

  it("expands frontier knowledge under scarcity and map-control pressure", () => {
    const scenarios: ScenarioKind[] = ["RESOURCE_SCARCE", "MAP_CONTROL"];
    expect(total(report.episodes, scenarios, "exploredCells")).toBeGreaterThan(
      2500,
    );
    expect(
      total(report.episodes, ["MAP_CONTROL"], "mapControlAssignments"),
    ).toBeGreaterThan(500);
    expect(
      total(report.episodes, ["MAP_CONTROL"], "distinctDefenderCells"),
    ).toBeGreaterThan(150);
    const scarcity = report.episodes.filter(
      (episode) => episode.scenario === "RESOURCE_SCARCE",
    );
    expect(
      scarcity.every(
        (episode) =>
          episode.resourceResponseSamples > 0 &&
          episode.resourcesHarvested > 0 &&
          episode.frontierGrowthTicks > 10,
      ),
    ).toBe(true);
    expect(total(scarcity, ["RESOURCE_SCARCE"], "longHaulWorkerTicks")).toBe(0);
    expect(
      ratio(
        total(scarcity, ["RESOURCE_SCARCE"], "workerSectorCollisionTicks"),
        total(scarcity, ["RESOURCE_SCARCE"], "workerPositionSamples"),
      ),
    ).toBeLessThanOrEqual(0.01);
    expect(
      total(scarcity, ["RESOURCE_SCARCE"], "balancedFrontierSectors"),
    ).toBeGreaterThanOrEqual(50);
    expect(
      total(scarcity, ["RESOURCE_SCARCE"], "frontierRadiusSpread"),
    ).toBeLessThanOrEqual(60);
    expect(
      ratio(
        total(report.episodes, scenarios, "balancedFrontierSectors"),
        report.episodes.filter((episode) =>
          scenarios.includes(episode.scenario),
        ).length * 8,
      ),
    ).toBeGreaterThanOrEqual(0.6);
    expect(
      ratio(
        total(report.episodes, scenarios, "frontierRadiusSpread"),
        report.episodes.filter((episode) =>
          scenarios.includes(episode.scenario),
        ).length,
      ),
    ).toBeLessThanOrEqual(6);
    expect(
      ratio(
        total(report.episodes, scenarios, "workerBalancedFrontierSectors"),
        report.episodes.filter((episode) =>
          scenarios.includes(episode.scenario),
        ).length * 8,
      ),
    ).toBeGreaterThanOrEqual(0.5);
    expect(
      ratio(
        total(report.episodes, scenarios, "workerFrontierRadiusSpread"),
        report.episodes.filter((episode) =>
          scenarios.includes(episode.scenario),
        ).length,
      ),
    ).toBeLessThanOrEqual(7);
    expect(
      report.episodes
        .filter((episode) => scenarios.includes(episode.scenario))
        .every(
          (episode) =>
            episode.workerBalancedFrontierSectors >= 2 &&
            episode.workerFrontierRadiusSpread <= 8,
        ),
    ).toBe(true);
  });

  it("keeps outer map control supported without consuming the field army", () => {
    const scenarios: ScenarioKind[] = [
      "CHOKEPOINT_ECONOMY",
      "MAP_CONTROL",
      "MIXED_CAMPAIGN",
    ];
    expect(
      ratio(
        total(report.episodes, scenarios, "supportedControlVisionSectorTicks"),
        total(report.episodes, scenarios, "mapControlOpportunityTicks"),
      ),
    ).toBeGreaterThanOrEqual(3);
    expect(
      ratio(
        total(
          report.episodes,
          scenarios,
          "supportedOuterControlAssignmentTicks",
        ),
        total(report.episodes, scenarios, "outerControlAssignmentTicks"),
      ),
    ).toBeGreaterThanOrEqual(0.8);
    expect(
      ratio(
        total(report.episodes, scenarios, "unsupportedOuterControlTicks"),
        total(report.episodes, scenarios, "outerControlAssignmentTicks"),
      ),
    ).toBeLessThanOrEqual(0.2);
    expect(
      ratio(
        total(report.episodes, scenarios, "mapControlEstablishmentTicks"),
        total(report.episodes, scenarios, "mapControlEstablishmentSamples"),
      ),
    ).toBeLessThanOrEqual(5);
    expect(
      total(report.episodes, scenarios, "distinctDefenderCells"),
    ).toBeGreaterThanOrEqual(300);
    expect(
      report.episodes
        .filter(
          (episode) =>
            scenarios.includes(episode.scenario) &&
            episode.outerControlAssignmentTicks > 0,
        )
        .every(
          (episode) =>
            ratio(
              episode.supportedOuterControlAssignmentTicks,
              episode.outerControlAssignmentTicks,
            ) >= 0.85 &&
            (episode.mapControlEstablishmentSamples === 0 ||
              ratio(
                episode.mapControlEstablishmentTicks,
                episode.mapControlEstablishmentSamples,
              ) <= 6),
        ),
    ).toBe(true);
  });

  it("reacts to assaults, attacks favorable targets, and withdraws when outmatched", () => {
    const survivableDefense: ScenarioKind[] = [
      "CORE_ASSAULT",
      "RANGED_PRESSURE",
      "MIXED_CAMPAIGN",
    ];
    expect(
      total(report.episodes, survivableDefense, "defensiveResponses"),
    ).toBeGreaterThan(20);
    expect(total(report.episodes, survivableDefense, "coreDeaths")).toBe(0);
    expect(
      report.episodes
        .filter((episode) => survivableDefense.includes(episode.scenario))
        .every(
          (episode) => episode.coreDeaths === 0 && episode.coreDamageTaken <= 7,
        ),
    ).toBe(true);
    expect(
      ratio(
        total(report.episodes, survivableDefense, "defenseResponseTicks"),
        total(report.episodes, survivableDefense, "defenseResponseSamples"),
      ),
    ).toBeLessThanOrEqual(0.2);
    expect(
      total(report.episodes, survivableDefense, "coreDamageTaken"),
    ).toBeLessThanOrEqual(75);
    const favorable = report.episodes.filter(
      (episode) => episode.scenario === "FAVORABLE_ATTACK",
    );
    expect(
      favorable.every(
        (episode) =>
          episode.advanceAssignments > 0 &&
          episode.enemyCoreDamage >= 3 &&
          episode.enemyCoreKills === 1,
      ),
    ).toBe(true);
    const offense: ScenarioKind[] = ["FAVORABLE_ATTACK", "MIXED_CAMPAIGN"];
    expect(
      ratio(
        total(report.episodes, offense, "shootHits"),
        total(report.episodes, offense, "shootAttempts"),
      ),
    ).toBeGreaterThanOrEqual(0.5);
    expect(
      ratio(
        total(report.episodes, offense, "sweepHits"),
        total(report.episodes, offense, "sweepAttempts"),
      ),
    ).toBeGreaterThanOrEqual(0.8);
    expect(
      total(report.episodes, ["MIXED_CAMPAIGN"], "enemyCoreKills"),
    ).toBeGreaterThanOrEqual(7);
    expect(
      report.episodes
        .filter((episode) => episode.scenario === "MIXED_CAMPAIGN")
        .every((episode) => episode.enemyCoreKills === 1),
    ).toBe(true);
    const overwhelming = report.episodes.filter(
      (episode) => episode.scenario === "OVERWHELMING_FORCE",
    );
    expect(overwhelming).toHaveLength(10);
    expect(
      overwhelming.every(
        (episode) => episode.withdrawals > 0 && episode.defensiveResponses > 0,
      ),
    ).toBe(true);
  });

  it("keeps multi-wave resilience above the pre-change baseline", () => {
    const multiWave: ScenarioKind[] = [
      "RECURRING_RAIDS",
      "STAGGERED_RANGED_WAVES",
      "PURSUIT_THROUGH_RETREAT",
      "POST_LOSS_REATTACK",
    ];
    expect(
      report.episodes.filter((episode) => multiWave.includes(episode.scenario)),
    ).toHaveLength(40);
    expect(
      total(report.episodes, ["PURSUIT_THROUGH_RETREAT"], "coreDeaths"),
    ).toBe(0);
    // Baseline before readiness work: 13 Core deaths across these four scenarios.
    expect(total(report.episodes, multiWave, "coreDeaths")).toBeLessThan(13);
    expect(
      total(report.episodes, multiWave, "vanguardSpawns") +
        total(report.episodes, multiWave, "rangerSpawns"),
    ).toBeGreaterThan(40);
  });
});

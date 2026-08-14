import {
  SCENARIOS,
  runComprehensiveSimulation,
  type ScenarioKind,
  type SimulationMetrics,
} from "./simulation";

const report = runComprehensiveSimulation();
const metrics = [
  "ticks",
  "invalidPlans",
  "coreDeaths",
  "resourcesHarvested",
  "resourcesDeposited",
  "deliveredOrInTransit",
  "harvestAttempts",
  "harvestFailures",
  "depositAttempts",
  "visibleResourceCellTicks",
  "uncollectedVisibleResourceCellTicks",
  "resourceResponseTicks",
  "resourceResponseSamples",
  "productiveWorkerActions",
  "workerActions",
  "workerWaitActions",
  "emptyWorkerWaitTicks",
  "workerMoveActions",
  "workerMovesResolved",
  "workerDistanceTicks",
  "workerPositionSamples",
  "cargoDistanceTicks",
  "cargoWorkerSamples",
  "harvestDistance",
  "longHaulWorkerTicks",
  "workerSectorCollisionTicks",
  "distinctWorkerCells",
  "maxWorkerDistance",
  "exploredCells",
  "frontierGrowthTicks",
  "balancedFrontierSectors",
  "frontierRadiusSpread",
  "workerBalancedFrontierSectors",
  "workerFrontierRadiusSpread",
  "maxExploredDistance",
  "attacks",
  "attackHits",
  "shootAttempts",
  "shootHits",
  "workerShootAttempts",
  "workerShootHits",
  "vanguardShootAttempts",
  "vanguardShootHits",
  "rangerShootAttempts",
  "rangerShootHits",
  "coreShootAttempts",
  "coreShootHits",
  "sweepAttempts",
  "sweepHits",
  "enemyUnitsDestroyed",
  "enemyCoreDamage",
  "enemyCoreKills",
  "offenseCompletionTicks",
  "offenseCompletionSamples",
  "advanceAssignments",
  "engageAssignments",
  "defensiveResponses",
  "withdrawals",
  "mapControlAssignments",
  "outerControlUnitTicks",
  "combatCellTicks",
  "distinctDefenderCells",
  "maxCombatDistance",
  "friendlyUnitsLost",
  "friendlyCombatUnitsLost",
  "threatObservationTicks",
  "defenseResponseTicks",
  "defenseResponseSamples",
  "innerBreachTicks",
  "minimumCoreEffectiveHealth",
  "controlSectorTicks",
  "controlVisionSectorTicks",
  "supportedControlVisionSectorTicks",
  "outerControlAssignmentTicks",
  "supportedOuterControlAssignmentTicks",
  "mapControlOpportunityTicks",
  "mapControlEstablishmentTicks",
  "mapControlEstablishmentSamples",
  "unsupportedOuterControlTicks",
  "coreDamageTaken",
  "coreMovesCompleted",
  "centerDistanceReduced",
  "unitsSpawned",
  "workerSpawns",
  "vanguardSpawns",
  "rangerSpawns",
  "combatUnitTicks",
  "combatPowerTicks",
  "militaryReadinessTicks",
  "militaryDeficitTicks",
  "combatReplacementTicks",
  "combatReplacementSamples",
  "waveStarts",
  "peakPopulation",
  "endingResources",
  "friendlyOverCapacity",
  "endingCargo",
] as const;

const scenarios = Object.fromEntries(
  SCENARIOS.map((scenario) => {
    const episodes = report.episodes.filter(
      (episode) => episode.scenario === scenario,
    );
    return [
      scenario,
      Object.fromEntries(
        metrics.map((metric) => [
          metric,
          episodes.reduce((sum, episode) => sum + episode[metric], 0),
        ]),
      ),
    ];
  }),
);

function total(
  scenarioKinds: readonly ScenarioKind[],
  metric: keyof SimulationMetrics,
): number {
  return report.episodes
    .filter((episode) => scenarioKinds.includes(episode.scenario))
    .reduce((sum, episode) => {
      const value = episode[metric];
      return sum + (typeof value === "number" ? value : 0);
    }, 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(3));
}

const economyScenarios: ScenarioKind[] = [
  "RESOURCE_RICH",
  "RESOURCE_SCARCE",
  "CHOKEPOINT_ECONOMY",
  "WORKER_HARASSMENT",
  "MAP_CONTROL",
  "MIXED_CAMPAIGN",
];
const explorationScenarios: ScenarioKind[] = ["RESOURCE_SCARCE", "MAP_CONTROL"];
const defenseScenarios: ScenarioKind[] = [
  "CORE_ASSAULT",
  "RANGED_PRESSURE",
  "MIXED_CAMPAIGN",
];
const mapControlScenarios: ScenarioKind[] = [
  "CHOKEPOINT_ECONOMY",
  "MAP_CONTROL",
  "MIXED_CAMPAIGN",
];
const offenseScenarios: ScenarioKind[] = ["FAVORABLE_ATTACK", "MIXED_CAMPAIGN"];
const multiWaveScenarios: ScenarioKind[] = [
  "RECURRING_RAIDS",
  "STAGGERED_RANGED_WAVES",
  "PURSUIT_THROUGH_RETREAT",
  "POST_LOSS_REATTACK",
];

const categoryDiagnostics = {
  economy: {
    harvests: total(economyScenarios, "resourcesHarvested"),
    deposits: total(economyScenarios, "resourcesDeposited"),
    deliveryRate: ratio(
      total(economyScenarios, "resourcesDeposited"),
      total(economyScenarios, "resourcesHarvested"),
    ),
    securedYieldRate: ratio(
      total(economyScenarios, "deliveredOrInTransit"),
      total(economyScenarios, "resourcesHarvested"),
    ),
    visibleHarvestRate: ratio(
      total(economyScenarios, "harvestAttempts"),
      total(economyScenarios, "visibleResourceCellTicks"),
    ),
    emptyWorkerWaitRate: ratio(
      total(economyScenarios, "emptyWorkerWaitTicks"),
      total(economyScenarios, "workerActions"),
    ),
    averageResourceResponseTicks: ratio(
      total(economyScenarios, "resourceResponseTicks"),
      total(economyScenarios, "resourceResponseSamples"),
    ),
    averageHarvestDistance: ratio(
      total(economyScenarios, "harvestDistance"),
      total(economyScenarios, "resourcesHarvested"),
    ),
    averageCargoDistance: ratio(
      total(economyScenarios, "cargoDistanceTicks"),
      total(economyScenarios, "cargoWorkerSamples"),
    ),
    unitsSpawned: total(economyScenarios, "unitsSpawned"),
  },
  exploration: {
    exploredCells: total(explorationScenarios, "exploredCells"),
    balancedFrontierSectorRate: ratio(
      total(explorationScenarios, "balancedFrontierSectors"),
      report.episodes.filter((episode) =>
        explorationScenarios.includes(episode.scenario),
      ).length * 8,
    ),
    averageFrontierRadiusSpread: ratio(
      total(explorationScenarios, "frontierRadiusSpread"),
      report.episodes.filter((episode) =>
        explorationScenarios.includes(episode.scenario),
      ).length,
    ),
    workerBalancedFrontierSectorRate: ratio(
      total(explorationScenarios, "workerBalancedFrontierSectors"),
      report.episodes.filter((episode) =>
        explorationScenarios.includes(episode.scenario),
      ).length * 8,
    ),
    averageWorkerFrontierRadiusSpread: ratio(
      total(explorationScenarios, "workerFrontierRadiusSpread"),
      report.episodes.filter((episode) =>
        explorationScenarios.includes(episode.scenario),
      ).length,
    ),
    averageWorkerDistance: ratio(
      total(explorationScenarios, "workerDistanceTicks"),
      total(explorationScenarios, "workerPositionSamples"),
    ),
    longHaulWorkerRate: ratio(
      total(explorationScenarios, "longHaulWorkerTicks"),
      total(explorationScenarios, "workerPositionSamples"),
    ),
    sectorCollisionRate: ratio(
      total(explorationScenarios, "workerSectorCollisionTicks"),
      total(explorationScenarios, "workerPositionSamples"),
    ),
  },
  defense: {
    averageResponseTicks: ratio(
      total(defenseScenarios, "defenseResponseTicks"),
      total(defenseScenarios, "defenseResponseSamples"),
    ),
    innerBreachTicks: total(defenseScenarios, "innerBreachTicks"),
    coreDamageTaken: total(defenseScenarios, "coreDamageTaken"),
    friendlyCombatUnitsLost: total(defenseScenarios, "friendlyCombatUnitsLost"),
    coreDeaths: total(defenseScenarios, "coreDeaths"),
  },
  mapControl: {
    averageControlledSectors: ratio(
      total(mapControlScenarios, "controlSectorTicks"),
      total(mapControlScenarios, "ticks"),
    ),
    averageVisionControlledSectors: ratio(
      total(mapControlScenarios, "controlVisionSectorTicks"),
      total(mapControlScenarios, "mapControlOpportunityTicks"),
    ),
    averageSupportedVisionSectors: ratio(
      total(mapControlScenarios, "supportedControlVisionSectorTicks"),
      total(mapControlScenarios, "mapControlOpportunityTicks"),
    ),
    supportedOuterControlRate: ratio(
      total(mapControlScenarios, "supportedOuterControlAssignmentTicks"),
      total(mapControlScenarios, "outerControlAssignmentTicks"),
    ),
    averageEstablishmentTicks: ratio(
      total(mapControlScenarios, "mapControlEstablishmentTicks"),
      total(mapControlScenarios, "mapControlEstablishmentSamples"),
    ),
    outerControlRate: ratio(
      total(mapControlScenarios, "outerControlUnitTicks"),
      total(mapControlScenarios, "combatCellTicks"),
    ),
    unsupportedOuterControlRate: ratio(
      total(mapControlScenarios, "unsupportedOuterControlTicks"),
      total(mapControlScenarios, "outerControlAssignmentTicks"),
    ),
    distinctDefenderCells: total(mapControlScenarios, "distinctDefenderCells"),
  },
  offense: {
    rangedHitRate: ratio(
      total(offenseScenarios, "shootHits"),
      total(offenseScenarios, "shootAttempts"),
    ),
    rangedHitRateByTarget: {
      worker: ratio(
        total(offenseScenarios, "workerShootHits"),
        total(offenseScenarios, "workerShootAttempts"),
      ),
      vanguard: ratio(
        total(offenseScenarios, "vanguardShootHits"),
        total(offenseScenarios, "vanguardShootAttempts"),
      ),
      ranger: ratio(
        total(offenseScenarios, "rangerShootHits"),
        total(offenseScenarios, "rangerShootAttempts"),
      ),
      core: ratio(
        total(offenseScenarios, "coreShootHits"),
        total(offenseScenarios, "coreShootAttempts"),
      ),
    },
    meleeHitRate: ratio(
      total(offenseScenarios, "sweepHits"),
      total(offenseScenarios, "sweepAttempts"),
    ),
    coreKillRate: ratio(
      total(offenseScenarios, "enemyCoreKills"),
      report.episodes.filter((episode) =>
        offenseScenarios.includes(episode.scenario),
      ).length,
    ),
    averageCompletionTicks: ratio(
      total(offenseScenarios, "offenseCompletionTicks"),
      total(offenseScenarios, "offenseCompletionSamples"),
    ),
    friendlyCombatUnitsLost: total(offenseScenarios, "friendlyCombatUnitsLost"),
  },
  military: {
    coreDeaths: total(multiWaveScenarios, "coreDeaths"),
    coreDamageTaken: total(multiWaveScenarios, "coreDamageTaken"),
    friendlyCombatUnitsLost: total(
      multiWaveScenarios,
      "friendlyCombatUnitsLost",
    ),
    workerSpawns: total(multiWaveScenarios, "workerSpawns"),
    vanguardSpawns: total(multiWaveScenarios, "vanguardSpawns"),
    rangerSpawns: total(multiWaveScenarios, "rangerSpawns"),
    readinessRate: ratio(
      total(multiWaveScenarios, "militaryReadinessTicks"),
      total(multiWaveScenarios, "ticks"),
    ),
    averageCombatCount: ratio(
      total(multiWaveScenarios, "combatUnitTicks"),
      total(multiWaveScenarios, "ticks"),
    ),
    averageCombatPower: ratio(
      total(multiWaveScenarios, "combatPowerTicks"),
      total(multiWaveScenarios, "ticks"),
    ),
    averageReplacementTicks: ratio(
      total(multiWaveScenarios, "combatReplacementTicks"),
      total(multiWaveScenarios, "combatReplacementSamples"),
    ),
    waves: total(multiWaveScenarios, "waveStarts"),
  },
};

const failedEpisodes = report.episodes
  .filter(
    (episode) =>
      episode.invalidPlans > 0 ||
      episode.coreDeaths > 0 ||
      episode.friendlyOverCapacity > 0,
  )
  .map((episode) => ({
    scenario: episode.scenario,
    seed: episode.seed,
    ticks: episode.ticks,
    invalidPlans: episode.invalidPlans,
    coreDeaths: episode.coreDeaths,
    friendlyOverCapacity: episode.friendlyOverCapacity,
  }));

console.log(
  JSON.stringify(
    { totals: report.totals, categoryDiagnostics, scenarios, failedEpisodes },
    null,
    2,
  ),
);

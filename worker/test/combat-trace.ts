import { runEpisode, type ScenarioKind } from "./simulation";

const process = (
  globalThis as typeof globalThis & {
    process: { argv: string[]; exit(code?: number): never };
  }
).process;
const argv = process.argv;
const scenario = (argv[2] ?? "RECURRING_RAIDS") as ScenarioKind;
const seed = Number(argv[3] ?? 1);

if (argv[2] === "ALL") {
  for (const candidate of [
    "RECURRING_RAIDS",
    "STAGGERED_RANGED_WAVES",
    "PURSUIT_THROUGH_RETREAT",
    "POST_LOSS_REATTACK",
  ] as const) {
    const episodes = Array.from({ length: 10 }, (_, index) =>
      runEpisode(candidate, index + 1, 64),
    );
    console.log(
      JSON.stringify({
        scenario: candidate,
        deaths: episodes.reduce((sum, item) => sum + item.coreDeaths, 0),
        damage: episodes.reduce((sum, item) => sum + item.coreDamageTaken, 0),
        losses: episodes.reduce(
          (sum, item) => sum + item.friendlyCombatUnitsLost,
          0,
        ),
        workers: episodes.reduce((sum, item) => sum + item.workerSpawns, 0),
        vanguards: episodes.reduce((sum, item) => sum + item.vanguardSpawns, 0),
        rangers: episodes.reduce((sum, item) => sum + item.rangerSpawns, 0),
        failedSeeds: episodes
          .filter((item) => item.coreDeaths > 0)
          .map((item) => item.seed),
      }),
    );
  }
  process.exit(0);
}

const metrics = runEpisode(scenario, seed, 64, (entry) => {
  const counts = { WORKER: 0, VANGUARD: 0, RANGER: 0 };
  for (const unit of entry.friendlyUnits) counts[unit.unit_type] += 1;
  const roles = Object.values(entry.roles).reduce<Record<string, number>>(
    (result, role) => {
      result[role.kind] = (result[role.kind] ?? 0) + 1;
      return result;
    },
    {},
  );
  if (
    entry.enemies.length > 0 ||
    entry.plan.core_action?.type === "SPAWN" ||
    entry.posture === "REGROUP"
  ) {
    console.log(
      JSON.stringify({
        tick: entry.tick,
        core: entry.coreHp + entry.coreShield,
        coreAt: entry.corePosition,
        resources: entry.storedResources,
        counts,
        units: entry.friendlyUnits.map((unit) => ({
          id: unit.id.slice(-4),
          type: unit.unit_type,
          at: unit.position,
          hp: unit.hp,
          action: entry.plan.unit_actions?.[unit.id],
          role: entry.roles[unit.id]?.kind,
        })),
        enemies: entry.enemies.map((enemy) => ({
          id: enemy.id.slice(-4),
          type: enemy.unit_type,
          at: enemy.position,
          hp: enemy.hp,
        })),
        posture: entry.posture,
        retreating: entry.retreating,
        roles,
        coreAction: entry.plan.core_action,
      }),
    );
  }
});

console.log(JSON.stringify({ scenario, seed, metrics }));

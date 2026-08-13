import type { CommandPlan, PlayerState, UnitObject } from "./contracts";

export function safeFallbackPlan(
  tick: number,
  state: PlayerState,
): CommandPlan {
  const core = state.objects.find(
    (object) => object.kind === "CORE" && object.controlled,
  );
  if (!core || core.kind !== "CORE") return { tick };
  const unitActions = Object.fromEntries(
    state.objects
      .filter(
        (object): object is UnitObject =>
          object.kind === "UNIT" &&
          object.controlled &&
          object.unit_type === "WORKER" &&
          (object.cargo ?? 0) > 0 &&
          object.position[0] === core.position[0] &&
          object.position[1] === core.position[1],
      )
      .map((object) => [object.id, { type: "DEPOSIT" as const }]),
  );
  return Object.keys(unitActions).length === 0
    ? { tick }
    : { tick, unit_actions: unitActions };
}

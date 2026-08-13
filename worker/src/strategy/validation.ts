import type {
  CommandPlan,
  CoreObject,
  PlayerState,
  UnitAction,
  UnitObject,
} from "../contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validUnitAction(unit: UnitObject, action: UnitAction): boolean {
  switch (action.type) {
    case "WAIT":
    case "MOVE":
    case "HEAL":
    case "PICKUP_BEACON":
    case "DROP_BEACON":
    case "SELF_DESTRUCT":
      return true;
    case "HARVEST":
    case "DEPOSIT":
      return unit.unit_type === "WORKER";
    case "SWEEP":
      return unit.unit_type === "VANGUARD";
    case "SHOOT":
      return (
        unit.unit_type === "RANGER" &&
        (action.target_id === undefined || UUID.test(action.target_id))
      );
  }
}

export function validatePlan(plan: CommandPlan, state: PlayerState): boolean {
  if (!Number.isSafeInteger(plan.tick) || plan.tick < 1) return false;
  const units = new Map<string, UnitObject>();
  let core: CoreObject | undefined;
  for (const object of state.objects) {
    if (object.kind === "UNIT" && object.controlled)
      units.set(object.id, object);
    if (object.kind === "CORE" && object.controlled) core = object;
  }
  for (const [id, action] of Object.entries(plan.unit_actions ?? {})) {
    const unit = units.get(id);
    if (!UUID.test(id) || !unit || !validUnitAction(unit, action)) return false;
  }
  if (plan.core_action && !core) return false;
  if (
    core?.state === "MOVING" &&
    plan.core_action &&
    plan.core_action.type !== "WAIT" &&
    plan.core_action.type !== "CANCEL_MOVE"
  ) {
    return false;
  }
  return true;
}

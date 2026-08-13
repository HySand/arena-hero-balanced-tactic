import type { StrategyBackend } from "./contracts";

export function authorized(header: string | null, secret: string): boolean {
  if (!secret) return false;
  const expected = `Bearer ${secret}`;
  if (!header || header.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= header.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

export function isStrategyBackend(value: unknown): value is StrategyBackend {
  return (
    value === "typescript_primary" ||
    value === "python_shadow" ||
    value === "python_primary"
  );
}

export function isStrategyBackendUpdate(
  value: unknown,
): value is { backend: StrategyBackend; failureThreshold?: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const data = value as Record<string, unknown>;
  const keys = Object.keys(data);
  return (
    keys.length >= 1 &&
    keys.length <= 2 &&
    keys.every((key) => key === "backend" || key === "failureThreshold") &&
    isStrategyBackend(data.backend) &&
    (data.failureThreshold === undefined ||
      (Number.isInteger(data.failureThreshold) &&
        Number(data.failureThreshold) >= 1 &&
        Number(data.failureThreshold) <= 20))
  );
}

export function isControlAction(
  value: unknown,
): value is { action: "start" | "stop" } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const data = value as Record<string, unknown>;
  return (
    Object.keys(data).length === 1 &&
    (data.action === "start" || data.action === "stop")
  );
}

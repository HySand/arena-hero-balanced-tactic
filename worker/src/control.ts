export function authorized(header: string | null, secret: string): boolean {
  const expected = `Bearer ${secret}`;
  if (!header || header.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= header.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
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

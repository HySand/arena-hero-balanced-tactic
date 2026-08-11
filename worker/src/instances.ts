export const PRIMARY_STATE_INSTANCE = "arena-hero-primary";
export const DIAGNOSTIC_STATE_INSTANCE = "arena-hero-diagnostics";

export function commandStateInstance(key: string): string {
  return `command-${key}`;
}

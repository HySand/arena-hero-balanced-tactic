import { describe, expect, it } from "vitest";

import { authorized } from "../src/control";

describe("control authentication", () => {
  it("accepts only the exact administrator bearer value", () => {
    expect(authorized("Bearer secret-value", "secret-value")).toBe(true);
    expect(authorized("Bearer secret-valuE", "secret-value")).toBe(false);
    expect(authorized("Bearer short", "secret-value")).toBe(false);
    expect(authorized(null, "secret-value")).toBe(false);
  });
});

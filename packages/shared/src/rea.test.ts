import { describe, expect, it } from "vitest";
import { isReaError } from "./rea.js";

describe("isReaError", () => {
  it("accepts the error shape REA 6.7.0 returns", () => {
    expect(
      isReaError({
        code: "target_unavailable",
        category: "unavailable",
        message: "Cannot open artifact",
        retryable: false,
        remediation: { action: "Check that the path exists" },
        details: { path: "/nonexistent" },
      }),
    ).toBe(true);
    expect(isReaError({ code: "x", message: "y" })).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isReaError(null)).toBe(false);
    expect(isReaError("boom")).toBe(false);
    expect(isReaError({ code: 1, message: "y" })).toBe(false);
    expect(isReaError({ code: "x", message: "y", remediation: "a string" })).toBe(false);
    expect(isReaError({ code: "x", message: "y", retryable: "no" })).toBe(false);
  });
});

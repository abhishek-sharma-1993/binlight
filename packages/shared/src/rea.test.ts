import { describe, expect, it } from "vitest";
import { isReaError } from "./rea.js";

describe("isReaError", () => {
  it("accepts REA's structured error shape", () => {
    expect(isReaError({ code: "x", message: "y", remediation: "z" })).toBe(true);
    expect(isReaError({ code: "x", message: "y" })).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isReaError(null)).toBe(false);
    expect(isReaError("boom")).toBe(false);
    expect(isReaError({ code: 1, message: "y" })).toBe(false);
    expect(isReaError({ code: "x", message: "y", remediation: 3 })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { describeHealth } from "./health.js";

describe("describeHealth", () => {
  it("includes the real reason when the server is down", () => {
    expect(describeHealth({ state: "down", reason: "HTTP 502" })).toBe(
      "Server unreachable: HTTP 502",
    );
  });
});

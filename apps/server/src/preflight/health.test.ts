import { describe, expect, it } from "vitest";
import { gatherHealth } from "./health.js";

// Live: runs the pinned `rea doctor` and asks Docker. Machine-specific values are
// not asserted; this catches a REA upgrade that changes doctor's JSON.
describe("gatherHealth (live)", () => {
  it("reads rea doctor's provider report", async () => {
    const health = await gatherHealth({});
    expect(health.ghidra, JSON.stringify(health.ghidra)).not.toHaveProperty("error");
    expect(health.hopper).toHaveProperty("installed");
    expect(health.docker).toHaveProperty("daemon");
  }, 60_000);
});

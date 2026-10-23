import { describe, expect, it } from "vitest";
import { formatReaLog } from "./log.js";

describe("formatReaLog", () => {
  it("shortens REA's JSON log lines", () => {
    const line = JSON.stringify({
      level: 40,
      tool: "binary_overview",
      durationMs: 70285.19,
      status: "error",
      msg: "MCP tool execution completed",
    });
    expect(formatReaLog(line)).toBe("binary_overview error 70285 ms: MCP tool execution completed");
  });

  it("passes other lines through", () => {
    expect(formatReaLog("plain text")).toBe("plain text");
  });
});

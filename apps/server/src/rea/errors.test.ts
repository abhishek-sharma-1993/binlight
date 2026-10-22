import type { CallToolResult } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { reaErrorFromResult } from "./errors.js";

const failed = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

describe("reaErrorFromResult", () => {
  it("parses REA's structured error", () => {
    const error = {
      code: "target_unavailable",
      category: "unavailable",
      message: "No app is open.",
      retryable: false,
      remediation: { action: "Call open_binary first." },
    };
    expect(reaErrorFromResult(failed(JSON.stringify({ error })))).toEqual(error);
  });

  it("keeps the raw text when the error is not REA-shaped, never a blank", () => {
    expect(reaErrorFromResult(failed("segfault in provider"))).toEqual({
      code: "unparsed_rea_error",
      message: "segfault in provider",
    });
    expect(reaErrorFromResult(failed("")).message).toBe("REA reported an error with no message.");
  });
});

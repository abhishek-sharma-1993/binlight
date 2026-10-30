import { describe, expect, it } from "vitest";
import { ReaToolError } from "../rea/errors.js";
import { toStepError } from "./steps.js";

describe("toStepError", () => {
  it("adds REA's issue messages to its generic message", () => {
    const err = new ReaToolError("inspect_go_binary", {
      code: "invalid_request",
      category: "invalid_input",
      message: "Analysis input is invalid. Check the arguments and try again.",
      remediation: { action: "Correct the listed arguments and retry." },
      details: {
        operation: "inspect_go_binary",
        issues: [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected a regular file without a symlink: /opt/homebrew/bin/ollama",
          },
        ],
      },
    });
    expect(toStepError(err)).toEqual({
      code: "invalid_request",
      message:
        "Analysis input is invalid. Check the arguments and try again. Expected a regular file without a symlink: /opt/homebrew/bin/ollama",
      remediation: "Correct the listed arguments and retry.",
    });
  });

  it("keeps REA's message as is when there are no issues", () => {
    const err = new ReaToolError("x", { code: "c", message: "m" });
    expect(toStepError(err)).toEqual({ code: "c", message: "m" });
  });
});

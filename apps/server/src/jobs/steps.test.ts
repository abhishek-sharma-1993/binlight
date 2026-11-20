import { describe, expect, it } from "vitest";
import { ReaToolError } from "../rea/errors.js";
import { evidence } from "./fakes.js";
import { parseResult, toStepError } from "./steps.js";

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

describe("parseResult", () => {
  it("accepts Go dependencies with no checksum, as replaced modules have (Docker Desktop)", () => {
    const mod = (
      path: string,
      version: string,
      sum: string | null,
      replacement: unknown = null,
    ) => ({
      path,
      version,
      sum,
      replacement,
    });
    const value = evidence("inspect_go_binary", {
      format: "macho",
      architecture: "arm64",
      build_info: {
        go_version: "go1.27.3",
        module: {
          path: "github.com/docker/pinata/common/cmd/com.docker.backend",
          main: mod("github.com/docker/pinata", "v0.0.1", ""),
          dependencies: [
            mod("github.com/spf13/cobra", "v1.10.2", "h1:abc="),
            mod(
              "github.com/hanwen/go-fuse/v2",
              "v2.8.0",
              null,
              mod("github.com/djs55/go-fuse/v2", "v2.1.6", "h1:def="),
            ),
          ],
          settings: [],
          complete: true,
        },
      },
    });
    expect(() => parseResult("inspect_go_binary", value)).not.toThrow();
  });
});

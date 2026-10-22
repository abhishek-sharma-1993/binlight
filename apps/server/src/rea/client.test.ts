import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReaClient } from "./client.js";
import { ReaProcessError, ReaToolError } from "./errors.js";
import { installedRea, PINNED_REA_VERSION } from "./version.js";

// These tests spawn the real pinned `rea --mcp`. No Ghidra analysis is started.

describe("REA pin", () => {
  it("package.json pins rea-agents exactly to PINNED_REA_VERSION", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["rea-agents"]).toBe(PINNED_REA_VERSION);
    expect(installedRea().version).toBe(PINNED_REA_VERSION);
  });
});

describe("ReaClient against rea --mcp", () => {
  let rea: ReaClient;

  beforeAll(async () => {
    rea = await ReaClient.connect();
  }, 60_000);
  afterAll(() => rea.close());

  it("connects to the pinned version", () => {
    expect(rea.version).toBe(PINNED_REA_VERSION);
  });

  it("lists REA's tools, including the ones phase 0 needs", async () => {
    const names = (await rea.listTools()).map((t) => t.name);
    for (const tool of ["open_binary", "binary_overview", "list_strings", "list_procedures"]) {
      expect(names).toContain(tool);
    }
  });

  it("turns a failed tool call into ReaToolError with REA's code and remediation", async () => {
    const err = await rea
      .callTool("open_binary", { path: "/nonexistent/binlight-test" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReaToolError);
    const { rea: detail } = err as ReaToolError;
    expect(detail.code).toBe("target_unavailable");
    expect(detail.message).toContain("/nonexistent/binlight-test");
    expect(detail.remediation?.action).toBeTruthy();
  });

  it("returns structured Evidence for a successful call", async () => {
    const plist = "/System/Applications/Calculator.app/Contents/Info.plist";
    await rea.callTool("open_binary", { path: plist });
    const result = await rea.callTool("inspect_plist", { path: plist });
    expect(result.untrustedContent).toBe(true);
    expect(result.structured).toMatchObject({
      evidence_id: expect.stringMatching(/^ev_/),
      operation: "inspect_plist",
    });
    await rea.callTool("close_binary");
  });
});

describe("ReaClient version guard", () => {
  it("refuses a REA version other than the pinned one", async () => {
    await expect(ReaClient.connect({ expectedVersion: "0.0.1" })).rejects.toBeInstanceOf(
      ReaProcessError,
    );
  }, 60_000);

  it("reports a REA that cannot start, with the command it tried", async () => {
    const err = await ReaClient.connect({
      command: { command: "/nonexistent/rea", args: ["--mcp"] },
      connectTimeoutMs: 5_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReaProcessError);
    expect((err as Error).message).toContain("/nonexistent/rea");
  }, 30_000);
});

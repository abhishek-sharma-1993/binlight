import type { JobStep } from "@binlight/shared";
import { describe, expect, it } from "vitest";
import { formatDuration, stepDetail, stepElapsed } from "./format.js";

const base: JobStep = { id: "overview", label: "Analyse (overview)", status: "pending" };

describe("stepDetail", () => {
  it("shows a failed step's real error and never its counts", () => {
    const detail = stepDetail({
      ...base,
      status: "failed",
      counts: { strings: 0 },
      summary: "0 strings",
      error: {
        code: "execution_failure",
        message: "Analysis could not complete.",
        remediation: "Run rea doctor.",
      },
    });
    expect(detail).toEqual({
      kind: "error",
      code: "execution_failure",
      message: "Analysis could not complete.",
      remediation: "Run rea doctor.",
    });
  });

  it("never renders a failed step blank, even without an error from the server", () => {
    expect(stepDetail({ ...base, status: "failed" })).toMatchObject({
      kind: "error",
      message: expect.stringContaining("failed"),
    });
  });

  it("always gives a skipped step a reason", () => {
    expect(stepDetail({ ...base, status: "skipped", reason: "No deep route." })).toEqual({
      kind: "skipped",
      reason: "No deep route.",
    });
    expect(stepDetail({ ...base, status: "skipped" })).toMatchObject({ kind: "skipped" });
  });

  it("shows counts only for a step that succeeded", () => {
    expect(
      stepDetail({ ...base, status: "done", summary: "7,553 strings", counts: { strings: 7553 } }),
    ).toEqual({
      kind: "summary",
      text: "7,553 strings",
      counts: { strings: 7553 },
    });
  });
});

describe("timing", () => {
  it("formats durations from ms to hours", () => {
    expect(formatDuration(640)).toBe("640 ms");
    expect(formatDuration(66_247)).toBe("1 min 6 s");
    expect(formatDuration(4.5 * 3600_000)).toBe("4 h 30 min");
    expect(formatDuration(1500)).toBe("1.5 s");
  });

  it("ticks a running step from its start time", () => {
    const running = { ...base, status: "running" as const, startedAt: "2026-10-23T00:00:00.000Z" };
    expect(stepElapsed(running, Date.parse("2026-10-23T00:00:05.000Z"))).toBe(5000);
    expect(stepElapsed({ ...base, status: "done", elapsedMs: 12 }, 0)).toBe(12);
    expect(stepElapsed(base, 0)).toBeUndefined();
  });
});

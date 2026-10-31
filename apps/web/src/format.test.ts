import type { JobStep } from "@binlight/shared";
import { describe, expect, it } from "vitest";
import {
  about,
  cacheText,
  expectationText,
  expectedProgress,
  formatDuration,
  stepDetail,
  stepElapsed,
} from "./format.js";

const base: JobStep = { id: "overview", label: "Analyse (overview)", target: 0, status: "pending" };

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

describe("expectations", () => {
  const start = "2026-10-31T10:00:00.000Z";
  const at = (s: number) => Date.parse(start) + s * 1000;
  const running = {
    ...base,
    status: "running" as const,
    startedAt: start,
    expected: {
      ms: 977_530,
      basis: "same-binary" as const,
      samples: 1,
      lastAt: "2026-10-23T11:00:00.000Z",
    },
  };

  it("says how long it took last time, while running", () => {
    expect(expectationText(running, at(60))).toBe(
      "Expected about 16 min (it took 16 min 17 s last time, 23 Oct).",
    );
    expect(expectedProgress(running, at(489))).toBeCloseTo(0.5, 2);
  });

  it("says when a step is taking longer than expected, and never shows it as finished early", () => {
    expect(expectationText(running, at(1600))).toMatch(
      /^Taking longer than expected \(about 16 min/,
    );
    expect(expectedProgress(running, at(5000))).toBe(0.99);
  });

  it("labels a size-scaled figure as an estimate", () => {
    const scaled = {
      ...running,
      expected: { ms: 1_400_000, basis: "size-scaled" as const, samples: 2 },
    };
    expect(expectationText(scaled, at(10))).toBe(
      "Expected about 23 min (estimated by size from 2 earlier analyses on this machine).",
    );
  });

  it("leaves out expectations for steps that take a moment", () => {
    const quick = { ...running, expected: { ms: 84, basis: "same-binary" as const, samples: 1 } };
    expect(expectationText(quick, at(0))).toBeUndefined();
    expect(expectedProgress(quick, at(0))).toBeUndefined();
  });

  it("shows nothing without history, and names the date of a cached result", () => {
    expect(
      expectationText({ ...base, status: "running", startedAt: start }, at(1)),
    ).toBeUndefined();
    expect(
      cacheText({ ...base, status: "done", cached: true, cachedAt: "2026-10-23T11:00:00.000Z" }),
    ).toBe("Reused from the analysis on 23 Oct (no REA call).");
    expect(about(9_000)).toBe("about 9 s");
    expect(about(5.4 * 3_600_000)).toBe("about 5.4 h");
  });
});

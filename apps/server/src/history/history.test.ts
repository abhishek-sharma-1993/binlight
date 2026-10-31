import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimate, HistoryFile, type StepKind, type StepRun } from "./history.js";

const MB = 1024 * 1024;
const analysis: StepKind = {
  tool: "binary_overview",
  route: "docker-ghidra",
  carriesAnalysis: true,
};
const run = (over: Partial<StepRun>): StepRun => ({
  at: "2026-10-23T11:00:00.000Z",
  sha256: "k".repeat(64),
  bytes: 64 * MB,
  ...analysis,
  elapsedMs: 977_530,
  ...over,
});

describe("estimate", () => {
  it("uses the same binary's last run of this kind of step", () => {
    const runs = [
      run({ elapsedMs: 1_000_000 }),
      run({ elapsedMs: 977_530, at: "2026-10-31T09:00:00.000Z" }),
    ];
    expect(estimate(runs, analysis, "k".repeat(64), 64 * MB)).toEqual({
      ms: 977_530,
      basis: "same-binary",
      samples: 2,
      lastAt: "2026-10-31T09:00:00.000Z",
    });
  });

  it("fits fixed start-up time plus time per byte when sizes differ (real runs on this Mac)", () => {
    // The Go fixture (2.7 MB) twice and kubectl (64 MB), Docker Ghidra, 31 Oct.
    const runs = [
      run({ sha256: "f".repeat(64), bytes: 2_718_850, elapsedMs: 78_862 }),
      run({ sha256: "f".repeat(64), bytes: 2_718_850, elapsedMs: 85_261 }),
      run({ bytes: 64_090_258, elapsedMs: 978_426 }),
    ];
    // Ollama: 25,419,282 bytes; its gate-run analysis took 507,817 ms.
    const e = estimate(runs, analysis, "o".repeat(64), 25_419_282);
    expect(e?.basis).toBe("size-scaled");
    expect(e?.samples).toBe(3);
    expect(Math.abs((e?.ms ?? 0) - 507_817) / 507_817).toBeLessThan(0.25);
    // The old per-byte rate from the small fixture alone would say about 12 min.
    expect(e?.ms).toBeLessThan(25_419_282 * (82_000 / 2_718_850));
  });

  it("scales other binaries' analysis time by size, using the median rate", () => {
    // kubectl: 64 MB in 16.3 min; Ollama: 25 MB in 8.5 min (gate run).
    // Similar sizes (less than 2x apart): no line fit, the median rate.
    const runs = [run({}), run({ sha256: "o".repeat(64), bytes: 40 * MB, elapsedMs: 750_000 })];
    const e = estimate(runs, analysis, "n".repeat(64), 50 * MB);
    expect(e).toMatchObject({ basis: "size-scaled", samples: 2 });
    const median = (977_530 / (64 * MB) + 750_000 / (40 * MB)) / 2;
    expect(e?.ms).toBe(Math.round(50 * MB * median));
  });

  it("does not scale quick calls or tiny binaries, and never guesses without history", () => {
    const quick: StepKind = {
      tool: "list_strings",
      route: "docker-ghidra",
      carriesAnalysis: false,
    };
    expect(estimate([run({ ...quick })], quick, "n".repeat(64), 40 * MB)).toBeUndefined();
    expect(estimate([run({ bytes: 100_000 })], analysis, "n".repeat(64), 40 * MB)).toBeUndefined();
    expect(estimate([], analysis, "n".repeat(64), 40 * MB)).toBeUndefined();
    // A different route is a different machine path (native vs emulated).
    expect(
      estimate([run({})], { ...analysis, route: "native-ghidra" }, "k".repeat(64), 64 * MB),
    ).toBeUndefined();
  });
});

describe("HistoryFile", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "binlight-history-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("appends runs and skips lines it cannot read", async () => {
    const file = new HistoryFile(join(dir, "history.jsonl"));
    await file.record(run({}));
    appendFileSync(file.path, "{ not json\n");
    await file.record(run({ elapsedMs: 5 }));
    expect((await file.read()).map((r) => r.elapsedMs)).toEqual([977_530, 5]);
    expect(await file.expect(analysis, "k".repeat(64), 64 * MB)).toMatchObject({
      ms: 5,
      basis: "same-binary",
    });
  });

  it("has no history before the first run", async () => {
    expect(await new HistoryFile(join(dir, "none.jsonl")).read()).toEqual([]);
  });
});

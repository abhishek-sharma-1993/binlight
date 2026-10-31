import type { JobEvent } from "@binlight/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceCache } from "../cache/evidence.js";
import { estimate, type StepHistory, type StepRun } from "../history/history.js";
import { deps, dockerRoute, fakeSession, report } from "./fakes.js";
import { JobManager } from "./manager.js";

function memoryHistory(initial: StepRun[] = []): StepHistory & { runs: StepRun[] } {
  const runs = [...initial];
  return {
    runs,
    record: async (r) => {
      runs.push(r);
    },
    expect: async (kind, sha, bytes) => estimate(runs, kind, sha, bytes),
  };
}

const sha = "b".repeat(64);
const pre = () => report({ analysisSha256: sha, analysisBytes: 64 * 1024 * 1024 });

describe("step expectations from history", () => {
  let root: string;
  beforeEach(() => (root = mkdtempSync(join(tmpdir(), "binlight-jobhistory-"))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("records each live step, marking the call that carried the analysis", async () => {
    const history = memoryHistory();
    const jobs = new JobManager({ ...deps(fakeSession(dockerRoute), pre()), history });
    await jobs.settled(jobs.create({ targets: ["/apps/kubectl"] }).id);
    expect(history.runs.map((r) => [r.tool, r.route, r.carriesAnalysis])).toEqual([
      ["start", "docker-ghidra", false],
      ["open_binary", "docker-ghidra", false],
      ["inspect_go_binary", "local", false],
      ["binary_overview", "docker-ghidra", true],
      ["list_strings", "docker-ghidra", false],
      ["list_procedures", "docker-ghidra", false],
      ["close_binary", "docker-ghidra", false],
    ]);
    expect(history.runs.every((r) => r.sha256 === sha && r.bytes === 64 * 1024 * 1024)).toBe(true);
  });

  it("tells a running step how long it took last time", async () => {
    const history = memoryHistory([
      {
        at: "2026-10-23T11:00:00.000Z",
        sha256: sha,
        bytes: 64 * 1024 * 1024,
        tool: "binary_overview",
        route: "docker-ghidra",
        carriesAnalysis: true,
        elapsedMs: 977_530,
      },
    ]);
    const jobs = new JobManager({ ...deps(fakeSession(dockerRoute), pre()), history });
    const { id } = jobs.create({ targets: ["/apps/kubectl"] });
    const running: JobEvent[] = [];
    jobs.subscribe(id, (e) => {
      if (e.type === "step" && e.step.id === "overview" && e.step.status === "running")
        running.push(e);
    });
    await jobs.settled(id);
    expect(running[0]).toMatchObject({
      step: {
        expected: {
          ms: 977_530,
          basis: "same-binary",
          samples: 1,
          lastAt: "2026-10-23T11:00:00.000Z",
        },
      },
    });
  });

  it("records nothing for steps answered from the cache", async () => {
    const cache = new EvidenceCache(root);
    const first = memoryHistory();
    const a = new JobManager({ ...deps(fakeSession(dockerRoute), pre()), history: first, cache });
    await a.settled(a.create({ targets: ["/apps/kubectl"] }).id);
    const second = memoryHistory();
    const b = new JobManager({ ...deps(fakeSession(dockerRoute), pre()), history: second, cache });
    const job = await b.settled(b.create({ targets: ["/apps/kubectl"] }).id);
    expect(job?.steps.filter((s) => s.cached).length).toBe(4);
    expect(second.runs).toEqual([]);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStep } from "@binlight/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceCache } from "../cache/evidence.js";
import { ReaToolError } from "../rea/errors.js";
import { deps, fakeSession, report } from "./fakes.js";
import { JobManager } from "./manager.js";

const byId = (steps: JobStep[] = []) => Object.fromEntries(steps.map((s) => [s.id, s]));
const deep = { route: "docker-ghidra", providerId: "ghidra" } as const;
const sha = "d".repeat(64);

describe("jobs with the evidence cache", () => {
  let root: string;
  let cache: EvidenceCache;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "binlight-jobcache-"));
    cache = new EvidenceCache(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const manager = (fake: ReturnType<typeof fakeSession>, analysisSha256 = sha) => {
    const d = deps(fake, report({ analysisSha256 }));
    return { jobs: new JobManager({ ...d, cache }), d };
  };

  it("reuses a repeat run's results without starting REA", async () => {
    const first = fakeSession(deep);
    const a = manager(first);
    const one = await a.jobs.settled(a.jobs.create("/apps/tool").id);
    expect(one?.status).toBe("done");
    expect(one?.steps.some((s) => s.cached)).toBe(false);

    const second = fakeSession(deep);
    const b = manager(second);
    const two = await b.jobs.settled(b.jobs.create("/apps/tool").id);

    expect(two?.status).toBe("done");
    expect(b.d.opened).toBe(0);
    expect(second.calls).toEqual([]);
    const s = byId(two?.steps);
    for (const id of ["go", "overview", "strings", "procedures"]) {
      expect(s[id]).toMatchObject({ status: "done", cached: true, hasResult: true });
      expect(s[id]?.cachedAt).toBeTruthy();
      // Same evidence, same summary as the run that produced it.
      expect(s[id]?.evidenceId).toBe(byId(one?.steps)[id]?.evidenceId);
      expect(s[id]?.summary).toBe(byId(one?.steps)[id]?.summary);
    }
    for (const id of ["start", "open", "close"]) {
      expect(s[id]).toMatchObject({
        status: "skipped",
        reason: expect.stringContaining("Not needed"),
      });
    }
    expect(two?.reaVersion).toBe("6.7.0");
    // Results are served from disk.
    expect(await b.jobs.result(two?.id ?? "", "overview")).toMatchObject({
      normalized_result: { string_count: 97076 },
    });
  });

  it("runs only what is missing after a partial run", async () => {
    const failing = fakeSession(deep, {
      list_procedures: async () => {
        throw new ReaToolError("list_procedures", { code: "execution_failure", message: "boom" });
      },
    });
    const a = manager(failing);
    expect((await a.jobs.settled(a.jobs.create("/apps/tool").id))?.status).toBe("failed");

    const retry = fakeSession(deep);
    const b = manager(retry);
    const job = await b.jobs.settled(b.jobs.create("/apps/tool").id);
    expect(job?.status).toBe("done");
    // Failed steps are never cached, so only procedures (plus open/close) ran.
    expect(retry.calls).toEqual(["open_binary", "list_procedures", "close_binary"]);
    const s = byId(job?.steps);
    expect(s["overview"]?.cached).toBe(true);
    expect(s["procedures"]?.cached).toBeUndefined();
  });

  it("keys on the analysed bytes: a different binary is analysed afresh", async () => {
    const a = manager(fakeSession(deep));
    await a.jobs.settled(a.jobs.create("/apps/tool").id);
    const other = fakeSession(deep);
    const b = manager(other, "e".repeat(64));
    await b.jobs.settled(b.jobs.create("/apps/other").id);
    expect(other.calls).toContain("binary_overview");
  });

  it("ignores the cache when asked for a fresh run", async () => {
    const a = manager(fakeSession(deep));
    await a.jobs.settled(a.jobs.create("/apps/tool").id);
    const again = fakeSession(deep);
    const b = manager(again);
    const job = await b.jobs.settled(b.jobs.create("/apps/tool", { fresh: true }).id);
    expect(job?.fresh).toBe(true);
    expect(again.calls).toContain("binary_overview");
    expect(job?.steps.some((s) => s.cached)).toBe(false);
  });

  it("caches Go build info independently of the deep provider", async () => {
    const a = manager(fakeSession(deep));
    await a.jobs.settled(a.jobs.create("/apps/tool").id);

    const noDeep = fakeSession(undefined);
    const pre = report({ analysisSha256: sha });
    delete pre.deep;
    const jobs = new JobManager({ ...deps(noDeep, pre), cache });
    const job = await jobs.settled(jobs.create("/apps/tool").id);
    expect(noDeep.calls).toEqual([]);
    expect(byId(job?.steps)["go"]).toMatchObject({ status: "done", cached: true });
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobEvent } from "@binlight/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceCache } from "../cache/evidence.js";
import { ReaToolError } from "../rea/errors.js";
import { rawAnalysis } from "../recipes/raw-analysis.js";
import type { Rule } from "../rules/types.js";
import { deps, dockerRoute, evidence, fakeSession, report } from "./fakes.js";
import { JobManager } from "./manager.js";

const strings = (values: string[]) => async () =>
  evidence(
    "list_strings",
    values.map((value, i) => ({ address: `0x${i}`, value })),
  );

describe("findings in jobs", () => {
  let root: string;
  beforeEach(() => (root = mkdtempSync(join(tmpdir(), "binlight-findings-"))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("runs the recipe's rules after the last step and publishes the findings", async () => {
    const fake = fakeSession(dockerRoute, {
      list_strings: strings(["see https://kubernetes.io/docs", "token ghp_" + "b".repeat(36)]),
    });
    const jobs = new JobManager(deps(fake));
    const { id } = jobs.create({ targets: ["/apps/tool"] });
    const events: JobEvent[] = [];
    jobs.subscribe(id, (e) => events.push(e));
    const job = await jobs.settled(id);

    expect(job?.status).toBe("done");
    expect(job?.rules?.map((r) => [r.id, r.status])).toEqual([
      ["go-build-info", "ran"],
      ["hardcoded-hosts", "ran"],
      ["credential-values", "ran"],
    ]);
    const ids = job?.findings?.map((f) => f.id) ?? [];
    expect(ids).toEqual(
      expect.arrayContaining(["go:toolchain", "host:kubernetes.io", "hosts:summary"]),
    );
    expect(job?.findings?.some((f) => f.kind === "credential-value")).toBe(true);
    // Every finding cites a step of this job and that step's evidence id.
    for (const f of job?.findings ?? []) {
      for (const e of f.evidence) {
        const step = job?.steps.find((s) => s.id === e.step);
        expect(step?.evidenceId, f.id).toBe(e.evidenceId);
      }
    }
    // Findings arrive after the last step, before the job ends.
    const types = events.map((e) => e.type);
    expect(types.indexOf("findings")).toBeGreaterThan(types.lastIndexOf("step"));
    expect(types.indexOf("findings")).toBeLessThan(types.lastIndexOf("job"));
  });

  it("marks string rules not-run when listing strings failed, and keeps the Go findings", async () => {
    const fake = fakeSession(dockerRoute, {
      list_strings: async () => {
        throw new ReaToolError("list_strings", { code: "resource_constraint", message: "too big" });
      },
    });
    const jobs = new JobManager(deps(fake));
    const job = await jobs.settled(jobs.create({ targets: ["/apps/tool"] }).id);
    const runs = Object.fromEntries((job?.rules ?? []).map((r) => [r.id, r]));
    expect(runs["hardcoded-hosts"]).toMatchObject({
      status: "not-run",
      reason: "Needs results that this job doesn't have: List strings.",
    });
    expect(runs["go-build-info"]?.status).toBe("ran");
    expect(job?.findings?.some((f) => f.rule === "hardcoded-hosts")).toBe(false);
  });

  it("produces the same findings on a cached repeat", async () => {
    const cache = new EvidenceCache(root);
    const run = async () => {
      const fake = fakeSession(dockerRoute, { list_strings: strings(["https://a.example.org/x"]) });
      const jobs = new JobManager({
        ...deps(fake, report({ analysisSha256: "e".repeat(64) })),
        cache,
      });
      return { fake, job: await jobs.settled(jobs.create({ targets: ["/apps/tool"] }).id) };
    };
    const first = await run();
    const second = await run();
    expect(second.fake.calls).toEqual([]);
    expect(second.job?.findings).toEqual(first.job?.findings);
  });

  it("fails the job, visibly, when a rule breaks", async () => {
    const broken: Rule = {
      id: "broken",
      title: "Broken",
      needs: ["go"],
      run: () => {
        throw new Error("rule bug");
      },
    };
    const recipe = { ...rawAnalysis, id: "with-broken", rules: [broken] };
    const jobs = new JobManager({ ...deps(fakeSession(dockerRoute)), recipes: [recipe] });
    const job = await jobs.settled(
      jobs.create({ recipe: "with-broken", targets: ["/apps/tool"] }).id,
    );
    expect(job?.status).toBe("failed");
    expect(job?.rules).toEqual([expect.objectContaining({ status: "failed", reason: "rule bug" })]);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStep } from "@binlight/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceCache } from "../cache/evidence.js";
import { goOutcome, listOutcome, overviewOutcome } from "./steps.js";
import type { ToolOutput } from "../rea/schemas.js";
import { RECIPES, validateRecipe, type Recipe } from "../recipes/index.js";
import { deps, dockerRoute, fakeSession, report, type FakeRea } from "./fakes.js";
import { JobManager, JobRequestError, type JobDeps } from "./manager.js";

const byId = (steps: JobStep[] = []) => Object.fromEntries(steps.map((s) => [s.id, s]));
const go = (r: unknown) => goOutcome(r as ToolOutput<"inspect_go_binary">);

/** A two-target recipe shaped like "What changed?". */
const compare: Recipe = {
  id: "compare-test",
  title: "Compare (test)",
  question: "What differs?",
  description: "Test recipe.",
  targets: 2,
  targetLabels: ["Older", "Newer"],
  steps: [
    {
      id: "go",
      label: "Go info",
      why: "w",
      tool: "inspect_go_binary",
      deep: false,
      args: (t) => ({ path: t }),
      outcome: go,
    },
    {
      id: "overview",
      label: "Overview",
      why: "w",
      tool: "binary_overview",
      deep: true,
      outcome: (r) => overviewOutcome(r as ToolOutput<"binary_overview">),
    },
    {
      id: "strings",
      label: "Strings",
      why: "w",
      tool: "list_strings",
      deep: true,
      targets: [0],
      outcome: (r) => listOutcome("strings", r as ToolOutput<"list_strings">),
    },
  ],
};

/** A recipe that needs no disassembler, like "What's inside?". */
const light: Recipe = {
  id: "light-test",
  title: "Light (test)",
  question: "What is it built from?",
  description: "Test recipe.",
  targets: 1,
  targetLabels: ["Binary"],
  steps: [compare.steps[0] as Recipe["steps"][number]],
};

/** Two sessions in a row, one per target, recording what each was asked. */
function twoSessions(): { d: JobDeps & { opened: number }; fakes: FakeRea[]; paths: string[] } {
  const fakes = [fakeSession(dockerRoute), fakeSession(dockerRoute)];
  const paths: string[] = [];
  const d = {
    ...deps(fakes[0] as FakeRea),
    recipes: [compare, light],
    openSession: async (path: string) => {
      paths.push(path);
      return (fakes[d.opened++] as FakeRea).session;
    },
  };
  d.preflight = async (path: string) =>
    report({ analysisPath: path, target: { path, format: "mach-o", architectures: ["arm64"] } });
  return { d, fakes, paths };
}

describe("recipe definitions", () => {
  it("every shipped recipe is valid", () => {
    for (const recipe of RECIPES) expect(() => validateRecipe(recipe)).not.toThrow();
  });

  it("rejects duplicate, reserved or badly targeted steps", () => {
    const step = compare.steps[0] as Recipe["steps"][number];
    expect(() => validateRecipe({ ...light, steps: [step, step] })).toThrow(/duplicate/);
    expect(() => validateRecipe({ ...light, steps: [{ ...step, id: "open" }] })).toThrow(
      /reserved/,
    );
    expect(() => validateRecipe({ ...light, steps: [{ ...step, targets: [1] }] })).toThrow(
      /no target 1/,
    );
    expect(() => validateRecipe({ ...light, targetLabels: [] })).toThrow(/target label/);
  });
});

describe("JobManager with recipes", () => {
  it("runs two targets in turn, one REA session each, with suffixed step ids", async () => {
    const { d, fakes, paths } = twoSessions();
    const jobs = new JobManager(d);
    const job = await jobs.settled(
      jobs.create({ recipe: "compare-test", targets: ["/apps/v1/tool", "/apps/v2/tool"] }).id,
    );

    expect(job?.status).toBe("done");
    expect(job?.steps.map((s) => s.id)).toEqual([
      "preflight@1", "start@1", "open@1", "go@1", "overview@1", "strings@1", "close@1",
      "preflight@2", "start@2", "open@2", "go@2", "overview@2", "close@2",
    ]); // prettier-ignore
    expect(paths).toEqual(["/apps/v1/tool", "/apps/v2/tool"]);
    expect(fakes[0]?.calls).toEqual([
      "open_binary",
      "inspect_go_binary",
      "binary_overview",
      "list_strings",
      "close_binary",
    ]);
    expect(fakes[1]?.calls).toEqual([
      "open_binary",
      "inspect_go_binary",
      "binary_overview",
      "close_binary",
    ]);
    // Each session is closed before the next target starts.
    expect(fakes.map((f) => f.closed)).toEqual([1, 1]);
    const s = byId(job?.steps);
    expect(s["go@2"]?.label).toBe("Go info (Newer: tool)");
    expect(s["go@1"]).toMatchObject({ target: 0, why: "w", status: "done" });
    expect(job?.preflights.map((p) => p?.analysisPath)).toEqual(["/apps/v1/tool", "/apps/v2/tool"]);
    expect(await jobs.result(job?.id ?? "", "strings@1")).toMatchObject({
      operation: "list_strings",
    });
  });

  it("keeps going with the second target when the first can't be analysed", async () => {
    const { d, fakes } = twoSessions();
    d.preflight = async (path: string) =>
      path.includes("v1")
        ? report({
            canAnalyse: false,
            issues: [{ severity: "blocker", code: "target_missing", message: "ENOENT" }],
          })
        : report({ analysisPath: path });
    // The first session goes unused, so the second target gets fakes[0].
    const jobs = new JobManager(d);
    const job = await jobs.settled(
      jobs.create({ recipe: "compare-test", targets: ["/apps/v1/tool", "/apps/v2/tool"] }).id,
    );

    expect(job?.status).toBe("failed");
    const s = byId(job?.steps);
    expect(s["preflight@1"]?.error?.code).toBe("target_missing");
    expect(s["overview@1"]).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("Preflight"),
    });
    expect(s["overview@2"]?.status).toBe("done");
    expect(fakes[0]?.calls).toContain("binary_overview");
  });

  it("starts local REA (no container) when a target's live steps need no disassembler", async () => {
    const { d } = twoSessions();
    const routes: unknown[] = [];
    const open = d.openSession;
    d.openSession = async (path, route, onLog) => {
      routes.push(route?.route);
      return open(path, route, onLog);
    };
    const jobs = new JobManager(d);
    await jobs.settled(jobs.create({ recipe: "light-test", targets: ["/apps/tool"] }).id);
    expect(routes).toEqual([undefined]);
  });

  it("adds no open or close steps for a recipe without deep steps, and needs no deep route", async () => {
    const fake = fakeSession(undefined);
    const pre = report();
    delete pre.deep;
    const jobs = new JobManager({ ...deps(fake, pre), recipes: [light] });
    const job = await jobs.settled(
      jobs.create({ recipe: "light-test", targets: ["/apps/tool"] }).id,
    );
    expect(job?.status).toBe("done");
    expect(job?.steps.map((s) => s.id)).toEqual(["preflight", "start", "go"]);
    expect(fake.calls).toEqual(["inspect_go_binary"]);
  });

  it("refuses unknown recipes and the wrong number of targets", () => {
    const jobs = new JobManager({ ...deps(fakeSession(dockerRoute)), recipes: [compare] });
    expect(() => jobs.create({ recipe: "nope", targets: ["/a"] })).toThrow(JobRequestError);
    expect(() => jobs.create({ recipe: "compare-test", targets: ["/a"] })).toThrow(
      /needs 2 targets: Older, Newer/,
    );
    expect(() => jobs.create({ recipe: "compare-test", targets: ["/a", " "] })).toThrow(
      JobRequestError,
    );
  });

  it("defaults to raw analysis, phase 0's steps unchanged", () => {
    const jobs = new JobManager(deps(fakeSession(dockerRoute)));
    const job = jobs.create({ targets: ["/apps/tool"] });
    expect(job.recipe.id).toBe("raw-analysis");
    expect(job.steps.map((s) => s.id)).toEqual([
      "preflight",
      "start",
      "open",
      "go",
      "overview",
      "strings",
      "procedures",
      "close",
    ]);
  });
});

describe("caching per argument set", () => {
  let root: string;
  beforeEach(() => (root = mkdtempSync(join(tmpdir(), "binlight-recipe-cache-"))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const searching = (pattern: string): Recipe => ({
    ...light,
    id: `search-${pattern.length}`,
    steps: [
      {
        id: "search",
        label: `Search ${pattern}`,
        why: "w",
        tool: "list_strings",
        deep: true,
        args: () => ({ pattern }),
        outcome: (r) => listOutcome("strings", r as ToolOutput<"list_strings">),
      },
    ],
  });

  it("caches the same tool separately for different arguments", async () => {
    const cache = new EvidenceCache(root);
    const sha = "f".repeat(64);
    const run = async (recipe: Recipe) => {
      const fake = fakeSession(dockerRoute);
      const jobs = new JobManager({
        ...deps(fake, report({ analysisSha256: sha })),
        recipes: [recipe],
        cache,
      });
      const job = await jobs.settled(
        jobs.create({ recipe: recipe.id, targets: ["/apps/tool"] }).id,
      );
      return { fake, job };
    };
    expect((await run(searching("https://"))).fake.calls).toContain("list_strings");
    // Same arguments: from the cache, REA never starts.
    const again = await run(searching("https://"));
    expect(again.fake.calls).toEqual([]);
    expect(byId(again.job?.steps)["search"]?.cached).toBe(true);
    // Different arguments: a separate entry, analysed live.
    expect((await run(searching("http://"))).fake.calls).toContain("list_strings");
  });
});

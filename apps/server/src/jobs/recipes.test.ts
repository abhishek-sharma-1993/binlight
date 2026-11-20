import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStep } from "@binlight/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceCache } from "../cache/evidence.js";
import { goOutcome, listOutcome, overviewOutcome, type MultiCallResult } from "./steps.js";
import { refTo } from "../rules/types.js";
import type { ToolOutput } from "../rea/schemas.js";
import { RECIPES, validateRecipe, type Recipe } from "../recipes/index.js";
import { deps, dockerRoute, fakeSession, goodResults, report, type FakeRea } from "./fakes.js";
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
  rules: [],
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
  rules: [],
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

  it("opens the binary with no provider for metadata steps, and skips steps for other formats", async () => {
    const args: Record<string, unknown>[] = [];
    const fake = fakeSession(dockerRoute, {
      open_binary: async (a) => {
        args.push(a);
        return goodResults["open_binary"];
      },
      inspect_macho: async () => {
        throw new Error("must not run on an ELF file");
      },
    });
    const meta: Recipe = {
      ...light,
      id: "meta-test",
      steps: [
        ...light.steps,
        {
          id: "macho",
          label: "Mach-O",
          why: "w",
          tool: "inspect_macho",
          deep: false,
          opens: true,
          formats: ["mach-o"],
          outcome: go,
        },
        { ...(light.steps[0] as Recipe["steps"][number]), id: "go2", opens: true },
      ],
    };
    const elf = report({
      target: { path: "/apps/tool", format: "elf", architectures: ["x86_64"] },
    });
    const jobs = new JobManager({ ...deps(fake, elf), recipes: [meta] });
    const job = await jobs.settled(
      jobs.create({ recipe: "meta-test", targets: ["/apps/tool"] }).id,
    );
    const s = byId(job?.steps);
    expect(job?.status).toBe("done");
    expect(s["macho"]).toMatchObject({ status: "skipped" });
    expect(s["macho"]?.reason).toBe(
      "Not for this file: it applies to mach-o binaries, and this is elf.",
    );
    expect(s["open"]?.summary).toMatch(/no disassembler needed/);
    expect(args).toHaveLength(1);
    expect(args[0]).not.toHaveProperty("provider_id");
    expect(fake.calls).toEqual([
      "open_binary",
      "inspect_go_binary",
      "inspect_go_binary",
      "close_binary",
    ]);
  });

  it("runs a many-call step, keeps every record, and lets rules cite any of them", async () => {
    const fake = fakeSession(dockerRoute);
    const multi: Recipe = {
      ...light,
      id: "multi-test",
      steps: [
        {
          id: "trace",
          label: "Trace",
          why: "w",
          tool: "list_strings",
          deep: true,
          run: async (ctx) => {
            const overview = await ctx.call("binary_overview", {});
            const strings = await ctx.call("list_strings", {});
            return { calls: [overview, strings].length, hostPath: ctx.hostPath };
          },
          outcome: (r) => {
            const m = r as MultiCallResult<{ calls: number }>;
            return {
              summary: `${m.data.calls} calls`,
              evidenceCount: m.records.length,
              result: r,
            };
          },
        },
      ],
      rules: [
        {
          id: "cites-second",
          title: "Cites the second call",
          needs: ["trace"],
          run: ({ targets }) => {
            const step = targets[0]?.steps.get("trace");
            if (!step) return { findings: [] };
            const id = (step.result as MultiCallResult).records[1]?.evidence_id ?? "";
            return {
              findings: [
                {
                  id: "f",
                  rule: "cites-second",
                  kind: "k",
                  statement: "s",
                  evidence: [refTo(step, id)],
                  confidence: "observed",
                  caveats: [],
                },
              ],
            };
          },
        },
        {
          id: "cites-unknown",
          title: "Cites an id the job never produced",
          needs: ["trace"],
          run: () => ({
            findings: [
              {
                id: "g",
                rule: "cites-unknown",
                kind: "k",
                statement: "s",
                evidence: [{ evidenceId: "ev_nope", step: "trace" }],
                confidence: "observed",
                caveats: [],
              },
            ],
          }),
        },
      ],
    };
    const jobs = new JobManager({ ...deps(fake), recipes: [multi] });
    const job = await jobs.settled(
      jobs.create({ recipe: "multi-test", targets: ["/apps/tool"] }).id,
    );
    const s = byId(job?.steps);
    expect(s["trace"]).toMatchObject({ status: "done", summary: "2 calls", evidenceCount: 2 });
    expect(fake.calls).toEqual(["open_binary", "binary_overview", "list_strings", "close_binary"]);
    expect(job?.findings?.map((f) => f.id)).toEqual(["f"]);
    expect(job?.findings?.[0]?.evidence[0]?.evidenceId).toBe(
      (goodResults["list_strings"] as { evidence_id: string }).evidence_id,
    );
    expect(job?.rules?.find((r) => r.id === "cites-unknown")).toMatchObject({ status: "failed" });
    expect(((await jobs.result(job?.id ?? "", "trace")) as MultiCallResult).data).toEqual({
      calls: 2,
      hostPath: "/apps/tool",
    });
  });

  it("caches many-call steps separately, even with the same tool, and reads them back", async () => {
    const root = mkdtempSync(join(tmpdir(), "binlight-multi-cache-"));
    try {
      const step = (id: string, tool: string): Recipe["steps"][number] => ({
        id,
        label: id,
        why: "w",
        tool: "search_bytes",
        deep: true,
        run: async (ctx) => ({ id, value: await ctx.call(tool, {}) }),
        outcome: (r) => ({ summary: id, result: r }),
      });
      const recipe: Recipe = {
        ...light,
        id: "multi-cache",
        steps: [step("a", "binary_overview"), step("b", "list_strings")],
      };
      const make = () =>
        new JobManager({
          ...deps(fakeSession(dockerRoute), report({ analysisSha256: "c".repeat(64) })),
          recipes: [recipe],
          cache: new EvidenceCache(root),
        });
      const first = make();
      const j1 = await first.settled(
        first.create({ recipe: "multi-cache", targets: ["/apps/tool"] }).id,
      );
      const second = make();
      const j2 = await second.settled(
        second.create({ recipe: "multi-cache", targets: ["/apps/tool"] }).id,
      );
      expect(j2?.steps.filter((s) => s.cached).map((s) => s.id)).toEqual(["a", "b"]);
      for (const [jobs, job] of [
        [first, j1],
        [second, j2],
      ] as const) {
        expect(((await jobs.result(job?.id ?? "", "a")) as MultiCallResult).data).toMatchObject({
          id: "a",
        });
        expect(((await jobs.result(job?.id ?? "", "b")) as MultiCallResult).data).toMatchObject({
          id: "b",
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

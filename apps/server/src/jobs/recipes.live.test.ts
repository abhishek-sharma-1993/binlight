import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { JobStep } from "@binlight/shared";
import { afterAll, describe, expect, it } from "vitest";
import { EvidenceCache } from "../cache/evidence.js";
import { buildGoFixture } from "../contracts/run.js";
import { preflight } from "../preflight/index.js";
import type { ToolOutput } from "../rea/schemas.js";
import type { Recipe } from "../recipes/index.js";
import { openReaSession } from "../runner/index.js";
import { JobManager } from "./manager.js";
import { goOutcome, overviewOutcome } from "./steps.js";

// Live: the recipe engine on real binaries with the real REA, preflight and
// (for the deep step) the Docker Ghidra runner. Run with `npm run test:contract`.

const OLLAMA = "/opt/homebrew/bin/ollama";

const pair: Recipe = {
  id: "live-pair",
  title: "Live pair",
  question: "Two targets, one deep",
  description: "Engine check.",
  targets: 2,
  targetLabels: ["Fixture", "Ollama"],
  steps: [
    {
      id: "go",
      label: "Go build info",
      why: "w",
      tool: "inspect_go_binary",
      deep: false,
      args: (t) => ({ path: t }),
      outcome: (r) => goOutcome(r as ToolOutput<"inspect_go_binary">),
    },
    {
      id: "overview",
      label: "Overview",
      why: "w",
      tool: "binary_overview",
      deep: true,
      targets: [0],
      outcome: (r) => overviewOutcome(r as ToolOutput<"binary_overview">),
    },
  ],
};

const byId = (steps: JobStep[] = []) => Object.fromEntries(steps.map((s) => [s.id, s]));

describe("recipe engine on real binaries", () => {
  const fixture = buildGoFixture();
  const root = mkdtempSync(join(tmpdir(), "binlight-live-recipes-"));
  const routes: (string | undefined)[] = [];
  const jobs = new JobManager({
    recipes: [pair],
    cache: new EvidenceCache(root),
    preflight: (path) => preflight(path),
    openSession: (path, deep) => {
      routes.push(deep?.route);
      return openReaSession(path, deep);
    },
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(fixture), { recursive: true, force: true });
  });

  it(
    "runs both targets: Ghidra in Docker for the deep one, local REA for the other",
    async () => {
      const job = await jobs.settled(
        jobs.create({ recipe: "live-pair", targets: [fixture, OLLAMA] }).id,
      );
      const s = byId(job?.steps);
      expect(job?.status, JSON.stringify(job?.steps.filter((x) => x.error))).toBe("done");
      expect(s["go@1"]?.summary).toMatch(/^go1\.\d+\.\d+ · binlight\.invalid\/hello/);
      expect(s["overview@1"]?.counts?.["procedures"]).toBeGreaterThan(1000);
      expect(s["go@2"]?.summary).toBe(
        "go1.27.2 · github.com/ollama/ollama v0.40.6+dirty · 51 dependencies",
      );
      expect(job?.steps.map((x) => x.id)).not.toContain("open@2");
      expect(routes).toEqual(["docker-ghidra", undefined]);
    },
    20 * 60_000,
  );

  it(
    "answers a repeat entirely from the cache, without starting REA",
    async () => {
      routes.length = 0;
      const job = await jobs.settled(
        jobs.create({ recipe: "live-pair", targets: [fixture, OLLAMA] }).id,
      );
      expect(job?.status).toBe("done");
      expect(routes).toEqual([]);
      expect(job?.steps.filter((x) => x.cached).map((x) => x.id)).toEqual([
        "go@1",
        "overview@1",
        "go@2",
      ]);
    },
    5 * 60_000,
  );
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EvidenceCache } from "../cache/evidence.js";
import { JobManager } from "../jobs/manager.js";
import { preflight } from "../preflight/index.js";
import { openReaSession } from "../runner/index.js";
import { validateVerdict } from "../verdict/validate.js";
import { whatsInside } from "./whats-inside.js";

// Live: "What's inside?" on kubectl and Ollama with the real REA. Its Go
// dependency list must match `go version -m`, the Go toolchain's own reader.
// Run with `npm run test:contract`.

const TARGETS = ["/opt/homebrew/bin/kubectl", "/opt/homebrew/bin/ollama"];

/** `go version -m`: the toolchain and each dependency's path@version (replacements resolved). */
function goVersionM(path: string) {
  const out = execFileSync("go", ["version", "-m", path], { encoding: "utf8" });
  const lines = out.split("\n").map((l) => l.trim().split(/\s+/));
  const goVersion = lines[0]?.[1] ?? "";
  const deps = lines.filter((l) => l[0] === "dep").map((l) => `${l[1]}@${l[2]}`);
  return { goVersion, deps: deps.sort() };
}

describe("What's inside? on real binaries", () => {
  const root = mkdtempSync(join(tmpdir(), "binlight-whats-inside-"));
  const providers: (string | undefined)[] = [];
  const jobs = new JobManager({
    recipes: [whatsInside],
    cache: new EvidenceCache(root),
    preflight: (path) => preflight(path),
    openSession: (path, deep) => {
      providers.push(deep?.providerId);
      return openReaSession(path, deep);
    },
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  for (const path of TARGETS) {
    it(`answers for ${path} in seconds, with no disassembler, matching go version -m`, async () => {
      const started = Date.now();
      const job = await jobs.settled(jobs.create({ recipe: "whats-inside", targets: [path] }).id);
      const elapsed = Date.now() - started;
      expect(job?.status, JSON.stringify(job?.steps.filter((s) => s.error))).toBe("done");
      // Warm: about 5 s (kubectl) and 4 s (Ollama). The first REA start of a
      // session can add about 5 s, so allow for it.
      expect(elapsed).toBeLessThan(15_000);
      expect(job?.steps.find((s) => s.id === "open")?.summary).toMatch(/no disassembler/);
      expect(job?.rules?.every((r) => r.status === "ran")).toBe(true);

      const findings = new Map((job?.findings ?? []).map((f) => [f.id, f]));
      const oracle = goVersionM(path);
      expect(findings.get("go:toolchain")?.data?.["goVersion"]).toBe(oracle.goVersion);
      const deps = (findings.get("go:dependencies")?.data?.["dependencies"] ?? []) as {
        path: string;
        version: string;
      }[];
      expect(deps.map((d) => `${d.path}@${d.version}`).sort()).toEqual(oracle.deps);

      expect(findings.get("macho:platform")?.statement).toMatch(/^It is built for macOS \d+/);
      expect(findings.get("signing")).toBeDefined();
      expect(job?.verdict?.rules.answer).toMatch(/^A Go \d+\.\d+/);
      const verdict = job?.verdict;
      expect(verdict).toBeDefined();
      if (verdict)
        expect(validateVerdict(verdict.rules, job?.findings ?? [])).toEqual({ ok: true });
    }, 60_000);
  }

  it("never asked for a disassembler", () => {
    expect(providers.every((p) => p === undefined)).toBe(true);
  });
});

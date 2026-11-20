import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Job } from "@binlight/shared";
import { describe, expect, it } from "vitest";
import { EvidenceCache } from "../cache/evidence.js";
import { JobManager } from "../jobs/manager.js";
import { preflight } from "../preflight/index.js";
import { openReaSession } from "../runner/index.js";
import { validateVerdict } from "../verdict/validate.js";
import { phoneHome } from "./phone-home.js";

// Live: "Does it phone home?" on kubectl and Ollama with the real REA and
// Ghidra (Docker on Apple Silicon), compared with hand-checked golden files in
// test/golden/phone-home. The first run analyses each binary (about 18 and 8
// min); later runs reuse ~/.binlight's evidence cache. Run with
// `npm run test:contract`; record new golden files (then check them by hand)
// with BINLIGHT_UPDATE_GOLDEN=1.

const goldenDir = fileURLToPath(new URL("../../test/golden/phone-home", import.meta.url));
const update = process.env["BINLIGHT_UPDATE_GOLDEN"] === "1";

/** The parts of a job that should not change between runs of the same binary. */
function golden(job: Job) {
  return {
    target: job.targets[0],
    sha256: job.preflights[0]?.analysisSha256,
    reaVersion: job.reaVersion,
    answer: job.verdict?.rules.answer,
    findings: (job.findings ?? []).map((f) => ({
      id: f.id,
      kind: f.kind,
      confidence: f.confidence,
      statement: f.statement,
    })),
    suppressed: (job.suppressed ?? []).map((s) => ({ text: s.text, reason: s.reason })),
    rules: (job.rules ?? []).map((r) => ({ id: r.id, status: r.status })),
  };
}

const jobs = new JobManager({
  recipes: [phoneHome],
  cache: new EvidenceCache(),
  preflight: (path) => preflight(path),
  openSession: (path, deep) => openReaSession(path, deep),
});

describe.each([
  ["kubectl", "/opt/homebrew/bin/kubectl"],
  ["ollama", "/opt/homebrew/bin/ollama"],
])("Does it phone home? on %s", (name, path) => {
  it(
    "matches the hand-checked golden file, and every claim is backed",
    async () => {
      const job = (await jobs.settled(
        jobs.create({ recipe: "phone-home", targets: [path] }).id,
      )) as Job;
      expect(job.status, JSON.stringify(job.steps.filter((s) => s.error))).toBe("done");
      expect(
        validateVerdict(job.verdict?.rules ?? { answer: "", claims: [] }, job.findings ?? []),
      ).toEqual({ ok: true });

      const file = join(goldenDir, `${name}.json`);
      const actual = golden(job);
      if (update) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
      }
      const expected = JSON.parse(readFileSync(file, "utf8")) as ReturnType<typeof golden>;
      if (actual.sha256 !== expected.sha256) {
        expect.fail(
          `${path} changed (sha256 ${actual.sha256}); re-record and re-check the golden file.`,
        );
      }
      expect(actual).toEqual(expected);
    },
    60 * 60_000,
  );
});

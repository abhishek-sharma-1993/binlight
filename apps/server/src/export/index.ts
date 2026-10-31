import { readFileSync } from "node:fs";
import type { Job } from "@binlight/shared";
import { buildExcerpts } from "./excerpt.js";
import { renderReport } from "./report.js";

export { buildExcerpts, citedEvidence, type EvidenceExcerpt } from "./excerpt.js";
export { renderReport, REPORT_BUDGET_BYTES, REPORT_CSP, text } from "./report.js";

/** Binlight's version, from the server package. */
export const BINLIGHT_VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/** The finished job as one self-contained HTML report. */
export async function exportReport(
  job: Job,
  result: (step: string) => Promise<unknown>,
  generatedAt = new Date(),
): Promise<string> {
  const excerpts = await buildExcerpts(job, result);
  return renderReport({ job, excerpts, binlightVersion: BINLIGHT_VERSION, generatedAt });
}

/** e.g. binlight-kubectl-raw-analysis-2026-10-31.html */
export function reportFileName(job: Job, generatedAt = new Date()): string {
  const names = job.targets.map((t) => t.split("/").pop() ?? "target").join("-vs-");
  const safe = `${names}-${job.recipe.id}`.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100);
  return `binlight-${safe}-${generatedAt.toISOString().slice(0, 10)}.html`;
}

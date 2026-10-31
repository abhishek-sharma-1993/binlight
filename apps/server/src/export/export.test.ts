import type { Finding, Job } from "@binlight/shared";
import { describe, expect, it } from "vitest";
import { deps, dockerRoute, evidence, fakeSession, report } from "../jobs/fakes.js";
import { JobManager } from "../jobs/manager.js";
import { ReaToolError } from "../rea/errors.js";
import { citedEvidence } from "./excerpt.js";
import {
  exportReport,
  renderReport,
  REPORT_BUDGET_BYTES,
  REPORT_CSP,
  reportFileName,
} from "./index.js";

const TOKEN = `ghp_${"Z".repeat(36)}`;
const HOSTILE = 'https://evil.example/"><script>alert(1)</script>';

async function finishedJob(handlers: Parameters<typeof fakeSession>[1] = {}) {
  const fake = fakeSession(dockerRoute, {
    list_strings: async () =>
      evidence("list_strings", [
        { address: "0x10", value: "docs at https://kubernetes.io/docs/reference" },
        { address: "0x20", value: HOSTILE },
        { address: "0x30", value: `token=${TOKEN} and more` },
      ]),
    ...handlers,
  });
  const jobs = new JobManager(deps(fake, report({ analysisSha256: "a".repeat(64) })));
  const job = (await jobs.settled(jobs.create({ targets: ["/apps/kubectl"] }).id)) as Job;
  return {
    jobs,
    job,
    html: await exportReport(job, (s) => jobs.result(job.id, s), new Date("2026-10-31T00:00:00Z")),
  };
}

describe("HTML export", () => {
  it("includes an excerpt of every cited evidence record, and every finding a verdict cites", async () => {
    const { job, html } = await finishedJob();
    const cited = [...citedEvidence(job.findings ?? []).keys()];
    expect(cited.length).toBeGreaterThan(0);
    for (const id of cited) expect(html).toContain(`id="evidence-${id}"`);
    for (const claim of job.verdict?.rules.claims ?? []) {
      for (const id of claim.findings) expect(html).toContain(`id="finding-${id}"`);
    }
  });

  it("loads nothing from anywhere: no scripts, styles, images or outbound links", async () => {
    const { html } = await finishedJob();
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`);
    expect(html).not.toMatch(/<script|<iframe|<img|<object|@import|url\(/i);
    // The only <link> is an empty inline icon, so a host isn't asked for /favicon.ico.
    expect([...html.matchAll(/<link[^>]*>/gi)].map((m) => m[0])).toEqual([
      '<link rel="icon" href="data:,">',
    ]);
    // Every reference stays inside the file.
    for (const m of html.matchAll(/\b(href|src|action)\s*=\s*"([^"]*)"/gi))
      expect(m[2]).toMatch(/^(#|data:)/);
  });

  it("escapes text from the binary", async () => {
    const { html } = await finishedJob();
    expect(html).toContain("evil.example");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&#60;script&#62;");
  });

  it("never contains a whole credential", async () => {
    const { html } = await finishedJob();
    expect(html).not.toContain(TOKEN);
    expect(html).toContain("ghp_ZZZZZZZZ…");
  });

  it("states what was analysed: hash, REA, Binlight and provider", async () => {
    const { html } = await finishedJob();
    expect(html).toContain("a".repeat(64));
    expect(html).toMatch(/Binlight \d+\.\d+\.\d+ · REA 6\.7\.0/);
    expect(html).toContain("docker-ghidra (provider ghidra)");
    expect(html).toContain("Only analyse software you own");
  });

  it("lists what was not checked, with the real reason", async () => {
    const { html } = await finishedJob({
      list_strings: async () => {
        throw new ReaToolError("list_strings", {
          code: "resource_constraint",
          message: "too big for stdio",
        });
      },
    });
    expect(html).toContain(
      "List the text it contains: failed (resource_constraint: too big for stdio)",
    );
    expect(html).toContain("not run");
  });

  it("says so when an evidence record cannot be read back", async () => {
    const { jobs, job } = await finishedJob();
    const html = await exportReport(job, async (s) =>
      s === "strings" ? undefined : jobs.result(job.id, s),
    );
    expect(html).toContain("could not be read back");
  });

  it("stays within the size budget, saying what it left out", async () => {
    const { job } = await finishedJob();
    const host = (i: number): Finding => ({
      id: `host:h${i}.example`,
      rule: "hardcoded-hosts",
      kind: "hardcoded-host",
      statement: `"h${i}.example" appears in a hard-coded URL.`,
      evidence: [
        {
          evidenceId: "ev_x",
          step: "strings",
          locator: { address: `0x${i}`, snippet: "x".repeat(72) },
        },
      ],
      confidence: "observed",
      caveats: ["A URL in the binary is not proof that it is contacted."],
    });
    const big: Job = { ...job, findings: Array.from({ length: 30_000 }, (_, i) => host(i)) };
    const html = renderReport({
      job: big,
      excerpts: [],
      binlightVersion: "0.0.0",
      generatedAt: new Date(),
    });
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(REPORT_BUDGET_BYTES);
    expect(html).toMatch(/\d+ more findings from this rule are left out/);
  });

  it("names the file after the target, recipe and date", async () => {
    const { job } = await finishedJob();
    expect(reportFileName(job, new Date("2026-10-31T12:00:00Z"))).toBe(
      "binlight-kubectl-raw-analysis-2026-10-31.html",
    );
  });
});

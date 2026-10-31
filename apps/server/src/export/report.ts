import type { Finding, Job, PreflightReport, VerdictBody } from "@binlight/shared";
import { CREDENTIAL_PATTERNS } from "../rules/credentials.js";
import { truncateSecret } from "../rules/text.js";
import type { EvidenceExcerpt } from "./excerpt.js";

export interface ReportInput {
  job: Job;
  excerpts: EvidenceExcerpt[];
  binlightVersion: string;
  generatedAt: Date;
}

/** About 2 MB; past it, findings per rule are capped (and the report says so). */
export const REPORT_BUDGET_BYTES = 2 * 1024 * 1024;
const CAPS = [Infinity, 200, 50, 10];

/** The report's own policy: nothing may load from anywhere, no scripts at all. */
export const REPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/**
 * Text from the analysed binary goes through here: credential-shaped values
 * are truncated (a last line of defence; rules already truncate), then HTML is
 * escaped.
 */
export function text(value: unknown): string {
  let s = String(value ?? "");
  for (const { pattern } of CREDENTIAL_PATTERNS) s = s.replace(pattern, (m) => truncateSecret(m));
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** One self-contained HTML file: no scripts, no external requests, opens offline. */
export function renderReport(input: ReportInput): string {
  for (const cap of CAPS) {
    const html = render(input, cap);
    if (Buffer.byteLength(html) <= REPORT_BUDGET_BYTES || cap === CAPS.at(-1)) return html;
  }
  throw new Error("unreachable");
}

function render({ job, excerpts, binlightVersion, generatedAt }: ReportInput, cap: number): string {
  const v = job.verdict;
  const shown: VerdictBody | undefined =
    v?.ai.status === "used" && v.ai.body ? v.ai.body : v?.rules;
  const multi = job.targets.length > 1;
  const findings = job.findings ?? [];
  const title = `${job.recipe.title}: ${job.targets.map((t) => t.split("/").pop()).join(" vs ")}`;

  const parts: string[] = [];
  parts.push(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:,">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Binlight ${text(binlightVersion)}">
<title>${text(title)} · Binlight</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
<p class="brand">Binlight report</p>
<h1>${text(job.recipe.title)}</h1>
<p class="question">${text(job.recipe.question)}</p>
<p class="muted small">Generated ${text(generatedAt.toISOString())} by Binlight ${text(binlightVersion)} · REA ${text(job.reaVersion ?? "not started")} · job ${text(job.id)} · status ${text(job.status)}</p>
</header>`);

  // Identity of what was analysed.
  parts.push(`<section><h2>What was analysed</h2>`);
  job.targets.forEach((target, i) => {
    const report = job.preflights[i] ?? null;
    parts.push(
      identity(target, report, multi ? job.recipe.targetLabels[i] : undefined, excerpts, i, job),
    );
  });
  parts.push(`</section>`);

  // The verdict.
  if (v && shown) {
    const source =
      v.ai.status === "used"
        ? `Written by Claude (${text(v.ai.model ?? "")}) from the findings and checked by Binlight: every claim cites findings and states no number they don't contain. Binlight's rule-based version follows.`
        : `Binlight's rule-based verdict, built from the findings alone.${v.ai.reason ? ` ${text(v.ai.reason)}` : ""}`;
    parts.push(`<section class="verdict"><h2>Verdict <span class="badge ${text(v.confidence)}">${text(v.confidence)} confidence</span></h2>
<p class="answer">${text(shown.answer)}</p>
${claims(shown)}
<p class="small muted">${text(v.confidenceReason)}</p>
<p class="small muted">${source}</p>
${v.ai.status === "used" ? `<details><summary>Rule-based version</summary><p>${text(v.rules.answer)}</p>${claims(v.rules)}</details>` : ""}
</section>`);
  } else {
    parts.push(
      `<section class="verdict"><h2>Verdict</h2><p class="muted">This job has no verdict (its recipe has none, or it did not reach that point).</p></section>`,
    );
  }

  // What was not analysed.
  const gaps = v?.gaps ?? [];
  const limits = job.preflights.flatMap((p, i) =>
    (p?.issues ?? [])
      .filter((x) => x.severity !== "note")
      .map(
        (x) =>
          `${multi ? `${job.recipe.targetLabels[i]}: ` : ""}${x.message}${x.remediation ? ` (Fix: ${x.remediation})` : ""}`,
      ),
  );
  const failedSteps = job.steps
    .filter((s) => !s.why && (s.status === "failed" || s.status === "cancelled"))
    .map(
      (s) => `${s.label}: ${s.status}${s.error ? ` (${s.error.code}: ${s.error.message})` : ""}`,
    );
  const notChecked = [...gaps, ...limits, ...failedSteps];
  parts.push(
    `<section><h2>Not checked</h2>${
      notChecked.length === 0
        ? `<p class="muted">Every step and rule of the recipe ran.</p>`
        : `<ul>${notChecked.map((g) => `<li>${text(g)}</li>`).join("")}</ul>`
    }</section>`,
  );

  // Findings, by rule.
  parts.push(`<section><h2>Findings</h2>`);
  for (const rule of job.rules ?? []) {
    const own = findings
      .filter((f) => f.rule === rule.id)
      .sort((a, b) => Number(b.kind.endsWith("-summary")) - Number(a.kind.endsWith("-summary")));
    parts.push(
      `<h3>${text(rule.title)} <span class="muted small">${rule.status === "ran" ? `${own.length} ${own.length === 1 ? "finding" : "findings"}` : rule.status === "failed" ? "failed" : "not run"}</span></h3>`,
    );
    if (rule.status !== "ran")
      parts.push(
        `<p class="${rule.status === "failed" ? "error" : "muted"}">${text(rule.reason ?? "")}</p>`,
      );
    parts.push(
      `<ul class="findings">${own
        .slice(0, cap)
        .map((f) => finding(f, multi ? job.recipe.targetLabels : undefined))
        .join("")}</ul>`,
    );
    if (own.length > cap) {
      parts.push(
        `<p class="muted small">${own.length - cap} more findings from this rule are left out to keep this file under ${REPORT_BUDGET_BYTES / 1024 / 1024} MB; Binlight shows them all.</p>`,
      );
    }
  }
  if ((job.suppressed?.length ?? 0) > 0) {
    parts.push(
      `<h3>Ignored as known false alarms</h3><ul>${(job.suppressed ?? []).map((s) => `<li><code>${text(s.text)}</code>: ${text(s.reason)} <span class="muted small">(${text(s.evidence.evidenceId)})</span></li>`).join("")}</ul>`,
    );
  }
  parts.push(`</section>`);

  // Evidence appendix.
  parts.push(
    `<section><h2>Evidence</h2><p class="small muted">Excerpts of the REA evidence records the findings cite. String values appear only as short snippets around what was cited.</p>`,
  );
  for (const e of excerpts) parts.push(excerpt(e));
  parts.push(`</section>`);

  parts.push(`<footer><p>Static observations from REA evidence, not proof of what the program does when it runs. Only analyse software you own, open-source software, or software you are authorised to inspect.</p>
<p class="muted small">Binlight is an independent project, not affiliated with REA, Ghidra or Anthropic.</p></footer>
</main>
</body>
</html>
`);
  return parts.join("\n");
}

function identity(
  target: string,
  report: PreflightReport | null,
  label: string | undefined,
  excerpts: EvidenceExcerpt[],
  index: number,
  job: Job,
): string {
  const providers = [
    ...new Set(
      excerpts
        .filter((e) => job.steps.find((s) => s.id === e.step)?.target === index && e.provider?.name)
        .map(
          (e) => `${e.provider?.name ?? ""}${e.provider?.version ? ` ${e.provider.version}` : ""}`,
        ),
    ),
  ];
  const rows: [string, string][] = [
    ["Path", target],
    [
      "Format",
      report
        ? `${report.target.format} [${report.target.architectures.join(", ")}]`
        : "not checked",
    ],
    [
      "Analysed file",
      report?.analysisPath
        ? `${report.analysisPath} (${report.analysisArchitecture ?? "?"})`
        : "none",
    ],
    ["SHA-256 of analysed bytes", report?.analysisSha256 ?? "unknown"],
    [
      "Deep-analysis route",
      report?.deep ? `${report.deep.route} (provider ${report.deep.providerId})` : "none",
    ],
    ["Evidence from", providers.length > 0 ? providers.join("; ") : "no evidence records"],
  ];
  return `${label ? `<h3>${text(label)}</h3>` : ""}<dl>${rows.map(([k, val]) => `<dt>${text(k)}</dt><dd>${text(val)}</dd>`).join("")}</dl>`;
}

function claims(body: VerdictBody): string {
  return `<ul class="claims">${body.claims
    .map(
      (c) =>
        `<li>${text(c.text)} ${c.findings.map((id) => `<a class="cite" href="#finding-${text(id)}">[${text(id)}]</a>`).join(" ")}</li>`,
    )
    .join("")}</ul>`;
}

function finding(f: Finding, labels: string[] | undefined): string {
  const evidence = f.evidence
    .map((e) => {
      const where = [
        e.locator?.address && `at ${e.locator.address}`,
        e.locator?.field && `field ${e.locator.field}`,
      ]
        .filter(Boolean)
        .join(", ");
      return `<li><a href="#evidence-${text(e.evidenceId)}"><code>${text(e.evidenceId)}</code></a> ${text(where)}${e.locator?.snippet ? `<pre>${text(e.locator.snippet)}</pre>` : ""}</li>`;
    })
    .join("");
  return `<li id="finding-${text(f.id)}"><p>${labels && f.target !== undefined ? `<span class="muted">${text(labels[f.target])}: </span>` : ""}${text(f.statement)} <span class="badge ${text(f.confidence)}">${text(f.confidence)}</span></p>
${f.caveats.length > 0 ? `<ul class="caveats">${f.caveats.map((c) => `<li>${text(c)}</li>`).join("")}</ul>` : ""}
<details><summary>Evidence (${f.evidence.length})</summary><ul>${evidence}</ul></details></li>`;
}

function excerpt(e: EvidenceExcerpt): string {
  const head = `<h3 id="evidence-${text(e.evidenceId)}"><code>${text(e.evidenceId)}</code></h3>`;
  if (e.missing) return `${head}<p class="error">${text(e.missing)}</p>`;
  const rows: [string, string][] = [
    ["Step", e.step],
    ["Operation", e.operation ?? ""],
    ["Provider", `${e.provider?.name ?? ""}${e.provider?.version ? ` ${e.provider.version}` : ""}`],
    [
      "Subject",
      e.subject
        ? `${e.subject.name ?? ""} (${e.subject.format ?? ""}, ${e.subject.architecture ?? "?"}), SHA-256 ${e.subject.sha256 ?? ""}`
        : "",
    ],
    ["Confidence", e.confidence ?? ""],
    ...(e.size ? ([["Size", e.size]] as [string, string][]) : []),
  ];
  return `${head}<dl>${rows.map(([k, val]) => `<dt>${text(k)}</dt><dd>${text(val)}</dd>`).join("")}</dl>
${e.cited.length > 0 ? `<ul class="cited">${e.cited.map((c) => `<li>${c.address ? `<code>${text(c.address)}</code>` : `<code>${text(c.field)}</code>`}${c.snippet ? `<pre>${text(c.snippet)}</pre>` : ""}${c.value ? `<pre>${text(c.value)}</pre>` : ""}</li>`).join("")}</ul>` : ""}
${e.limitations.length > 0 ? `<details><summary>REA's limitations for this record (${e.limitations.length})</summary><ul>${e.limitations.map((l) => `<li>${text(l)}</li>`).join("")}</ul></details>` : ""}`;
}

const STYLE = `
:root{--bg:#fff;--panel:#f6f7f9;--border:#d9dde3;--text:#1c1f23;--muted:#5f6772;--ok:#1f7a3f;--warn:#8a5a00;--bad:#a11b1b;--accent:#2856d6;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#15171b;--panel:#1d2026;--border:#2f343c;--text:#e6e8eb;--muted:#9aa3ad;--ok:#5cc884;--warn:#e0b04a;--bad:#ff9a9a;--accent:#7a9cff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:900px;margin:0 auto;padding:24px 16px 48px}h1{margin:4px 0;font-size:24px}h2{font-size:18px;margin:28px 0 8px;border-bottom:1px solid var(--border);padding-bottom:4px}h3{font-size:15px;margin:16px 0 4px}
.brand{color:var(--accent);font-weight:700;margin:0}.question{font-style:italic;margin:0 0 6px}.muted{color:var(--muted)}.small{font-size:13px}.error{color:var(--bad)}
.verdict{background:var(--panel);border:2px solid var(--border);border-radius:10px;padding:4px 16px 12px}.verdict h2{border:0}.answer{font-size:17px}
.badge{font-size:12px;font-weight:400;border:1px solid currentColor;border-radius:999px;padding:0 7px;white-space:nowrap}.high,.observed{color:var(--ok)}.medium,.inferred{color:var(--warn)}.low{color:var(--bad)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 14px;margin:6px 0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
code,pre{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12.5px;overflow-wrap:anywhere}pre{white-space:pre-wrap;background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:6px 8px;margin:4px 0}
ul.findings{list-style:none;padding:0}ul.findings>li{border-bottom:1px dashed var(--border);padding:6px 0}ul.findings p{margin:0}ul.caveats{margin:2px 0;color:var(--muted);font-size:13px}
a{color:var(--accent)}a.cite{text-decoration:none;font-size:13px;overflow-wrap:anywhere}li:target,h3:target{outline:2px solid var(--accent)}
footer{margin-top:36px;border-top:1px solid var(--border);font-size:13px}
`;

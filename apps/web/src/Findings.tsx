import type { Finding, Job } from "@binlight/shared";
import { useState } from "react";
import { groupFindings } from "./findingGroups.js";

const SHOWN_PER_GROUP = 15;

/** The recipe's findings, grouped by rule, with what could not be looked at. */
export function Findings({ job }: { job: Job }) {
  if (!job.rules) {
    return (
      <section className="card">
        <h3>Findings</h3>
        <p className="muted small">Findings appear when the analysis steps have finished.</p>
      </section>
    );
  }
  const groups = groupFindings(job.rules, job.findings ?? []);
  return (
    <section className="card findings">
      <h3>Findings</h3>
      {groups.map((g) => (
        <RuleGroup
          key={g.rule.id}
          group={g}
          targetLabels={job.recipe.targetLabels}
          multi={job.targets.length > 1}
        />
      ))}
      {(job.suppressed?.length ?? 0) > 0 && (
        <div className="suppressed">
          <h4>Ignored as known false alarms</h4>
          <ul>
            {job.suppressed?.map((s, i) => (
              <li key={i} className="small">
                <code>{s.text}</code>: {s.reason}{" "}
                <span className="muted">
                  ({s.evidence.evidenceId.slice(0, 15)}…
                  {s.evidence.locator?.address ? ` at ${s.evidence.locator.address}` : ""})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function RuleGroup({
  group,
  targetLabels,
  multi,
}: {
  group: ReturnType<typeof groupFindings>[number];
  targetLabels: string[];
  multi: boolean;
}) {
  const { rule, findings } = group;
  // Open the whole group when a verdict citation points at a hidden finding.
  const [all, setAll] = useState(() =>
    findings.slice(SHOWN_PER_GROUP).some((f) => window.location.hash === `#finding-${f.id}`),
  );
  const shown = all ? findings : findings.slice(0, SHOWN_PER_GROUP);
  return (
    <div className="rule-group">
      <h4>
        {rule.title}{" "}
        {rule.status === "ran" && (
          <span className="muted small">
            {rule.findings} {rule.findings === 1 ? "finding" : "findings"}
          </span>
        )}
      </h4>
      {rule.status === "not-run" && <p className="muted">Not run: {rule.reason}</p>}
      {rule.status === "failed" && (
        <p className="error" role="alert">
          This rule failed: {rule.reason}
        </p>
      )}
      <ul className="finding-list">
        {shown.map((f) => (
          <FindingRow
            key={f.id}
            finding={f}
            {...(multi && f.target !== undefined && { target: targetLabels[f.target] })}
          />
        ))}
      </ul>
      {findings.length > shown.length && (
        <button type="button" className="link small" onClick={() => setAll(true)}>
          Show all {findings.length}
        </button>
      )}
    </div>
  );
}

function FindingRow({ finding, target }: { finding: Finding; target?: string | undefined }) {
  const deps = finding.data?.["dependencies"];
  return (
    <li className="finding" id={`finding-${finding.id}`}>
      <p>
        {target && <span className="muted small">{target}: </span>}
        {finding.statement}{" "}
        <span
          className={`badge ${finding.confidence}`}
          title={
            finding.confidence === "observed"
              ? "Read directly from the evidence"
              : "Concluded by a rule from the evidence"
          }
        >
          {finding.confidence}
        </span>
      </p>
      {finding.caveats.length > 0 && (
        <ul className="caveats">
          {finding.caveats.map((c, i) => (
            <li key={i} className="small muted">
              {c}
            </li>
          ))}
        </ul>
      )}
      <details className="small">
        <summary>Evidence ({finding.evidence.length})</summary>
        <ul className="evidence">
          {finding.evidence.map((e, i) => (
            <li key={i}>
              <code>{e.evidenceId}</code> from step <code>{e.step}</code>
              {e.locator?.address && (
                <>
                  {" "}
                  at <code>{e.locator.address}</code>
                </>
              )}
              {e.locator?.field && (
                <>
                  {" "}
                  field <code>{e.locator.field}</code>
                </>
              )}
              {e.locator?.snippet && <pre className="snippet">{e.locator.snippet}</pre>}
            </li>
          ))}
        </ul>
      </details>
      {Array.isArray(deps) && deps.length > 0 && (
        <details className="small">
          <summary>Dependencies ({deps.length})</summary>
          <ul className="deps">
            {(deps as { path: string; version: string; replaced?: boolean }[]).map((d) => (
              <li key={d.path}>
                <code>{d.path}</code> {d.version}
                {d.replaced && <span className="muted"> (replaced)</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

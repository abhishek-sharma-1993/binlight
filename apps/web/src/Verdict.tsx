import type { Verdict as VerdictData, VerdictBody } from "@binlight/shared";
import { useState } from "react";
import { verdictView } from "./verdictView.js";

/** The job's answer: the verdict, its confidence, what it rests on, and what it couldn't check. */
export function Verdict({ verdict }: { verdict: VerdictData }) {
  const [showRules, setShowRules] = useState(false);
  const view = verdictView(verdict);
  const body: VerdictBody = showRules ? verdict.rules : view.body;
  return (
    <section className="card verdict" aria-label="Verdict">
      <div className="verdict-head">
        <h3>Verdict</h3>
        <span className={`badge confidence-${verdict.confidence}`} title={verdict.confidenceReason}>
          {verdict.confidence} confidence
        </span>
      </div>
      <p className="answer">{body.answer}</p>
      <ul className="claims">
        {body.claims.map((c, i) => (
          <li key={i}>
            {c.text}{" "}
            {c.findings.map((id) => (
              <a key={id} className="cite small" href={`#finding-${id}`}>
                [{id}]
              </a>
            ))}
          </li>
        ))}
      </ul>
      <p className="small muted">{verdict.confidenceReason}</p>
      {verdict.gaps.length > 0 && (
        <div className="gaps">
          <h4>Not checked</h4>
          <ul>
            {verdict.gaps.map((g, i) => (
              <li key={i} className="small">
                {g}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className={`small ai-status ${verdict.ai.status}`} role={view.alert ? "alert" : undefined}>
        {view.status}
      </p>
      {verdict.ai.status === "used" && (
        <button type="button" className="link small" onClick={() => setShowRules((v) => !v)}>
          {showRules ? "Show Claude's version" : "Show the rule-based version"}
        </button>
      )}
    </section>
  );
}

import type { Verdict as VerdictData, VerdictBody } from "@binlight/shared";
import { useState } from "react";
import { answerConsent } from "./api.js";
import { verdictView } from "./verdictView.js";

/** The job's answer: the verdict, its confidence, what it rests on, and what it couldn't check. */
export function Verdict({ jobId, verdict }: { jobId: string; verdict: VerdictData }) {
  const [showRules, setShowRules] = useState(false);
  const [consentError, setConsentError] = useState<string | undefined>();
  const preview = verdict.ai.status === "awaiting-consent" ? verdict.ai.preview : undefined;
  const answer = (send: boolean) =>
    void answerConsent(jobId, send).catch((err: unknown) =>
      setConsentError(err instanceof Error ? err.message : String(err)),
    );
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
      {preview && (
        <div className="consent">
          <h4>Send to Claude?</h4>
          <p className="small">
            This is exactly what Binlight would send to {preview.model} (
            {preview.characters.toLocaleString("en-US")} characters): the findings' statements and
            caveats, no snippets, strings or binary.
          </p>
          <details className="small">
            <summary>Instructions (system prompt)</summary>
            <pre className="json">{preview.system}</pre>
          </details>
          <details className="small" open>
            <summary>Findings sent</summary>
            <pre className="json">{JSON.stringify(JSON.parse(preview.request), null, 2)}</pre>
          </details>
          <div className="consent-actions">
            <button type="button" onClick={() => answer(true)}>
              Send to Claude
            </button>
            <button type="button" className="secondary" onClick={() => answer(false)}>
              Keep the rule-based verdict
            </button>
          </div>
          {consentError && <p className="error">{consentError}</p>}
        </div>
      )}
      {verdict.ai.status === "used" && (
        <button type="button" className="link small" onClick={() => setShowRules((v) => !v)}>
          {showRules ? "Show Claude's version" : "Show the rule-based version"}
        </button>
      )}
    </section>
  );
}

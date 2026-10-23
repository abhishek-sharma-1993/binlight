import type { JobStep, PreflightReport } from "@binlight/shared";
import { useEffect, useReducer, useState } from "react";
import { cancelJob, stepResult, watchJob } from "./api.js";
import { formatDuration, JOB_STATUS_TEXT, STATUS_ICON, stepDetail, stepElapsed } from "./format.js";
import { applyEvent } from "./jobState.js";

const RESULT_PREVIEW_CHARS = 200_000;

export function JobView({ jobId }: { jobId: string }) {
  const [view, dispatch] = useReducer(applyEvent, { logs: [] });
  const [connected, setConnected] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [cancelError, setCancelError] = useState<string | undefined>();
  const job = view.job;
  const active = job?.status === "running" || job?.status === "queued";

  useEffect(() => watchJob(jobId, dispatch, setConnected), [jobId]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);

  if (!job) {
    return (
      <p className="muted">{connected ? "Connecting…" : "Cannot reach the server; retrying…"}</p>
    );
  }

  const total = job.startedAt
    ? (job.endedAt ? Date.parse(job.endedAt) : now) - Date.parse(job.startedAt)
    : undefined;

  return (
    <div className="job-view">
      <div className="job-head">
        <div>
          <h2 className="target-path">{job.target}</h2>
          <p className="muted small">
            Job {job.id} · REA {job.reaVersion ?? "not started"}
            {job.fresh ? " · cache ignored" : ""}
          </p>
        </div>
        <div className="job-actions">
          <span className={`badge ${job.status}`}>{JOB_STATUS_TEXT[job.status]}</span>
          {total !== undefined && <span className="muted">{formatDuration(total)}</span>}
          <span className={connected ? "live" : "offline"}>
            {connected ? "live" : "reconnecting"}
          </span>
          {active && (
            <button
              type="button"
              className="danger"
              onClick={() =>
                void cancelJob(job.id).catch((err: unknown) =>
                  setCancelError(err instanceof Error ? err.message : String(err)),
                )
              }
            >
              Cancel
            </button>
          )}
        </div>
      </div>
      {cancelError && <p className="error">Cancel failed: {cancelError}</p>}

      <ol className="steps">
        {job.steps.map((step) => (
          <StepRow key={step.id} jobId={job.id} step={step} now={now} />
        ))}
      </ol>

      {job.preflight && <Preflight report={job.preflight} />}

      <section className="card">
        <h3>REA log</h3>
        {view.logs.length === 0 ? (
          <p className="muted small">No log lines yet (lines appear while REA runs).</p>
        ) : (
          <pre className="log">{view.logs.join("\n")}</pre>
        )}
      </section>
    </div>
  );
}

function StepRow({ jobId, step, now }: { jobId: string; step: JobStep; now: number }) {
  const detail = stepDetail(step);
  const elapsed = stepElapsed(step, now);
  return (
    <li className={`step ${step.status}`}>
      <span className="icon" aria-hidden>
        {STATUS_ICON[step.status]}
      </span>
      <div className="step-body">
        <div className="step-title">
          <strong>{step.label}</strong>
          {step.tool && <code className="small">{step.tool}</code>}
          {step.cached && (
            <span className="badge cached" title={`First produced ${step.cachedAt ?? ""}`}>
              cached
            </span>
          )}
          <span className="muted small">
            {elapsed !== undefined ? formatDuration(elapsed) : ""}
          </span>
        </div>
        {detail.kind === "summary" && <p>{detail.text}</p>}
        {detail.kind === "status" && <p className="muted">{detail.text}</p>}
        {detail.kind === "skipped" && <p className="muted">Skipped: {detail.reason}</p>}
        {detail.kind === "error" && (
          <div className="error" role="alert">
            <p>
              <code>{detail.code}</code> {detail.message}
            </p>
            {detail.remediation && <p className="small">Fix: {detail.remediation}</p>}
          </div>
        )}
        {step.evidenceId && (
          <p className="muted small">
            Evidence <code>{step.evidenceId}</code>
          </p>
        )}
        {step.hasResult && <ResultViewer jobId={jobId} step={step} />}
      </div>
    </li>
  );
}

function ResultViewer({ jobId, step }: { jobId: string; step: JobStep }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const url = `/api/jobs/${jobId}/steps/${step.id}/result`;

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && text === undefined) {
      try {
        setText(JSON.stringify(await stepResult(jobId, step.id), null, 2));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  return (
    <div className="result">
      <button type="button" className="link small" onClick={() => void toggle()}>
        {open ? "Hide raw result" : "Show raw result"}
      </button>{" "}
      <a className="small" href={url} target="_blank" rel="noreferrer">
        open JSON
      </a>
      {open && error && <p className="error">Could not load the result: {error}</p>}
      {open && !error && text === undefined && <p className="muted small">Loading…</p>}
      {open && text !== undefined && (
        <>
          {text.length > RESULT_PREVIEW_CHARS && (
            <p className="muted small">
              Showing the first {Math.round(RESULT_PREVIEW_CHARS / 1000)} KB of{" "}
              {Math.round(text.length / 1000)} KB; open the JSON for all of it.
            </p>
          )}
          <pre className="json">{text.slice(0, RESULT_PREVIEW_CHARS)}</pre>
        </>
      )}
    </div>
  );
}

function Preflight({ report }: { report: PreflightReport }) {
  const t = report.target;
  return (
    <section className="card">
      <h3>Preflight</h3>
      <dl className="facts">
        <dt>Format</dt>
        <dd>
          {t.format} [{t.architectures.join(", ") || "none"}]
        </dd>
        {t.executable && (
          <>
            <dt>Executable</dt>
            <dd>{t.executable.path}</dd>
          </>
        )}
        {report.analysisPath && (
          <>
            <dt>Analysed file</dt>
            <dd>
              {report.analysisPath} ({report.analysisArchitecture ?? "?"})
            </dd>
          </>
        )}
        {report.analysisSha256 && (
          <>
            <dt>SHA-256</dt>
            <dd>
              <code className="small">{report.analysisSha256}</code>
            </dd>
          </>
        )}
      </dl>
      {report.routes.length > 0 && (
        <table className="routes">
          <thead>
            <tr>
              <th>Deep-analysis route</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {report.routes.map((r) => (
              <tr key={r.route}>
                <td>
                  {r.route}
                  {report.deep?.route === r.route && " (chosen)"}
                </td>
                <td>
                  {r.available ? "available" : r.reason}
                  {!r.available && r.remediation && (
                    <div className="small muted">Fix: {r.remediation}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {report.issues.length > 0 && (
        <ul className="issues">
          {report.issues.map((i) => (
            <li key={i.code} className={i.severity}>
              <strong>{i.severity}</strong> <code>{i.code}</code> {i.message}
              {i.remediation && <div className="small">Fix: {i.remediation}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

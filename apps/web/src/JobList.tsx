import type { Job } from "@binlight/shared";
import { useEffect, useState } from "react";
import { listJobs } from "./api.js";
import { JOB_STATUS_TEXT } from "./format.js";

const REFRESH_MS = 5_000;

export function JobList({
  selected,
  onSelect,
  version,
}: {
  selected: string | undefined;
  onSelect: (id: string) => void;
  version: number;
}) {
  const [jobs, setJobs] = useState<Job[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let alive = true;
    const load = () =>
      listJobs().then(
        (list) => {
          if (!alive) return;
          setJobs(list);
          setError(undefined);
        },
        (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)),
      );
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [version]);

  return (
    <section className="card">
      <h2>Jobs</h2>
      {error && <p className="error">Could not load jobs: {error}</p>}
      {jobs === undefined && !error && <p className="muted">Loading…</p>}
      {jobs?.length === 0 && <p className="muted">No jobs yet.</p>}
      <ul className="jobs">
        {jobs?.map((job) => (
          <li key={job.id}>
            <button
              type="button"
              className={job.id === selected ? "job selected" : "job"}
              onClick={() => onSelect(job.id)}
            >
              <span className={`badge ${job.status}`}>{JOB_STATUS_TEXT[job.status]}</span>
              <span className="target" title={job.target}>
                {job.target.split("/").pop()}
              </span>
              <span className="muted small">{new Date(job.createdAt).toLocaleTimeString()}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

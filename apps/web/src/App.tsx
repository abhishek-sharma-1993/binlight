import { useCallback, useEffect, useState } from "react";
import { JobList } from "./JobList.js";
import { JobView } from "./JobView.js";
import { NewJobForm } from "./NewJobForm.js";

/** The selected job lives in the URL (?job=…), so a reload reconnects to it. */
function jobFromUrl(): string | undefined {
  return new URLSearchParams(window.location.search).get("job") ?? undefined;
}

export function App() {
  const [jobId, setJobId] = useState<string | undefined>(jobFromUrl);
  const [listVersion, setListVersion] = useState(0);

  useEffect(() => {
    const onPop = () => setJobId(jobFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const select = useCallback((id: string | undefined) => {
    const url = id ? `?job=${encodeURIComponent(id)}` : window.location.pathname;
    window.history.pushState(null, "", url);
    setJobId(id);
  }, []);

  return (
    <div className="layout">
      <header>
        <h1>
          <button type="button" className="link" onClick={() => select(undefined)}>
            Binlight
          </button>
        </h1>
        <span className="muted">Phase 0: raw results</span>
      </header>
      <aside>
        <NewJobForm
          onCreated={(id) => {
            setListVersion((v) => v + 1);
            select(id);
          }}
        />
        <JobList selected={jobId} onSelect={select} version={listVersion} />
      </aside>
      <main>
        {jobId ? (
          <JobView key={jobId} jobId={jobId} />
        ) : (
          <p className="muted">Start a job, or pick one from the list.</p>
        )}
      </main>
    </div>
  );
}

import type { Job, JobEvent } from "@binlight/shared";

export interface JobView {
  job?: Job;
  /** REA's log lines, newest last. */
  logs: string[];
  /** Server time of the last heartbeat, to show the stream is alive. */
  lastBeat?: string;
}

export const MAX_LOG_LINES = 300;

/** Applies one server event. A snapshot replaces everything, so reconnects can't drift. */
export function applyEvent(view: JobView, event: JobEvent): JobView {
  switch (event.type) {
    case "snapshot":
      return { ...view, job: event.job };
    case "job":
      if (!view.job) return view;
      return {
        ...view,
        job: {
          ...view.job,
          status: event.status,
          ...(event.startedAt && { startedAt: event.startedAt }),
          ...(event.endedAt && { endedAt: event.endedAt }),
          ...(event.reaVersion && { reaVersion: event.reaVersion }),
        },
      };
    case "step":
      if (!view.job) return view;
      return {
        ...view,
        job: {
          ...view.job,
          steps: view.job.steps.map((s) => (s.id === event.step.id ? event.step : s)),
        },
      };
    case "heartbeat":
      return { ...view, lastBeat: event.at };
    case "log":
      return { ...view, logs: [...view.logs, event.line].slice(-MAX_LOG_LINES) };
  }
}

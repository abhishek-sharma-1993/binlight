import type { JobStep, JobStatus } from "@binlight/shared";

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(1)} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min ${rest} s`;
}

/** Elapsed time for a step: final when it ended, ticking from `now` while it runs. */
export function stepElapsed(step: JobStep, now: number): number | undefined {
  if (step.elapsedMs !== undefined) return step.elapsedMs;
  if (step.status === "running" && step.startedAt) return now - Date.parse(step.startedAt);
  return undefined;
}

export const STATUS_ICON: Record<JobStep["status"], string> = {
  pending: "○",
  running: "◐",
  done: "●",
  failed: "✕",
  skipped: "–",
  cancelled: "⊘",
};

export const JOB_STATUS_TEXT: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export type StepDetail =
  | { kind: "summary"; text: string; counts?: Record<string, number> }
  | { kind: "error"; code: string; message: string; remediation?: string }
  | { kind: "skipped"; reason: string }
  | { kind: "status"; text: string };

/**
 * What a step row says. A failed step shows its real error and never counts;
 * a skipped step always says why; nothing is ever blank.
 */
export function stepDetail(step: JobStep): StepDetail {
  switch (step.status) {
    case "done":
      return {
        kind: "summary",
        text: step.summary ?? "Done.",
        ...(step.counts && { counts: step.counts }),
      };
    case "failed":
      return {
        kind: "error",
        code: step.error?.code ?? "unknown_error",
        message: step.error?.message ?? "This step failed and the server gave no reason.",
        ...(step.error?.remediation && { remediation: step.error.remediation }),
      };
    case "skipped":
      return { kind: "skipped", reason: step.reason ?? "Skipped (no reason given)." };
    case "running":
      return { kind: "status", text: "Running…" };
    case "pending":
      return { kind: "status", text: "Waiting" };
    case "cancelled":
      return { kind: "status", text: "Cancelled" };
  }
}

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

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "about 16 min" style, rounded to what a person would say. */
export function about(ms: number): string {
  if (ms < 60_000) return `about ${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return `about ${Math.round(ms / 60_000)} min`;
  const h = ms / 3_600_000;
  return `about ${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
}

/** Expectations shorter than this are not shown. */
export const MIN_EXPECTATION_MS = 3_000;

/** Past this share of the expected time, a running step says it is taking longer. */
export const OVERRUN = 1.5;

/**
 * The expectation line for a step, from this machine's history. Never claims
 * more than the history shows: a size-scaled figure says it is an estimate.
 */
export function expectationText(step: JobStep, now: number): string | undefined {
  const e = step.expected;
  // Steps that take a moment need no expectation; it would only be noise.
  if (!e || e.ms < MIN_EXPECTATION_MS) return undefined;
  const basis =
    e.basis === "same-binary"
      ? `it took ${formatDuration(e.ms)} last time${e.lastAt ? `, ${shortDate(e.lastAt)}` : ""}`
      : `estimated by size from ${e.samples} earlier ${e.samples === 1 ? "analysis" : "analyses"} on this machine`;
  if (step.status === "running") {
    const elapsed = stepElapsed(step, now) ?? 0;
    return elapsed > e.ms * OVERRUN
      ? `Taking longer than expected (${about(e.ms)}: ${basis}).`
      : `Expected ${about(e.ms)} (${basis}).`;
  }
  if (step.status === "done") return `Expected ${about(e.ms)} (${basis}).`;
  return undefined;
}

/** How far through its expected time a running step is, 0..0.99 (never shows "done" early). */
export function expectedProgress(step: JobStep, now: number): number | undefined {
  if (step.status !== "running" || !step.expected || step.expected.ms < MIN_EXPECTATION_MS) {
    return undefined;
  }
  const elapsed = stepElapsed(step, now) ?? 0;
  return Math.min(0.99, elapsed / Math.max(1, step.expected.ms));
}

/** "Reused from the analysis on 23 Oct (no REA call)" for a cached step. */
export function cacheText(step: JobStep): string | undefined {
  if (!step.cached) return undefined;
  return `Reused from the analysis on ${step.cachedAt ? shortDate(step.cachedAt) : "an earlier date"} (no REA call).`;
}

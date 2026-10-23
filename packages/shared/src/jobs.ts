import type { PreflightReport } from "./preflight.js";

/** The fixed steps of a phase 0 analysis job, in run order. */
export const JOB_STEPS = [
  { id: "preflight", label: "Check the target and this machine" },
  { id: "start", label: "Start REA" },
  { id: "open", label: "Open the binary" },
  { id: "go", label: "Read Go build info" },
  { id: "overview", label: "Analyse (overview)" },
  { id: "strings", label: "List strings" },
  { id: "procedures", label: "List procedures" },
  { id: "close", label: "Close the binary" },
] as const;

export type StepId = (typeof JOB_STEPS)[number]["id"];

/**
 * "skipped" always carries a reason (e.g. no deep-analysis route); a failed
 * step always carries the real error. Neither ever shows a count.
 */
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "cancelled";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface StepError {
  /** REA's error code, or a Binlight code such as `rea_exited`. */
  code: string;
  message: string;
  remediation?: string;
}

export interface JobStep {
  id: StepId;
  label: string;
  /** The REA tool this step calls, if any. */
  tool?: string;
  status: StepStatus;
  startedAt?: string;
  endedAt?: string;
  elapsedMs?: number;
  /** One line for the feed, only for a step that succeeded. */
  summary?: string;
  /** Counts the step produced (only when it succeeded). */
  counts?: Record<string, number>;
  /** REA evidence id for the step's result. */
  evidenceId?: string;
  /** Why the step was skipped. */
  reason?: string;
  error?: StepError;
  /** Whether a full result can be fetched from /api/jobs/:id/steps/:step/result. */
  hasResult?: boolean;
  /** The result came from the evidence cache instead of a new REA call. */
  cached?: boolean;
  /** When the cached result was first produced. */
  cachedAt?: string;
}

export interface Job {
  id: string;
  /** The path the user asked to analyse. */
  target: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  preflight?: PreflightReport;
  steps: JobStep[];
  /** REA version that ran the job (or produced its cached results). */
  reaVersion?: string;
  /** Ignore the evidence cache and analyse again. */
  fresh?: boolean;
}

/** Server-Sent Events from /api/jobs/:id/events. Every connection starts with a snapshot. */
export type JobEvent =
  | { type: "snapshot"; job: Job }
  | { type: "job"; status: JobStatus; startedAt?: string; endedAt?: string; reaVersion?: string }
  | { type: "step"; step: JobStep }
  | { type: "heartbeat"; at: string; runningStep?: StepId; elapsedMs?: number }
  | { type: "log"; line: string };

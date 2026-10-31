import type { Finding, RuleRun, SuppressedMatch } from "./findings.js";
import type { PreflightReport } from "./preflight.js";
import type { Verdict } from "./verdict.js";

/**
 * Step ids are unique within a job. System steps are `preflight`, `start`,
 * `open` and `close`; recipe steps use the recipe's ids. With two targets every
 * id gets a target suffix: `preflight@1`, `go@2`.
 */
export type StepId = string;

/** A recipe as the page sees it (the server holds the tools and rules). */
export interface RecipeInfo {
  id: string;
  title: string;
  /** The plain question the recipe answers. */
  question: string;
  description: string;
  /** How many binaries the recipe takes (2 for comparisons). */
  targets: 1 | 2;
  /** What each target is, e.g. ["Older release", "Newer release"]. */
  targetLabels: string[];
  /** Whether any step needs a disassembler (a deep-analysis route). */
  needsDeep: boolean;
  steps: { id: string; label: string; why: string; tool: string; deep: boolean }[];
  /** The rules that turn step results into findings. */
  rules: { id: string; title: string }[];
}

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
  /** Why the step runs, in plain words (recipe steps). */
  why?: string;
  /** Which target (0-based) the step works on. */
  target: number;
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
  /** How long this step is expected to take, from this machine's history (absent if unknown). */
  expected?: StepExpectation;
}

/**
 * An expectation from past runs on this machine. "same-binary": these exact
 * bytes took this long last time. "size-scaled": earlier analyses of other
 * binaries, scaled by size: an estimate, and labelled as one.
 */
export interface StepExpectation {
  ms: number;
  basis: "same-binary" | "size-scaled";
  /** How many past runs it rests on. */
  samples: number;
  /** When the same binary last ran this step ("same-binary" only). */
  lastAt?: string;
}

export interface Job {
  id: string;
  recipe: Pick<RecipeInfo, "id" | "title" | "question" | "targetLabels">;
  /** The paths the user asked to analyse, in recipe order. */
  targets: string[];
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  /** Preflight report per target (missing until that target's preflight ran). */
  preflights: (PreflightReport | null)[];
  steps: JobStep[];
  /** REA version that ran the job (or produced its cached results). */
  reaVersion?: string;
  /** Ignore the evidence cache and analyse again. */
  fresh?: boolean;
  /** Set once the recipe's rules have run, after the last step. */
  findings?: Finding[];
  suppressed?: SuppressedMatch[];
  rules?: RuleRun[];
  /** Set after the findings; its AI part may update once more. */
  verdict?: Verdict;
}

/** Server-Sent Events from /api/jobs/:id/events. Every connection starts with a snapshot. */
export type JobEvent =
  | { type: "snapshot"; job: Job }
  | {
      type: "job";
      status: JobStatus;
      startedAt?: string;
      endedAt?: string;
      reaVersion?: string;
      preflights?: (PreflightReport | null)[];
    }
  | { type: "step"; step: JobStep }
  | { type: "findings"; findings: Finding[]; suppressed: SuppressedMatch[]; rules: RuleRun[] }
  | { type: "verdict"; verdict: Verdict }
  | { type: "heartbeat"; at: string; runningStep?: StepId; elapsedMs?: number }
  | { type: "log"; line: string };

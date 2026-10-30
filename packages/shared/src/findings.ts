import type { StepId } from "./jobs.js";

/** Where in an evidence record a finding looks. Any combination may be set. */
export interface Locator {
  /** Provider address, e.g. "0x100a2b3c". */
  address?: string;
  /** File offset in the analysed bytes. */
  offset?: number;
  /** JSON path inside the evidence record, e.g. "normalized_result.build_info.go_version". */
  field?: string;
  /** About ±36 characters of context around the match. */
  snippet?: string;
}

/** One piece of REA evidence a finding rests on. */
export interface EvidenceRef {
  /** REA evidence id (`ev_…`), from the step that produced it. */
  evidenceId: string;
  step: StepId;
  locator?: Locator;
}

/**
 * Something a rule established from REA evidence. "observed" means read
 * directly from the evidence; "inferred" means a rule drew a conclusion from it.
 */
export interface Finding {
  /** Stable across runs of the same binary, e.g. "endpoint:api.github.com". */
  id: string;
  /** The rule that produced it. */
  rule: string;
  kind: string;
  /** Which target (0-based) it is about; absent when about both. */
  target?: number;
  statement: string;
  /** Never empty. */
  evidence: EvidenceRef[];
  confidence: "observed" | "inferred";
  /** What the statement does not show, in plain words. */
  caveats: string[];
  /** Structured details for display (e.g. a dependency list). */
  data?: Record<string, unknown>;
}

/** A match a rule ignored as a known false alarm, kept visible with the reason. */
export interface SuppressedMatch {
  rule: string;
  /** The matched text, truncated. */
  text: string;
  reason: string;
  evidence: EvidenceRef;
}

/** Whether a rule ran. A rule that could not run never reads as "found nothing". */
export interface RuleRun {
  id: string;
  title: string;
  status: "ran" | "not-run" | "failed";
  /** Why it did not run, or how it failed. */
  reason?: string;
  findings: number;
}

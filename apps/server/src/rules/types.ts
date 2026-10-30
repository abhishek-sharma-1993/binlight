import type {
  EvidenceRef,
  Finding,
  PreflightReport,
  StepId,
  SuppressedMatch,
} from "@binlight/shared";

/** A recipe step's successful result, as a rule sees it. */
export interface StepResult {
  /** The job's step id (e.g. "strings" or "strings@2"). */
  step: StepId;
  /** REA's schema-checked result. */
  result: unknown;
  /** REA evidence id of the result, when it has one. */
  evidenceId?: string;
}

/** One target's inputs: its preflight and the recipe steps that succeeded. */
export interface TargetInput {
  index: number;
  label: string;
  /** Null when the target could not be checked. */
  preflight: PreflightReport | null;
  /** Keyed by recipe step id ("strings"), only steps that succeeded. */
  steps: Map<string, StepResult>;
}

export interface RuleContext {
  targets: TargetInput[];
}

export interface RuleOutput {
  findings: Finding[];
  suppressed?: SuppressedMatch[];
}

/**
 * Turns REA evidence into findings. Pure: same inputs, same findings. A rule
 * only runs when every step it `needs` succeeded on every target it reads, so
 * it never has to tell "nothing found" from "nothing looked at".
 */
export interface Rule {
  id: string;
  title: string;
  /** Recipe step ids that must have succeeded. */
  needs: string[];
  /** Targets it reads (default: every target). */
  targets?: number[];
  run(ctx: RuleContext): RuleOutput;
}

/** Evidence reference for a step result, with an optional locator. */
export function ref(step: StepResult, locator?: EvidenceRef["locator"]): EvidenceRef {
  if (!step.evidenceId) throw new Error(`Step ${step.step} has no evidence id to cite.`);
  return { evidenceId: step.evidenceId, step: step.step, ...(locator && { locator }) };
}

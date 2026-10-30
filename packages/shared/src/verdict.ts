import type { AiPreview } from "./settings.js";

/** One sentence of a verdict and the findings it rests on. */
export interface VerdictClaim {
  text: string;
  /** Finding ids; never empty. */
  findings: string[];
}

export type VerdictConfidence = "high" | "medium" | "low";

/** A verdict written from findings: a short answer and claims that cite them. */
export interface VerdictBody {
  answer: string;
  claims: VerdictClaim[];
}

export interface Verdict {
  /** The rule-based verdict: always present, works with AI switched off. */
  rules: VerdictBody;
  /** Set by Binlight from what ran and what didn't; AI cannot change it. */
  confidence: VerdictConfidence;
  confidenceReason: string;
  /** What this job could not look at, in plain words. */
  gaps: string[];
  ai: {
    /**
     * off: local-only mode. awaiting-consent: waiting for the user to approve
     * sending `preview`. declined: the user chose not to send it. running:
     * Claude is rewriting it. used: Claude's version passed validation.
     * rejected: it did not (reason says why). failed: the call failed (reason).
     */
    status: "off" | "awaiting-consent" | "declined" | "running" | "used" | "rejected" | "failed";
    model?: string;
    reason?: string;
    /** Claude's validated rewrite (status "used" only). */
    body?: VerdictBody;
    /** What would be sent (status "awaiting-consent" only). */
    preview?: AiPreview;
  };
}

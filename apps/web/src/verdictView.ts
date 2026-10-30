import type { Verdict, VerdictBody } from "@binlight/shared";

export interface VerdictView {
  /** What to show: Claude's validated version if used, otherwise the rules'. */
  body: VerdictBody;
  /** One line on where the verdict came from. */
  status: string;
  /** Whether the status reports a problem the reader should notice. */
  alert: boolean;
}

export function verdictView(verdict: Verdict): VerdictView {
  const ai = verdict.ai;
  switch (ai.status) {
    case "used":
      return {
        body: ai.body ?? verdict.rules,
        status: `Written by Claude (${ai.model ?? "model unknown"}) from the findings, and checked by Binlight: every claim cites findings and states no number they don't contain.`,
        alert: false,
      };
    case "running":
      return {
        body: verdict.rules,
        status: `Binlight's rule-based verdict. Claude (${ai.model ?? ""}) is rewriting it in plain English…`,
        alert: false,
      };
    case "off":
      return {
        body: verdict.rules,
        status: ai.reason ?? "AI is off: rule-based verdict.",
        alert: false,
      };
    case "rejected":
    case "failed":
      return {
        body: verdict.rules,
        status: ai.reason ?? "Claude's version is not shown; this is the rule-based verdict.",
        alert: true,
      };
  }
}

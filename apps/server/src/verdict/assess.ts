import type { Job, Verdict } from "@binlight/shared";

/**
 * Confidence and gaps from what actually ran. Set by Binlight, never by AI:
 * every recipe step and rule ran → high; some could not → medium, with each
 * gap named; no rule ran → low.
 */
export function assess(job: Job): Pick<Verdict, "confidence" | "confidenceReason" | "gaps"> {
  const gaps: string[] = [];
  for (const step of job.steps) {
    if (!step.why) continue; // system steps; their failures surface through recipe steps
    if (step.status === "failed") {
      gaps.push(
        `${step.label}: failed (${step.error?.code ?? "error"}: ${step.error?.message ?? "no reason given"})`,
      );
    } else if (step.status === "skipped") {
      gaps.push(`${step.label}: skipped (${step.reason ?? "no reason given"})`);
    }
  }
  for (const rule of job.rules ?? []) {
    if (rule.status !== "ran")
      gaps.push(
        `${rule.title}: ${rule.status === "failed" ? "failed" : "not run"} (${rule.reason ?? "no reason given"})`,
      );
  }
  const ran = (job.rules ?? []).some((r) => r.status === "ran");
  if (!ran) {
    return { confidence: "low", confidenceReason: "None of the recipe's rules could run.", gaps };
  }
  if (gaps.length > 0) {
    return {
      confidence: "medium",
      confidenceReason: `${gaps.length} ${gaps.length === 1 ? "part" : "parts"} of the recipe could not be checked (listed below).`,
      gaps,
    };
  }
  return { confidence: "high", confidenceReason: "Every step and rule of the recipe ran.", gaps };
}

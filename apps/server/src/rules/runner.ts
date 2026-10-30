import type { Finding, RuleRun, SuppressedMatch } from "@binlight/shared";
import type { Rule, RuleContext } from "./types.js";

export interface RulesOutcome {
  findings: Finding[];
  suppressed: SuppressedMatch[];
  rules: RuleRun[];
}

/**
 * Runs a recipe's rules. A rule whose inputs are missing is "not-run" with the
 * reason; a rule that throws, or produces a finding citing evidence the job
 * does not hold, is "failed" and contributes nothing.
 */
export function runRules(
  rules: Rule[],
  ctx: RuleContext,
  stepLabels: Map<string, string>,
): RulesOutcome {
  const known = new Set(
    ctx.targets.flatMap((t) =>
      [...t.steps.values()].flatMap((s) => (s.evidenceId ? [s.evidenceId] : [])),
    ),
  );
  const outcome: RulesOutcome = { findings: [], suppressed: [], rules: [] };
  const ids = new Set<string>();

  for (const rule of rules) {
    const run: RuleRun = { id: rule.id, title: rule.title, status: "ran", findings: 0 };
    outcome.rules.push(run);

    const targets = ctx.targets.filter((t) => !rule.targets || rule.targets.includes(t.index));
    const missing = targets.flatMap((t) =>
      rule.needs
        .filter((step) => !t.steps.has(step))
        .map(
          (step) =>
            `${stepLabels.get(step) ?? step}${ctx.targets.length > 1 ? ` (${t.label})` : ""}`,
        ),
    );
    if (targets.length === 0 || missing.length > 0) {
      run.status = "not-run";
      run.reason =
        targets.length === 0
          ? "None of its targets could be analysed."
          : `Needs results that this job doesn't have: ${missing.join(", ")}.`;
      continue;
    }

    try {
      const out = rule.run({ targets });
      const own = new Set<string>();
      for (const f of out.findings) {
        if (f.evidence.length === 0) throw new Error(`Finding ${f.id} cites no evidence.`);
        for (const e of f.evidence) {
          if (!known.has(e.evidenceId)) {
            throw new Error(
              `Finding ${f.id} cites ${e.evidenceId}, which this job did not produce.`,
            );
          }
        }
        if (ids.has(f.id) || own.has(f.id)) throw new Error(`Duplicate finding id ${f.id}.`);
        own.add(f.id);
      }
      for (const id of own) ids.add(id);
      outcome.findings.push(...out.findings);
      outcome.suppressed.push(...(out.suppressed ?? []));
      run.findings = out.findings.length;
    } catch (err) {
      run.status = "failed";
      run.reason = err instanceof Error ? err.message : String(err);
    }
  }
  return outcome;
}

import type { Finding, RuleRun } from "@binlight/shared";

export interface FindingGroup {
  rule: RuleRun;
  findings: Finding[];
}

/** Findings per rule, in rule order; summaries first within a rule. */
export function groupFindings(rules: RuleRun[], findings: Finding[]): FindingGroup[] {
  return rules.map((rule) => ({
    rule,
    findings: findings
      .filter((f) => f.rule === rule.id)
      .sort((a, b) => Number(b.kind.endsWith("-summary")) - Number(a.kind.endsWith("-summary"))),
  }));
}

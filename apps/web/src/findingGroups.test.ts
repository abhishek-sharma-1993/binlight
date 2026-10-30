import type { Finding, RuleRun } from "@binlight/shared";
import { describe, expect, it } from "vitest";
import { groupFindings } from "./findingGroups.js";

const f = (id: string, rule: string, kind: string): Finding => ({
  id,
  rule,
  kind,
  statement: id,
  evidence: [{ evidenceId: "ev_x", step: "s" }],
  confidence: "observed",
  caveats: [],
});

describe("groupFindings", () => {
  it("keeps rule order, puts summaries first, and keeps rules that did not run", () => {
    const rules: RuleRun[] = [
      { id: "hosts", title: "Hosts", status: "ran", findings: 2 },
      { id: "creds", title: "Creds", status: "not-run", reason: "no strings", findings: 0 },
    ];
    const groups = groupFindings(rules, [
      f("a", "hosts", "hardcoded-host"),
      f("s", "hosts", "hardcoded-hosts-summary"),
    ]);
    expect(groups.map((g) => [g.rule.id, g.findings.map((x) => x.id)])).toEqual([
      ["hosts", ["s", "a"]],
      ["creds", []],
    ]);
  });
});

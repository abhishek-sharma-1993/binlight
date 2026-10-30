import type { EvidenceRef, Finding } from "@binlight/shared";
import { STRING_LIST_CAVEATS, stringItems } from "./strings.js";
import { snippet } from "./text.js";
import { ref, type Rule } from "./types.js";

// Ported from reference/bindossier.py (find_endpoints). Compilers, Go above all,
// pack string literals end to end, so a URL is often glued to the text before
// it ("...NUMBER_IDhttps://..."). Split on every scheme instead of requiring a
// word boundary, then keep only the hostname: the path often swallows the next
// glued literal ("/Claude.appcowork").
const URL_START = /https?:\/\//gi;
const HOST = /^https?:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/i;
const MAX_EXAMPLES = 3;

export interface HostHit {
  host: string;
  /** Index of the URL's start within the string value. */
  start: number;
  end: number;
}

/** Every hostname in hard-coded http(s) URLs inside one string. */
export function hostsIn(value: string): HostHit[] {
  const starts = [...value.matchAll(URL_START)].map((m) => m.index);
  const hits: HostHit[] = [];
  starts.forEach((start, i) => {
    const segment = value.slice(start, starts[i + 1] ?? value.length);
    const m = HOST.exec(segment);
    if (m?.[1]) hits.push({ host: m[1].toLowerCase(), start, end: start + m[0].length });
  });
  return hits;
}

/** Hostnames that appear in hard-coded URLs in the string list. */
export const hardcodedHosts: Rule = {
  id: "hardcoded-hosts",
  title: "Hostnames in hard-coded URLs",
  needs: ["strings"],
  run({ targets }) {
    const findings: Finding[] = [];
    for (const t of targets) {
      const step = t.steps.get("strings");
      if (!step) continue;
      const byHost = new Map<string, { count: number; examples: EvidenceRef[] }>();
      for (const item of stringItems(step)) {
        for (const hit of hostsIn(item.value)) {
          const entry = byHost.get(hit.host) ?? { count: 0, examples: [] };
          entry.count++;
          if (entry.examples.length < MAX_EXAMPLES) {
            entry.examples.push(
              ref(step, {
                address: item.address,
                snippet: snippet(item.value, hit.start, hit.end),
              }),
            );
          }
          byHost.set(hit.host, entry);
        }
      }
      const suffix = targets.length > 1 ? `@${t.index + 1}` : "";
      for (const [host, { count, examples }] of [...byHost].sort(([a], [b]) => (a < b ? -1 : 1))) {
        findings.push({
          id: `host:${host}${suffix}`,
          rule: "hardcoded-hosts",
          kind: "hardcoded-host",
          ...(targets.length > 1 && { target: t.index }),
          statement: `"${host}" appears in ${count === 1 ? "a hard-coded URL" : `${count} hard-coded URLs`}.`,
          evidence: examples,
          confidence: "observed",
          caveats: [
            "A URL in the binary is not proof that it is contacted: it may be documentation, an error message or unused code.",
            ...STRING_LIST_CAVEATS,
          ],
          data: { host, occurrences: count },
        });
      }
      findings.push({
        id: `hosts:summary${suffix}`,
        rule: "hardcoded-hosts",
        kind: "hardcoded-hosts-summary",
        ...(targets.length > 1 && { target: t.index }),
        statement:
          byHost.size === 0
            ? "No hostnames appear in hard-coded http(s) URLs in the string list."
            : `${byHost.size} distinct ${byHost.size === 1 ? "hostname appears" : "hostnames appear"} in hard-coded http(s) URLs in the string list.`,
        evidence: [ref(step, { field: "normalized_result" })],
        confidence: "observed",
        caveats: [
          "This is not the list of servers it talks to: addresses built at run time, and hostnames written without http(s)://, are not counted.",
          ...STRING_LIST_CAVEATS,
        ],
        data: { hosts: byHost.size },
      });
    }
    return { findings };
  },
};

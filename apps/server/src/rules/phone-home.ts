import type { EvidenceRef, Finding, SuppressedMatch } from "@binlight/shared";
import type { MultiCallResult } from "../jobs/steps.js";
import type {
  CredentialsData,
  NetworkData,
  UrlOccurrence,
  UrlUse,
  UrlsData,
} from "../recipes/phone-home-steps.js";
import { KNOWN_FALSE_ALARMS } from "./credentials.js";
import { hostsIn } from "./hosts.js";
import { cleanHosts, type HostKind } from "./hostnames.js";
import { shortHash, snippet, truncateSecret } from "./text.js";
import { refTo, type Rule, type StepResult } from "./types.js";

const MAX_FUNCTIONS = 5;
const MAX_EXAMPLES = 3;

/** "It doesn't contact only these" in every destination finding. */
const LIMITS = [
  "Only addresses written into the binary as http(s):// URLs are seen. Addresses built at run time, read from settings, or written without http(s):// are not.",
];

const KIND_NOTE: Partial<Record<HostKind, string>> = {
  loopback: "this machine (loopback)",
  "local-network": "a local-network name",
  placeholder: "a placeholder or example address",
  ip: "an IP address",
  identifier: "a namespace name, not normally fetched",
};

function functionLabel(u: UrlUse): string {
  if (!u.go) return u.procedure.name;
  const where = u.go.file
    ? ` (${u.go.file.split("/").slice(-2).join("/")}${u.go.line ? `:${u.go.line}` : ""})`
    : "";
  return `${u.go.name}${where}`;
}

/** The evidence behind one use: the URL found, its references, the function, its name. */
function useEvidence(step: StepResult, o: UrlOccurrence, u: UrlUse): EvidenceRef[] {
  return [
    refTo(step, u.xrefsEvidenceId, { address: o.address }),
    ...(u.hopEvidenceId ? [refTo(step, u.hopEvidenceId, { address: u.dataAddress ?? "" })] : []),
    refTo(step, u.procedure.evidenceId, { address: u.from }),
    ...(u.go ? [refTo(step, u.go.nameEvidenceId, { field: "normalized_result.bytes_hex" })] : []),
  ];
}

/** Hard-coded destinations: used by code (with the function), or only in text. */
export const destinations: Rule = {
  id: "destinations",
  title: "Hard-coded destinations",
  needs: ["urls"],
  run({ targets }) {
    const findings: Finding[] = [];
    for (const t of targets) {
      const step = t.steps.get("urls");
      if (!step) continue;
      const data = (step.result as MultiCallResult<UrlsData>).data;
      const suffix = targets.length > 1 ? `@${t.index + 1}` : "";
      const target = targets.length > 1 ? { target: t.index } : {};

      const byHost = new Map<
        string,
        { kind: HostKind; occ: UrlOccurrence[]; glued: Set<string> }
      >();
      // The URL ends where the next one starts (glued literals).
      const rawOf = (o: UrlOccurrence) => hostsIn(o.text).find((h) => h.start === 0)?.host;
      const cleaned = cleanHosts(data.occurrences.flatMap((o) => rawOf(o) ?? []));
      for (const o of data.occurrences) {
        const raw = rawOf(o);
        if (!raw) continue;
        const clean = cleaned.get(raw.toLowerCase());
        if (!clean) continue;
        const entry = byHost.get(clean.host) ?? { kind: clean.kind, occ: [], glued: new Set() };
        entry.occ.push(o);
        if (clean.glued) entry.glued.add(clean.glued);
        byHost.set(clean.host, entry);
      }

      let used = 0;
      for (const [host, { kind, occ, glued }] of [...byHost].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const uses = occ.flatMap((o) => o.uses.map((u) => ({ o, u })));
        const functions = [...new Map(uses.map(({ u }) => [u.procedure.address, u])).values()];
        const note = KIND_NOTE[kind] ? ` (${KIND_NOTE[kind]})` : "";
        const example = (o: UrlOccurrence) =>
          refTo(step, o.searchEvidenceId, {
            address: o.address,
            snippet: snippet(o.text, 0, Math.min(o.text.length, 72), 0),
          });
        const caveats = [
          ...(glued.size > 0
            ? [
                `Read as "${host}" from text glued to the next literal (${[...glued].map((g) => `"…${g}"`).join(", ")}).`,
              ]
            : []),
          ...(kind === "unrecognised"
            ? [
                "Its ending is not a known top-level domain, so it may be cut short or not a real host.",
              ]
            : []),
        ];
        if (functions.length > 0) {
          used++;
          const shown = functions.slice(0, MAX_FUNCTIONS).map(functionLabel);
          const more = functions.length - shown.length;
          const unnamed = functions.some((u) => !u.go);
          findings.push({
            id: `dest:${host}${suffix}`,
            rule: "destinations",
            kind: "destination-used",
            ...target,
            statement: `"${host}"${note} is used by code: ${shown.join(", ")}${more > 0 ? `, and ${more} more ${more === 1 ? "function" : "functions"}` : ""}.`,
            evidence: [
              example(occ[0] as UrlOccurrence),
              ...uses
                .filter(
                  ({ u }, i, all) =>
                    all.findIndex((x) => x.u.procedure.address === u.procedure.address) === i,
                )
                .slice(0, MAX_FUNCTIONS)
                .flatMap(({ o, u }) => useEvidence(step, o, u)),
            ],
            confidence: "observed",
            caveats: [
              "Code refers to this URL; whether that code runs, and when, depends on how the program is used.",
              ...(unnamed
                ? [
                    "Some functions have no recoverable name and are shown by Ghidra's address name (FUN_…).",
                  ]
                : []),
              ...(data.goNames === "read"
                ? [
                    "Function names, files and lines come from Go's own function table in the file, checked against Ghidra's function and REA's reading of the name.",
                  ]
                : []),
              ...caveats,
              ...LIMITS,
            ],
            data: {
              host,
              hostKind: kind,
              occurrences: occ.length,
              functions: functions.map((u) => ({
                address: u.procedure.address,
                ghidraName: u.procedure.name,
                ...(u.go && { name: u.go.name, file: u.go.file ?? null, line: u.go.line ?? null }),
                via: u.via,
              })),
            },
          });
        } else {
          findings.push({
            id: `dest:${host}${suffix}`,
            rule: "destinations",
            kind: "destination-mentioned",
            ...target,
            statement: `"${host}"${note} appears ${occ.length === 1 ? "once" : `${occ.length} times`} in text, with no code referring to it directly.`,
            evidence: occ.slice(0, MAX_EXAMPLES).map(example),
            confidence: "observed",
            caveats: [
              "Usually help text, documentation links or error messages. Code may still use it as part of a longer message, which Binlight cannot tell apart yet.",
              ...caveats,
              ...LIMITS,
            ],
            data: { host, hostKind: kind, occurrences: occ.length },
          });
        }
      }
      const total = byHost.size;
      const pages = [...new Set(data.occurrences.map((o) => o.searchEvidenceId))];
      findings.push({
        id: `dest:summary${suffix}`,
        rule: "destinations",
        kind: "destinations-summary",
        ...target,
        statement:
          total === 0
            ? "No http(s):// URLs are written into the binary."
            : `${total} ${total === 1 ? "host appears" : "hosts appear"} in http(s):// URLs written into the binary; code refers to ${used} of them.`,
        evidence:
          pages.length > 0
            ? pages.map((id) => refTo(step, id, { field: "normalized_result.matches" }))
            : [...(step.evidenceIds ?? [])].slice(0, 1).map((id) => refTo(step, id)),
        confidence: "observed",
        caveats: [
          "This is not the list of servers it talks to.",
          ...LIMITS,
          ...(data.truncated
            ? ["There were more matches than Binlight reads; the list is incomplete."]
            : []),
        ],
        data: { hosts: total, used, occurrences: data.occurrences.length },
      });
    }
    return { findings };
  },
};

/** What network work a Go binary can do, from the functions linked into it. */
export const networkCapability: Rule = {
  id: "network-capability",
  title: "Network capability",
  needs: ["network"],
  run({ targets }) {
    const findings: Finding[] = [];
    for (const t of targets) {
      const step = t.steps.get("network");
      if (!step) continue;
      const data = (step.result as MultiCallResult<NetworkData>).data;
      if (!data.goNames) continue;
      const suffix = targets.length > 1 ? `@${t.index + 1}` : "";
      const target = targets.length > 1 ? { target: t.index } : {};
      const byCapability = new Map<string, NetworkData["functions"]>();
      for (const f of data.functions) {
        if (!f.found) continue;
        byCapability.set(f.capability, [...(byCapability.get(f.capability) ?? []), f]);
      }
      for (const [capability, fns] of byCapability) {
        findings.push({
          id: `net:${shortHash(capability)}${suffix}`,
          rule: "network-capability",
          kind: "network-capability",
          ...target,
          statement: `It ${capability}: ${fns.map((f) => f.name).join(" and ")} ${fns.length === 1 ? "is" : "are"} linked in.`,
          evidence: fns.map((f) =>
            refTo(step, f.found?.evidenceId ?? f.searchEvidenceId, {
              address: f.found?.address ?? "",
              snippet: f.name,
            }),
          ),
          confidence: "observed",
          caveats: [
            "Go only links functions its code can reach, but being reachable does not mean it runs on every use.",
          ],
          data: { capability, functions: fns.map((f) => f.name) },
        });
      }
      const none = byCapability.size === 0;
      findings.push({
        id: `net:summary${suffix}`,
        rule: "network-capability",
        kind: "network-capability-summary",
        ...target,
        statement: none
          ? `None of the ${data.functions.length} network functions Binlight looks for is linked in.`
          : `${byCapability.size} of the network capabilities Binlight looks for are linked in.`,
        evidence: data.functions.map((f) => refTo(step, f.searchEvidenceId, { snippet: f.name })),
        confidence: "observed",
        caveats: [
          `Binlight looks for ${data.functions.length} well-known Go functions; network code that uses other libraries, or calls the system directly, is not recognised.`,
        ],
        data: { capabilities: byCapability.size, checked: data.functions.length },
      });
    }
    return { findings };
  },
};

/** Credential-shaped values found in the bytes, always truncated. */
export const credentialBytes: Rule = {
  id: "credential-bytes",
  title: "Credential-shaped values",
  needs: ["secrets"],
  run({ targets }) {
    const findings: Finding[] = [];
    const suppressed: SuppressedMatch[] = [];
    for (const t of targets) {
      const step = t.steps.get("secrets");
      if (!step) continue;
      const data = (step.result as MultiCallResult<CredentialsData>).data;
      const suffix = targets.length > 1 ? `@${t.index + 1}` : "";
      const target = targets.length > 1 ? { target: t.index } : {};
      const seen = new Set<string>();
      let ignored = 0;
      for (const c of data.candidates) {
        const value = c.text.slice(c.valueStart, c.valueEnd);
        const shown = truncateSecret(value);
        const context = snippet(c.text, c.valueStart, c.valueEnd).replace(value, shown);
        const evidence = refTo(step, c.readEvidenceId, { address: c.address, snippet: context });
        const alarm = KNOWN_FALSE_ALARMS.find((a) => a.match.test(value));
        if (alarm) {
          ignored++;
          suppressed.push({
            rule: "credential-bytes",
            text: shown,
            reason: alarm.reason,
            evidence,
          });
          continue;
        }
        const id = `secret:${shortHash(`${c.label}:${value}`)}${suffix}`;
        if (seen.has(id)) continue;
        seen.add(id);
        findings.push({
          id,
          rule: "credential-bytes",
          kind: "credential-value",
          ...target,
          statement: `A value shaped like a ${c.label} is embedded: ${shown}`,
          evidence: [evidence],
          confidence: "inferred",
          caveats: [
            "Matched by its shape only: it may be a sample, a test value, or revoked.",
            "Shown truncated; Binlight never displays a whole credential.",
          ],
          data: { kind: c.label },
        });
      }
      const found = seen.size;
      findings.push({
        id: `secrets:summary${suffix}`,
        rule: "credential-bytes",
        kind: "credential-values-summary",
        ...target,
        statement:
          (found === 0
            ? "No credential-shaped values match the strict patterns in the binary's bytes"
            : `${found} credential-shaped ${found === 1 ? "value matches" : "values match"} the strict patterns in the binary's bytes`) +
          (ignored > 0
            ? ` (${ignored} known false ${ignored === 1 ? "alarm" : "alarms"} ignored).`
            : "."),
        evidence: [...(step.evidenceIds ?? [])].slice(0, 3).map((id) => refTo(step, id)),
        confidence: "observed",
        caveats: [
          "Only well-known key formats are checked; a credential in another format, or one that is encrypted or built at run time, would not match.",
          ...(data.truncated
            ? ["There were more prefix matches than Binlight reads; the check is incomplete."]
            : []),
        ],
        data: { found, ignored },
      });
    }
    return { findings, suppressed };
  },
};

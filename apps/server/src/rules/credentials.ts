import type { Finding, SuppressedMatch } from "@binlight/shared";
import { STRING_LIST_CAVEATS, stringItems } from "./strings.js";
import { shortHash, snippet, truncateSecret } from "./text.js";
import { ref, type Rule } from "./types.js";

// Strict patterns for credential VALUES, from reference/bindossier.py. A hit is
// worth a human look. Credential-related NAMES (APIKey, POOLSIDE_API_KEY=...,
// TLS secret labels) are deliberately not findings.
export const CREDENTIAL_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/g },
  // A letter or digit must follow "sk-": glued CLI flags such as
  // "--accept-risk--auth-choice--skip-health" otherwise match from "ri[sk--]".
  {
    label: "OpenAI/Anthropic-style API key",
    pattern: /sk-(?:ant-)?[A-Za-z0-9][A-Za-z0-9_-]{23,}/g,
  },
  { label: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { label: "Slack token", pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { label: "Google API key", pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { label: "Private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { label: "JWT", pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

/**
 * Matches that are known not to be credentials, tested against the matched
 * text only. A hit is suppressed with the reason shown, never silently dropped.
 */
export const KNOWN_FALSE_ALARMS: { match: RegExp; reason: string }[] = [
  { match: /^AKIAIOSFODNN7EXAMPLE$/, reason: "AWS's documented example access key." },
  { match: /uXFGweU9l35qcif/, reason: "A sample password in kubectl's help text." },
  {
    // sk-ecdsa-sha2-nistp256@openssh.com and its -cert-v01 variant (in Ollama
    // 0.40.6), sk-ssh-ed25519@openssh.com.
    match: /^sk-(?:ecdsa-sha2-|ssh-ed25519)/,
    reason: "An OpenSSH security-key algorithm name, not a key.",
  },
];

/** Credential-shaped values, by strict pattern, always truncated. */
export const credentialValues: Rule = {
  id: "credential-values",
  title: "Credential-shaped values",
  needs: ["strings"],
  run({ targets }) {
    const findings: Finding[] = [];
    const suppressed: SuppressedMatch[] = [];
    for (const t of targets) {
      const step = t.steps.get("strings");
      if (!step) continue;
      const seen = new Set<string>();
      const suppressedBefore = suppressed.length;
      const suffix = targets.length > 1 ? `@${t.index + 1}` : "";
      for (const item of stringItems(step)) {
        for (const { label, pattern } of CREDENTIAL_PATTERNS) {
          for (const m of item.value.matchAll(pattern)) {
            const value = m[0];
            const start = m.index;
            const shown = truncateSecret(value);
            // The snippet must not reveal the value either.
            const context = snippet(item.value, start, start + value.length).replace(value, shown);
            // Judge the match itself, not the whole string: Go packs many literals
            // into one string, so a sample elsewhere in it says nothing about this.
            const alarm = KNOWN_FALSE_ALARMS.find((a) => a.match.test(value));
            const evidence = ref(step, { address: item.address, snippet: context });
            if (alarm) {
              suppressed.push({
                rule: "credential-values",
                text: shown,
                reason: alarm.reason,
                evidence,
              });
              continue;
            }
            const id = `credential:${shortHash(`${label}:${value}`)}${suffix}`;
            if (seen.has(id)) continue;
            seen.add(id);
            findings.push({
              id,
              rule: "credential-values",
              kind: "credential-value",
              ...(targets.length > 1 && { target: t.index }),
              statement: `A value shaped like a ${label} is embedded: ${shown}`,
              evidence: [evidence],
              confidence: "inferred",
              caveats: [
                "Matched by its shape only: it may be a sample, a test value, or revoked.",
                "Shown truncated; Binlight never displays a whole credential.",
                ...STRING_LIST_CAVEATS,
              ],
              data: { kind: label },
            });
          }
        }
      }
      // A summary, so "none found" is an observation a verdict can cite.
      const found = seen.size;
      const ignored = suppressed.length - suppressedBefore;
      findings.push({
        id: `credentials:summary${suffix}`,
        rule: "credential-values",
        kind: "credential-values-summary",
        ...(targets.length > 1 && { target: t.index }),
        statement:
          (found === 0
            ? "No credential-shaped values match the strict patterns in the string list"
            : `${found} credential-shaped ${found === 1 ? "value matches" : "values match"} the strict patterns in the string list`) +
          (ignored > 0
            ? ` (${ignored} known false ${ignored === 1 ? "alarm" : "alarms"} ignored).`
            : "."),
        evidence: [ref(step, { field: "normalized_result" })],
        confidence: "observed",
        caveats: [
          "Only well-known key formats are checked; a credential in another format would not match.",
          ...STRING_LIST_CAVEATS,
        ],
        data: { found, ignored },
      });
    }
    return { findings, suppressed };
  },
};

import type { Finding, VerdictBody, VerdictClaim } from "@binlight/shared";

const NAMED_HOSTS = 3;
/** Hosts worth naming first in the answer: real public hosts before loopback or placeholders. */
const RANK: Record<string, number> = {
  public: 0,
  ip: 1,
  "local-network": 2,
  loopback: 3,
  identifier: 4,
  placeholder: 5,
  unrecognised: 6,
};

/** "What could it contact, and from where in its code?", from the findings only. */
export function phoneHomeVerdict(findings: Finding[]): VerdictBody {
  const claims: VerdictClaim[] = [];
  const answer: string[] = [];
  const own = findings.filter((f) => f.target === undefined);

  const summary = own.find((f) => f.id === "dest:summary");
  const used = own
    .filter((f) => f.kind === "destination-used")
    .sort(
      (a, b) =>
        (RANK[String(a.data?.["hostKind"])] ?? 9) - (RANK[String(b.data?.["hostKind"])] ?? 9) ||
        ((b.data?.["functions"] as unknown[] | undefined)?.length ?? 0) -
          ((a.data?.["functions"] as unknown[] | undefined)?.length ?? 0),
    );
  if (summary) {
    claims.push({ text: summary.statement, findings: [summary.id] });
    const hosts = Number(summary.data?.["hosts"] ?? 0);
    if (hosts === 0) answer.push("No http(s):// URLs are written into it");
    else if (used.length === 0) {
      answer.push(
        `${hosts} ${hosts === 1 ? "host appears" : "hosts appear"} in URLs written into it, all in text such as help messages; no code refers to them directly`,
      );
    } else {
      const named = used.slice(0, NAMED_HOSTS).map((f) => String(f.data?.["host"]));
      answer.push(
        `Code refers to ${used.length} of the ${hosts} hosts written into it, including ${named.join(", ")}; the rest appear in text such as help messages and docs`,
      );
    }
  }
  // One claim per used host (the function behind it), capped so the verdict stays readable.
  for (const f of used.slice(0, 12)) claims.push({ text: f.statement, findings: [f.id] });

  const capabilities = own.filter((f) => f.kind === "network-capability");
  const netSummary = own.find((f) => f.id === "net:summary");
  for (const f of capabilities) claims.push({ text: f.statement, findings: [f.id] });
  if (capabilities.length > 0) {
    const what = capabilities.map((f) => String(f.data?.["capability"]));
    answer.push(`it ${[...new Set(what)].join(", ")}`);
  } else if (netSummary) {
    claims.push({ text: netSummary.statement, findings: [netSummary.id] });
    answer.push("none of the Go network functions Binlight looks for is linked in");
  }

  const secrets = own.find((f) => f.id === "secrets:summary");
  const values = own.filter((f) => f.kind === "credential-value");
  if (secrets) {
    claims.push({ text: secrets.statement, findings: [secrets.id, ...values.map((v) => v.id)] });
    const found = Number(secrets.data?.["found"] ?? 0);
    answer.push(
      found === 0
        ? "no embedded keys match the strict patterns"
        : `${found} key-shaped ${found === 1 ? "value needs" : "values need"} a look by hand`,
    );
  }

  return {
    answer:
      answer.length > 0
        ? `${answer.join("; ")}.`.replace(/^./, (c) => c.toUpperCase())
        : "The steps that look for destinations did not produce findings (see the gaps below).",
    claims: claims.slice(0, 20),
  };
}

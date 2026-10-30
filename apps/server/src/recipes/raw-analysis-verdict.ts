import type { Finding, VerdictBody, VerdictClaim } from "@binlight/shared";

/** A plain summary of what REA saw, built only from the findings' statements and data. */
export function rawAnalysisVerdict(findings: Finding[]): VerdictBody {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const get = (id: string) => byId.get(id);
  const claims: VerdictClaim[] = [];
  const answer: string[] = [];

  const toolchain = get("go:toolchain");
  const module = get("go:module");
  const deps = get("go:dependencies");
  const none = get("go:none");
  if (toolchain && module) {
    claims.push({
      text: `${toolchain.statement} ${module.statement}`,
      findings: [toolchain.id, module.id],
    });
    const path = String(module.data?.["path"] ?? "");
    const version = String(module.data?.["version"] ?? "");
    const goVersion = String(toolchain.data?.["goVersion"] ?? "").replace(/^go/, "");
    const count = deps ? (deps.data?.["dependencies"] as unknown[] | undefined)?.length : undefined;
    answer.push(
      `A Go ${goVersion} build of ${path} ${version}${count !== undefined ? ` with ${count} module ${count === 1 ? "dependency" : "dependencies"}` : ""}`,
    );
  } else if (none) {
    claims.push({ text: none.statement, findings: [none.id] });
    answer.push("A binary with no Go build information");
  }
  if (deps) claims.push({ text: deps.statement, findings: [deps.id] });
  const dirty = get("go:dirty");
  if (dirty) claims.push({ text: dirty.statement, findings: [dirty.id] });

  const hosts = get("hosts:summary");
  const creds = get("credentials:summary");
  if (hosts) claims.push({ text: hosts.statement, findings: [hosts.id] });
  const values = findings.filter((f) => f.kind === "credential-value");
  if (creds)
    claims.push({ text: creds.statement, findings: [creds.id, ...values.map((v) => v.id)] });

  const strings: string[] = [];
  if (hosts) {
    const n = Number(hosts.data?.["hosts"] ?? 0);
    strings.push(`${n} ${n === 1 ? "hostname" : "hostnames"} in hard-coded URLs`);
  }
  if (creds) {
    const n = Number(creds.data?.["found"] ?? 0);
    strings.push(
      n === 0
        ? "no credential-shaped values"
        : `${n} credential-shaped ${n === 1 ? "value" : "values"} to check by hand`,
    );
  }
  if (strings.length > 0) answer.push(`its string list shows ${strings.join(" and ")}`);

  return {
    answer:
      answer.length > 0
        ? `${answer.join("; ")}.`
        : "REA's results produced no findings for this binary (see the gaps below).",
    claims,
  };
}

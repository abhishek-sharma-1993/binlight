import type { Finding, VerdictBody, VerdictClaim } from "@binlight/shared";

/** "What is it built from, and is it current?", from the findings' statements and data only. */
export function whatsInsideVerdict(findings: Finding[]): VerdictBody {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const get = (id: string) => byId.get(id);
  const claims: VerdictClaim[] = [];
  const answer: string[] = [];
  const claim = (...fs: (Finding | undefined)[]) => {
    const present = fs.filter((f): f is Finding => f !== undefined);
    if (present.length > 0)
      claims.push({
        text: present.map((f) => f.statement).join(" "),
        findings: present.map((f) => f.id),
      });
  };

  const toolchain = get("go:toolchain");
  const module = get("go:module");
  const deps = get("go:dependencies");
  const support = get("go:support");
  const rust = get("rust:dependencies");
  const none = get("deps:none");

  if (toolchain && module) {
    claim(toolchain, module);
    claim(deps);
    claim(get("go:dirty"));
    claim(support);
    const goVersion = String(toolchain.data?.["goVersion"] ?? "").replace(/^go/, "");
    const count = (deps?.data?.["dependencies"] as unknown[] | undefined)?.length;
    answer.push(
      `A Go ${goVersion} build of ${String(module.data?.["path"] ?? "")} ${String(module.data?.["version"] ?? "")}${count !== undefined ? ` with ${count} module ${count === 1 ? "dependency" : "dependencies"}` : ""}`,
    );
    const status = support?.data?.["status"];
    if (status === "supported") answer.push("that Go release is still supported");
    else if (status === "unsupported") answer.push("that Go release is no longer supported");
  } else if (rust) {
    claim(rust);
    const count = (rust.data?.["dependencies"] as unknown[] | undefined)?.length ?? 0;
    answer.push(`A Rust build with ${count} ${count === 1 ? "crate" : "crates"} listed`);
  } else if (none) {
    claim(none);
    answer.push(
      "It embeds no dependency list, so what it is built from cannot be read from metadata",
    );
  }

  const platform = get("macho:platform");
  const libraries = get("macho:libraries");
  claim(platform);
  claim(libraries);
  if (platform) {
    const p = platform.data ?? {};
    answer.push(
      `built for ${String(p["platform"])}${p["minimumOs"] ? ` ${String(p["minimumOs"])} or later` : ""}`,
    );
  }

  const sig = findings.find((f) => f.rule === "signing" && !f.target);
  claim(sig);
  if (sig) {
    const label: Record<string, string> = {
      unsigned: "not code-signed",
      "signed-apple": "signed by Apple",
      "signed-developer": `signed by Team ID ${String(sig.data?.["teamId"] ?? "")}`,
      "signed-adhoc": "ad-hoc signed (no developer identity)",
    };
    if (label[sig.kind]) answer.push(label[sig.kind] as string);
  }

  return {
    answer:
      answer.length > 0
        ? `${answer.join("; ")}.`
        : "The metadata steps produced no findings for this binary (see the gaps below).",
    claims,
  };
}

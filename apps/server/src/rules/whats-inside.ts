import type { Finding } from "@binlight/shared";
import type { ToolOutput } from "../rea/schemas.js";
import { GO_RELEASES, goSupport } from "./go-releases.js";
import { ref, type Rule } from "./types.js";

const monthName = (ym: string) =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const tableDate = new Date(`${GO_RELEASES.asOf}T00:00:00Z`).toLocaleDateString("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "Is it current?" for the Go toolchain, from the bundled release table (offline). */
export const goSupportRule: Rule = {
  id: "go-support",
  title: "Go version support",
  needs: ["go"],
  run({ targets }) {
    const findings: Finding[] = [];
    for (const t of targets) {
      const step = t.steps.get("go");
      const info =
        step && (step.result as ToolOutput<"inspect_go_binary">).normalized_result.build_info;
      if (!step || !info) continue;
      const s = goSupport(info.go_version);
      const statement =
        s.status === "supported"
          ? `Go ${s.major} is still supported: Go fixes security issues in its two newest major releases, ${s.supported[0]} and ${s.supported[1]}.`
          : s.status === "unsupported"
            ? `Go ${s.major} is no longer supported: its support ended when Go ${s.endedBy} was released (${monthName(s.endedOn)}).`
            : s.status === "newer-than-table"
              ? `Go ${s.major} is newer than Binlight's Go release table, so its support status is not known here.`
              : `Its Go version's support status cannot be judged: ${s.reason}`;
      const stale =
        Date.now() - Date.parse(`${GO_RELEASES.asOf}T00:00:00Z`) > 183 * 24 * 3600 * 1000;
      findings.push({
        id: targets.length > 1 ? `go:support@${t.index + 1}` : "go:support",
        rule: "go-support",
        kind: "go-support",
        ...(targets.length > 1 && { target: t.index }),
        statement,
        evidence: [ref(step, { field: "normalized_result.build_info.go_version" })],
        confidence: "inferred",
        caveats: [
          `Judged from Binlight's Go release table dated ${tableDate}, offline${stale ? "; the table is over six months old, so a newer Go may have been released since" : ""}.`,
          "Only the major version is judged; whether this is the newest patch release, and whether its dependencies are current or have known vulnerabilities, is not checked offline.",
        ],
        data: { goVersion: info.go_version, status: s.status },
      });
    }
    return { findings };
  },
};

/** Rust crates, when the binary was built with cargo-auditable; and the compiler commit. */
export const rustDependencies: Rule = {
  id: "rust-dependencies",
  title: "Rust build information",
  needs: ["rust"],
  run({ targets }) {
    const findings: Finding[] = [];
    for (const t of targets) {
      const step = t.steps.get("rust");
      if (!step) continue;
      const r = (step.result as ToolOutput<"inspect_rust_binary">).normalized_result;
      const id = (name: string) => (targets.length > 1 ? `${name}@${t.index + 1}` : name);
      const target = targets.length > 1 ? { target: t.index } : {};
      const meta = r.auditable_metadata;
      if (meta) {
        const root =
          meta.packages.find((p) => p.root) ??
          (meta.root_package_index != null ? meta.packages[meta.root_package_index] : undefined);
        if (root) {
          findings.push({
            id: id("rust:main"),
            rule: "rust-dependencies",
            kind: "rust-main-crate",
            ...target,
            statement: `Main crate ${root.name} at version ${root.version}.`,
            evidence: [ref(step, { field: "normalized_result.auditable_metadata.packages" })],
            confidence: "observed",
            caveats: [],
            data: { name: root.name, version: root.version },
          });
        }
        const deps = meta.packages.filter((p) => p !== root);
        findings.push({
          id: id("rust:dependencies"),
          rule: "rust-dependencies",
          kind: "rust-dependencies",
          ...target,
          statement:
            deps.length === 0
              ? "Its embedded crate list (cargo-auditable) has no dependencies."
              : `It embeds a crate list (cargo-auditable) with ${deps.length} ${deps.length === 1 ? "dependency" : "dependencies"}.`,
          evidence: [ref(step, { field: "normalized_result.auditable_metadata.packages" })],
          confidence: "observed",
          caveats: [
            "The list is what the build recorded; it is not authenticated and does not show how much of each crate is used.",
          ],
          data: {
            dependencies: deps.map((p) => ({
              path: p.name,
              version: p.version,
              ...(p.source && { source: p.source }),
              ...(p.kind && { kind: p.kind }),
            })),
          },
        });
      }
      const commit = r.rustc_commit?.hashes[0]?.hash;
      if (commit) {
        findings.push({
          id: id("rust:compiler"),
          rule: "rust-dependencies",
          kind: "rust-compiler",
          ...target,
          statement: `It was most likely built with the Rust compiler at commit ${commit}.`,
          evidence: [ref(step, { field: "normalized_result.rustc_commit" })],
          confidence: "inferred",
          caveats: [
            "Read from a compiler path left in the binary, not proof of the compiler used. Which Rust release that commit is, and whether it is current, is not checked offline.",
          ],
          data: { commit },
        });
      }
    }
    return { findings };
  },
};

/** Said plainly when neither Go nor Rust metadata is embedded. */
export const noDependencyMetadata: Rule = {
  id: "dependency-metadata",
  title: "Embedded dependency list",
  needs: ["go", "rust"],
  run({ targets }) {
    const findings: Finding[] = [];
    for (const t of targets) {
      const go = t.steps.get("go");
      const rust = t.steps.get("rust");
      if (!go || !rust) continue;
      const goInfo = (go.result as ToolOutput<"inspect_go_binary">).normalized_result.build_info;
      const rustInfo = (rust.result as ToolOutput<"inspect_rust_binary">).normalized_result
        .auditable_metadata;
      if (goInfo || (rustInfo !== null && rustInfo !== undefined)) continue;
      findings.push({
        id: targets.length > 1 ? `deps:none@${t.index + 1}` : "deps:none",
        rule: "dependency-metadata",
        kind: "no-dependency-metadata",
        ...(targets.length > 1 && { target: t.index }),
        statement:
          "It embeds no dependency list: it is neither a Go binary nor a Rust binary built with cargo-auditable, so what it is built from cannot be read from metadata.",
        evidence: [
          ref(go, { field: "normalized_result.build_info" }),
          ref(rust, { field: "normalized_result.auditable_metadata" }),
        ],
        confidence: "observed",
        caveats: [
          "C, C++, Swift and most other languages embed no such list; seeing what is inside them needs a disassembler.",
        ],
      });
    }
    return { findings };
  },
};

const isSystemLibrary = (path: string) =>
  path.startsWith("/usr/lib/") || path.startsWith("/System/");

/** Which macOS it targets, and which libraries it links. */
export const machoPlatform: Rule = {
  id: "macho-platform",
  title: "Platform and linked libraries",
  needs: ["macho"],
  run({ targets }) {
    const findings: Finding[] = [];
    for (const t of targets) {
      const step = t.steps.get("macho");
      if (!step) continue;
      const r = (step.result as ToolOutput<"inspect_macho">).normalized_result;
      const suffix = targets.length > 1 ? `@${t.index + 1}` : "";
      const target = targets.length > 1 ? { target: t.index } : {};
      const build = r.build_metadata.items[0];
      if (build) {
        const platform = build.platform === "MACOS" ? "macOS" : build.platform;
        findings.push({
          id: `macho:platform${suffix}`,
          rule: "macho-platform",
          kind: "macho-platform",
          ...target,
          statement: `It is built for ${platform}${build.minimum_os ? ` ${build.minimum_os} or later` : ""}${build.sdk ? `, with the ${platform} ${build.sdk} SDK` : ""}.`,
          evidence: [ref(step, { field: "normalized_result.build_metadata" })],
          confidence: "observed",
          caveats: [],
          data: { platform, minimumOs: build.minimum_os ?? null, sdk: build.sdk ?? null },
        });
      }
      const libs = r.dependencies.items.map((d) => d.path);
      const others = libs.filter((p) => !isSystemLibrary(p));
      findings.push({
        id: `macho:libraries${suffix}`,
        rule: "macho-platform",
        kind: "macho-libraries",
        ...target,
        statement:
          others.length === 0
            ? `It links ${libs.length} ${libs.length === 1 ? "library" : "libraries"}, all part of macOS.`
            : `It links ${libs.length} libraries: ${libs.length - others.length} from macOS and ${others.length} from elsewhere (${others.join(", ")}).`,
        evidence: [ref(step, { field: "normalized_result.dependencies" })],
        confidence: "observed",
        caveats: [
          "Only libraries linked at run time are listed; code compiled into the binary (such as Go modules) is not.",
          ...(r.dependencies.exhaustive ? [] : ["REA reports this list as incomplete."]),
        ],
        data: { libraries: libs },
      });
    }
    return { findings };
  },
};

/** Who signed it: a developer identity, Apple, ad-hoc, or nobody. */
export const signing: Rule = {
  id: "signing",
  title: "Code signature",
  needs: ["signature"],
  run({ targets }) {
    const findings: Finding[] = [];
    for (const t of targets) {
      const step = t.steps.get("signature");
      if (!step) continue;
      const s = (step.result as ToolOutput<"inspect_signature">).normalized_result;
      const authorities = s.authorities ?? [];
      const apple = authorities.some(
        (a) => a === "Software Signing" || a.startsWith("Apple Code Signing"),
      );
      let statement: string;
      let kind: string;
      if (!s.signed) {
        kind = "unsigned";
        statement = "It is not code-signed.";
      } else if (apple) {
        kind = "signed-apple";
        statement = "It is signed by Apple.";
      } else if (s.team_identifier) {
        kind = "signed-developer";
        statement = `It is signed with a developer identity (Team ID ${s.team_identifier}${authorities[0] ? `, "${authorities[0]}"` : ""}).`;
      } else {
        kind = "signed-adhoc";
        statement =
          "It is ad-hoc signed: signed with no developer identity (no Team ID or certificate).";
      }
      const extras = s.signed
        ? [
            s.hardened_runtime ? "the hardened runtime is on" : "the hardened runtime is off",
            s.timestamp ? "it has a secure timestamp" : "it has no secure timestamp",
          ]
        : [];
      findings.push({
        id: targets.length > 1 ? `signing@${t.index + 1}` : "signing",
        rule: "signing",
        kind,
        ...(targets.length > 1 && { target: t.index }),
        statement:
          extras.length > 0
            ? `${statement} ${extras.join("; ").replace(/^./, (c) => c.toUpperCase())}.`
            : statement,
        evidence: [ref(step, { field: "normalized_result" })],
        confidence: "observed",
        caveats: [
          ...(kind === "signed-adhoc"
            ? [
                "Ad-hoc signing is usual for software built locally or by package managers; it says nothing about who built it.",
              ]
            : []),
          "Notarization is not checked.",
        ],
        data: {
          signed: s.signed,
          teamId: s.team_identifier ?? null,
          authorities,
          hardenedRuntime: s.hardened_runtime ?? null,
        },
      });
    }
    return { findings };
  },
};

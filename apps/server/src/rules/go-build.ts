import type { Finding } from "@binlight/shared";
import type { ToolOutput } from "../rea/schemas.js";
import { ref, type Rule } from "./types.js";

const FIELD = "normalized_result.build_info";
/** Build settings worth calling out; the rest stay in the finding's data. */
const NOTABLE_SETTINGS = [
  "CGO_ENABLED",
  "-trimpath",
  "-buildmode",
  "GOOS",
  "GOARCH",
  "vcs.revision",
  "vcs.time",
  "vcs.modified",
];

/** What a Go binary says about how it was built: toolchain, module, dependencies. */
export const goBuildInfo: Rule = {
  id: "go-build-info",
  title: "Go build information",
  needs: ["go"],
  run({ targets }) {
    const findings: Finding[] = [];
    for (const t of targets) {
      const step = t.steps.get("go");
      if (!step) continue;
      const info = (step.result as ToolOutput<"inspect_go_binary">).normalized_result.build_info;
      const target = targets.length > 1 ? { target: t.index } : {};
      const id = (name: string) => (targets.length > 1 ? `${name}@${t.index + 1}` : name);

      if (!info) {
        findings.push({
          id: id("go:none"),
          rule: "go-build-info",
          kind: "no-go-build-info",
          ...target,
          statement: "No Go build information is embedded in this binary.",
          evidence: [ref(step, { field: FIELD })],
          confidence: "observed",
          caveats: [
            "Binaries written in other languages have none, so this does not show which language it is.",
          ],
        });
        continue;
      }

      findings.push({
        id: id("go:toolchain"),
        rule: "go-build-info",
        kind: "go-toolchain",
        ...target,
        statement: `Built with Go ${info.go_version.replace(/^go/, "")}.`,
        evidence: [ref(step, { field: `${FIELD}.go_version` })],
        confidence: "observed",
        caveats: ["Embedded build metadata, not proof of the compiler that produced the file."],
        data: { goVersion: info.go_version },
      });

      const main = info.module.main;
      const unversioned = main.version === "(devel)" || main.version === "";
      findings.push({
        id: id("go:module"),
        rule: "go-build-info",
        kind: "go-main-module",
        ...target,
        statement: unversioned
          ? `Main module ${main.path}, built without a release version ("${main.version || "none"}").`
          : `Main module ${main.path} at version ${main.version}.`,
        evidence: [ref(step, { field: `${FIELD}.module.main` })],
        confidence: "observed",
        caveats: [],
        data: { path: main.path, version: main.version },
      });

      if (main.version.endsWith("+dirty")) {
        findings.push({
          id: id("go:dirty"),
          rule: "go-build-info",
          kind: "go-dirty-build",
          ...target,
          statement:
            "It was built from a source tree with uncommitted changes (its version ends in +dirty).",
          evidence: [ref(step, { field: `${FIELD}.module.main.version` })],
          confidence: "inferred",
          caveats: ["Go adds +dirty when the working tree had changes; it does not say which."],
        });
      }

      const deps = info.module.dependencies;
      findings.push({
        id: id("go:dependencies"),
        rule: "go-build-info",
        kind: "go-dependencies",
        ...target,
        statement:
          deps.length === 0
            ? "It embeds no Go module dependencies (only the standard library)."
            : `It embeds ${deps.length} Go module ${deps.length === 1 ? "dependency" : "dependencies"}.`,
        evidence: [ref(step, { field: `${FIELD}.module.dependencies` })],
        confidence: "observed",
        caveats: [
          "The list is what the build recorded; it does not show how much of each module is used.",
        ],
        data: {
          dependencies: deps.map((d) => ({
            path: d.path,
            version: d.version,
            ...(d.replacement !== null && { replaced: true }),
          })),
        },
      });

      const settings = Object.fromEntries(info.module.settings.map((s) => [s.key, s.value]));
      const notable = NOTABLE_SETTINGS.filter((k) => k in settings).map(
        (k) => `${k}=${settings[k]}`,
      );
      if (notable.length > 0) {
        findings.push({
          id: id("go:settings"),
          rule: "go-build-info",
          kind: "go-build-settings",
          ...target,
          statement: `Build settings: ${notable.join(", ")}.`,
          evidence: [ref(step, { field: `${FIELD}.module.settings` })],
          confidence: "observed",
          caveats: [],
          data: { settings },
        });
      }
    }
    return { findings };
  },
};

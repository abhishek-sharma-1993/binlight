import { describe, expect, it } from "vitest";
import { evidence } from "../jobs/fakes.js";
import { whatsInsideVerdict } from "../recipes/whats-inside-verdict.js";
import { validateVerdict } from "../verdict/validate.js";
import { goBuildInfo } from "./go-build.js";
import { GO_RELEASES, goSupport } from "./go-releases.js";
import { runRules } from "./runner.js";
import type { StepResult, TargetInput } from "./types.js";
import {
  goSupportRule,
  machoPlatform,
  noDependencyMetadata,
  rustDependencies,
  signing,
} from "./whats-inside.js";

const step = (id: string, tool: string, normalized: unknown, n: string): StepResult => ({
  step: id,
  evidenceId: `ev_${n.repeat(64)}`,
  result: evidence(tool, normalized),
});
const mod = (path: string, version: string) => ({ path, version, sum: "", replacement: null });
const goInfo = (v: string) => ({
  go_version: v,
  module: {
    path: "k8s.io/kubernetes",
    main: mod("k8s.io/kubernetes", "v1.37.1"),
    dependencies: [mod("github.com/spf13/cobra", "v1.9.1")],
    settings: [],
    complete: true,
  },
});
const go = (info: unknown) =>
  step(
    "go",
    "inspect_go_binary",
    { format: "macho", architecture: "arm64", build_info: info },
    "1",
  );
const rust = (meta: unknown) =>
  step(
    "rust",
    "inspect_rust_binary",
    { format: "macho", architecture: "arm64", auditable_metadata: meta, rustc_commit: null },
    "2",
  );
// kubectl from Homebrew, as REA 6.7.0 reported it on 10 Nov 2026.
const macho = (libs: string[]) =>
  step(
    "macho",
    "inspect_macho",
    {
      format: "macho",
      build_metadata: { items: [{ platform: "MACOS", minimum_os: "26.0", sdk: "26.5" }] },
      dependencies: {
        items: libs.map((path) => ({ path, kind: "load" })),
        total: libs.length,
        exhaustive: true,
      },
    },
    "3",
  );
const sig = (s: Record<string, unknown>) => step("signature", "inspect_signature", s, "4");
const ADHOC = {
  signed: true,
  identifier: "kubectl",
  team_identifier: null,
  authorities: [],
  timestamp: null,
  hardened_runtime: false,
  entitlements: null,
};
const target = (steps: StepResult[]): TargetInput => ({
  index: 0,
  label: "Binary",
  preflight: null,
  steps: new Map(steps.map((s) => [s.step, s])),
});
const run = (steps: StepResult[]) =>
  runRules(
    [goBuildInfo, goSupportRule, rustDependencies, noDependencyMetadata, machoPlatform, signing],
    { targets: [target(steps)] },
    new Map(),
  );

describe("goSupport", () => {
  it("treats the two newest majors as supported, and dates the end of older ones", () => {
    expect(goSupport("go1.27.3")).toEqual({
      status: "supported",
      major: "1.27",
      supported: ["1.27", "1.26"],
    });
    expect(goSupport("go1.26.8").status).toBe("supported");
    expect(goSupport("go1.25.4")).toEqual({
      status: "unsupported",
      major: "1.25",
      endedBy: "1.27",
      endedOn: "2026-08",
    });
    expect(goSupport("go1.28.0").status).toBe("newer-than-table");
    expect(goSupport("go1.12").status).toBe("unknown");
    expect(goSupport("devel +abc").status).toBe("unknown");
  });

  it("has a table dated today or earlier, newest first", () => {
    expect(Date.parse(GO_RELEASES.asOf)).toBeLessThanOrEqual(Date.now());
    const months = GO_RELEASES.releases.map((r) => r.released);
    expect([...months].sort().reverse()).toEqual(months);
  });
});

describe("What's inside? rules", () => {
  it("reads kubectl: Go, supported, macOS 26.0, system libraries only, ad-hoc signed", () => {
    const out = run([
      go(goInfo("go1.26.8")),
      rust(null),
      macho(["/usr/lib/libSystem.B.dylib", "/usr/lib/libresolv.9.dylib"]),
      sig(ADHOC),
    ]);
    expect(out.rules.every((r) => r.status === "ran")).toBe(true);
    const byId = new Map(out.findings.map((f) => [f.id, f]));
    expect(byId.get("go:support")?.statement).toMatch(/^Go 1\.26 is still supported/);
    expect(byId.get("go:support")?.confidence).toBe("inferred");
    expect(byId.get("macho:platform")?.statement).toBe(
      "It is built for macOS 26.0 or later, with the macOS 26.5 SDK.",
    );
    expect(byId.get("macho:libraries")?.statement).toBe("It links 2 libraries, all part of macOS.");
    expect(byId.get("signing")?.kind).toBe("signed-adhoc");
    expect(byId.has("rust:dependencies")).toBe(false);
    expect(byId.has("deps:none")).toBe(false);
  });

  it("names libraries from outside macOS, and a developer identity", () => {
    const out = run([
      go(null),
      rust(null),
      macho(["/usr/lib/libSystem.B.dylib", "@rpath/libggml.dylib"]),
      sig({
        ...ADHOC,
        team_identifier: "ABCDE12345",
        authorities: ["Developer ID Application: Example (ABCDE12345)"],
        hardened_runtime: true,
        timestamp: "2026-10-01",
      }),
    ]);
    const byId = new Map(out.findings.map((f) => [f.id, f]));
    expect(byId.get("macho:libraries")?.statement).toContain(
      "1 from elsewhere (@rpath/libggml.dylib)",
    );
    expect(byId.get("signing")?.statement).toContain("Team ID ABCDE12345");
    expect(byId.get("signing")?.statement).toContain(
      "The hardened runtime is on; it has a secure timestamp.",
    );
    expect(byId.get("deps:none")?.statement).toMatch(/^It embeds no dependency list/);
  });

  it("reads a cargo-auditable crate list, and fails plainly on one it cannot read", () => {
    const ok = run([
      go(null),
      rust({
        packages: [
          { name: "serde", version: "1.0.200" },
          { name: "anyhow", version: "1.0.80" },
        ],
      }),
    ]);
    expect(ok.findings.find((f) => f.id === "rust:dependencies")?.statement).toBe(
      "It embeds a Rust dependency list (cargo-auditable) of 2 crates.",
    );
    const odd = run([go(null), rust({ format: "something else" })]);
    expect(odd.rules.find((r) => r.id === "rust-dependencies")).toMatchObject({ status: "failed" });
  });

  it("does not run the Mach-O rules when those steps did not run", () => {
    const out = run([go(goInfo("go1.27.3")), rust(null)]);
    expect(out.rules.find((r) => r.id === "signing")?.status).toBe("not-run");
  });
});

describe("What's inside? verdict", () => {
  it("answers from the findings, and passes the validator", () => {
    const { findings } = run([
      go(goInfo("go1.25.4")),
      rust(null),
      macho(["/usr/lib/libSystem.B.dylib"]),
      sig({ ...ADHOC, signed: false }),
    ]);
    const body = whatsInsideVerdict(findings);
    expect(body.answer).toBe(
      "A Go 1.25.4 build of k8s.io/kubernetes v1.37.1 with 1 module dependency; that Go release is no longer supported; built for macOS 26.0 or later; not code-signed.",
    );
    expect(validateVerdict(body, findings)).toEqual({ ok: true });
  });

  it("says plainly when there is no dependency list", () => {
    const { findings } = run([go(null), rust(null)]);
    const body = whatsInsideVerdict(findings);
    expect(body.answer).toMatch(/^It embeds no dependency list/);
    expect(validateVerdict(body, findings)).toEqual({ ok: true });
  });
});

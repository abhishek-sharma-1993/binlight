import type { Finding } from "@binlight/shared";
import { describe, expect, it } from "vitest";
import { evidence } from "../jobs/fakes.js";
import { credentialValues } from "./credentials.js";
import { goBuildInfo } from "./go-build.js";
import { hardcodedHosts, hostsIn } from "./hosts.js";
import { runRules } from "./runner.js";
import type { Rule, RuleContext, StepResult, TargetInput } from "./types.js";

const EV = `ev_${"1".repeat(64)}`;

function stringsStep(values: string[], id = "strings"): StepResult {
  return {
    step: id,
    evidenceId: EV,
    result: evidence(
      "list_strings",
      values.map((value, i) => ({ address: `0x${(0x1000 + i).toString(16)}`, value })),
    ),
  };
}

function goStep(buildInfo: unknown): StepResult {
  return {
    step: "go",
    evidenceId: EV,
    result: evidence("inspect_go_binary", {
      format: "macho",
      architecture: "arm64",
      build_info: buildInfo,
    }),
  };
}

function target(steps: Record<string, StepResult>, index = 0): TargetInput {
  return {
    index,
    label: index === 0 ? "Binary" : "Other",
    preflight: null,
    steps: new Map(Object.entries(steps)),
  };
}

const ctx = (...targets: TargetInput[]): RuleContext => ({ targets });
const mod = (path: string, version: string, replacement: unknown = null) => ({
  path,
  version,
  sum: "",
  replacement,
});

const kubectlInfo = {
  go_version: "go1.26.8",
  module: {
    path: "k8s.io/kubernetes",
    main: mod("k8s.io/kubernetes", "v1.37.1"),
    dependencies: [
      mod("github.com/spf13/cobra", "v1.9.1"),
      mod("k8s.io/api", "v0.37.1", { path: "./staging/api" }),
    ],
    settings: [
      { key: "-buildmode", value: "exe" },
      { key: "CGO_ENABLED", value: "0" },
      { key: "-ldflags", value: "-s -w" },
    ],
    complete: true,
  },
};

describe("go-build-info", () => {
  it("reports toolchain, module, dependencies and notable settings, citing fields", () => {
    const { findings } = goBuildInfo.run(ctx(target({ go: goStep(kubectlInfo) })));
    const byKind = Object.fromEntries(findings.map((f) => [f.kind, f]));
    expect(byKind["go-toolchain"]?.statement).toBe("Built with Go 1.26.8.");
    expect(byKind["go-main-module"]?.statement).toBe(
      "Main module k8s.io/kubernetes at version v1.37.1.",
    );
    expect(byKind["go-dependencies"]).toMatchObject({
      statement: "It embeds 2 Go module dependencies.",
      data: {
        dependencies: [
          { path: "github.com/spf13/cobra", version: "v1.9.1" },
          { path: "k8s.io/api", version: "v0.37.1", replaced: true },
        ],
      },
    });
    expect(byKind["go-build-settings"]?.statement).toBe(
      "Build settings: CGO_ENABLED=0, -buildmode=exe.",
    );
    expect(byKind["go-toolchain"]?.evidence).toEqual([
      { evidenceId: EV, step: "go", locator: { field: "normalized_result.build_info.go_version" } },
    ]);
    expect(byKind["go-dirty-build"]).toBeUndefined();
  });

  it("flags a +dirty build as inferred, and a (devel) version honestly", () => {
    const dirty = {
      ...kubectlInfo,
      module: { ...kubectlInfo.module, main: mod("github.com/ollama/ollama", "v0.40.6+dirty") },
    };
    const devel = {
      ...kubectlInfo,
      module: { ...kubectlInfo.module, main: mod("binlight.invalid/hello", "(devel)") },
    };
    const d = goBuildInfo.run(ctx(target({ go: goStep(dirty) }))).findings;
    expect(d.find((f) => f.kind === "go-dirty-build")).toMatchObject({ confidence: "inferred" });
    const v = goBuildInfo.run(ctx(target({ go: goStep(devel) }))).findings;
    expect(v.find((f) => f.kind === "go-main-module")?.statement).toBe(
      'Main module binlight.invalid/hello, built without a release version ("(devel)").',
    );
  });

  it("says plainly when there is no Go build info, instead of an empty list", () => {
    const { findings } = goBuildInfo.run(ctx(target({ go: goStep(null) })));
    expect(findings).toEqual([
      expect.objectContaining({
        kind: "no-go-build-info",
        statement: "No Go build information is embedded in this binary.",
      }),
    ]);
  });

  it("suffixes ids per target when comparing two binaries", () => {
    const { findings } = goBuildInfo.run(
      ctx(target({ go: goStep(kubectlInfo) }, 0), target({ go: goStep(kubectlInfo) }, 1)),
    );
    expect(findings.map((f) => f.id)).toContain("go:toolchain@2");
    expect(findings.find((f) => f.id === "go:toolchain@2")?.target).toBe(1);
  });
});

describe("hostsIn (ported from the prototype)", () => {
  it("finds URLs glued to the text before them, as Go packs literals", () => {
    expect(hostsIn("NUMBER_IDhttps://docs.openclaw.ai/x").map((h) => h.host)).toEqual([
      "docs.openclaw.ai",
    ]);
  });

  it("keeps hostnames only, since paths swallow the next glued literal", () => {
    const hits = hostsIn("https://claude.ai/download/Claude.appcoworkhttp://Example.COM:8080/a");
    expect(hits.map((h) => h.host)).toEqual(["claude.ai", "example.com"]);
  });

  it("ignores schemes without a dotted hostname", () => {
    expect(hostsIn("http://localhost:11434 https:// http://")).toEqual([]);
  });
});

describe("hardcoded-hosts", () => {
  it("lists each hostname with up to 3 examples, address and snippet, and a summary", () => {
    const values = [
      "see https://kubernetes.io/docs/reference for more",
      "https://kubernetes.io/a",
      "https://kubernetes.io/b",
      "https://kubernetes.io/c",
      "NUMBER_IDhttps://registry.ollama.ai/v2/",
    ];
    const { findings } = hardcodedHosts.run(ctx(target({ strings: stringsStep(values) })));
    const k8s = findings.find((f) => f.id === "host:kubernetes.io") as Finding;
    expect(k8s.statement).toBe('"kubernetes.io" appears in 4 hard-coded URLs.');
    expect(k8s.evidence).toHaveLength(3);
    expect(k8s.evidence[0]?.locator).toEqual({
      address: "0x1000",
      snippet: "see https://kubernetes.io/docs/reference for more",
    });
    expect(k8s.caveats[0]).toMatch(/not proof that it is contacted/);
    const summary = findings.find((f) => f.kind === "hardcoded-hosts-summary") as Finding;
    expect(summary.statement).toBe(
      "2 distinct hostnames appear in hard-coded http(s) URLs in the string list.",
    );
    // Never "talks to only N servers".
    expect(summary.statement).not.toMatch(/only|talks to|contacts/i);
    expect(summary.caveats[0]).toMatch(/not the list of servers/);
  });

  it("states an empty result as an observation about the string list", () => {
    const { findings } = hardcodedHosts.run(
      ctx(target({ strings: stringsStep(["no urls here"]) })),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        statement: "No hostnames appear in hard-coded http(s) URLs in the string list.",
      }),
    ]);
  });
});

describe("credential-values", () => {
  const values = (out: { findings: Finding[] }) =>
    out.findings.filter((f) => f.kind === "credential-value");
  const summary = (out: { findings: Finding[] }) =>
    out.findings.find((f) => f.kind === "credential-values-summary");

  const key = "sk-ant-api03-" + "Q".repeat(40);

  it("reports a credential-shaped value truncated, and never reveals it in the snippet", () => {
    const out = credentialValues.run(ctx(target({ strings: stringsStep([`token=${key};`]) })));
    const findings = values(out);
    expect(findings).toHaveLength(1);
    // The whole value appears nowhere in the rule's output, summary included.
    expect(JSON.stringify(out)).not.toContain(key);
    const f = findings[0] as Finding;
    expect(f.statement).toBe(
      "A value shaped like a OpenAI/Anthropic-style API key is embedded: sk-ant-api03…",
    );
    expect(f.confidence).toBe("inferred");
    expect(JSON.stringify(f)).not.toContain(key);
    expect(f.evidence[0]?.locator?.snippet).toBe("token=sk-ant-api03…;");
  });

  it("suppresses AWS's documented example key, visibly and with the reason", () => {
    const out = credentialValues.run(
      ctx(target({ strings: stringsStep(["aws_access_key_id = AKIAIOSFODNN7EXAMPLE"]) })),
    );
    expect(values(out)).toEqual([]);
    expect(out.suppressed).toEqual([
      expect.objectContaining({
        text: "AKIAIOSFODNN…",
        reason: "AWS's documented example access key.",
      }),
    ]);
  });

  it("always adds a summary, so 'none found' is a citable observation", () => {
    const none = credentialValues.run(ctx(target({ strings: stringsStep(["nothing here"]) })));
    expect(summary(none)?.statement).toBe(
      "No credential-shaped values match the strict patterns in the string list.",
    );
    const ignored = credentialValues.run(
      ctx(target({ strings: stringsStep(["AKIAIOSFODNN7EXAMPLE", `ghp_${"c".repeat(36)}`]) })),
    );
    expect(summary(ignored)?.statement).toBe(
      "1 credential-shaped value matches the strict patterns in the string list (1 known false alarm ignored).",
    );
    expect(summary(ignored)?.data).toEqual({ found: 1, ignored: 1 });
  });

  it("does not flag kubectl's sample password or the SSH algorithm name (lessons-learned)", () => {
    const out = credentialValues.run(
      ctx(
        target({
          strings: stringsStep([
            "kubectl config set-credentials --password=uXFGweU9l35qcif",
            "sk-ecdsa-sha2-nistp256@openssh.com",
          ]),
        }),
      ),
    );
    expect(values(out)).toEqual([]);
  });

  it("ignores glued CLI flags that look like 'sk-…' (real text from Ollama 0.40.6)", () => {
    const flags = "PI_CONFIG_DIR--accept-risk--auth-choice--skip-health--skip-skillsopenclaw.json";
    const out = credentialValues.run(ctx(target({ strings: stringsStep([flags]) })));
    expect(values(out)).toEqual([]);
    expect(out.suppressed).toEqual([]);
  });

  it("suppresses OpenSSH security-key algorithm names, including the cert variant", () => {
    const blob =
      "ctest timer accessed from outside bubblesk-ecdsa-sha2-nistp256-cert-v01@openssh.comssh: inv";
    const out = credentialValues.run(ctx(target({ strings: stringsStep([blob]) })));
    expect(values(out)).toEqual([]);
    expect(out.suppressed).toEqual([
      expect.objectContaining({ reason: "An OpenSSH security-key algorithm name, not a key." }),
    ]);
  });

  it("treats credential names as names, not findings", () => {
    const out = credentialValues.run(
      ctx(
        target({ strings: stringsStep(["APIKey", "POOLSIDE_API_KEY=ollama", "tls.secret.key"]) }),
      ),
    );
    expect(values(out)).toEqual([]);
  });

  it("still finds a real key packed in the same string as a known sample", () => {
    const blob = `--password=uXFGweU9l35qcifghp_${"a".repeat(36)}`;
    const out = credentialValues.run(ctx(target({ strings: stringsStep([blob]) })));
    expect(values(out).map((f) => f.data?.["kind"])).toEqual(["GitHub token"]);
  });

  it("reports each distinct value once", () => {
    const out = credentialValues.run(ctx(target({ strings: stringsStep([key, key, `x${key}`]) })));
    expect(values(out)).toHaveLength(1);
  });
});

describe("runRules", () => {
  const labels = new Map([
    ["strings", "List strings"],
    ["go", "Read Go build info"],
  ]);
  const citing = (evidenceId: string): Rule => ({
    id: "citing",
    title: "Citing",
    needs: ["go"],
    run: () => ({
      findings: [
        {
          id: "x",
          rule: "citing",
          kind: "k",
          statement: "s",
          evidence: [{ evidenceId, step: "go" }],
          confidence: "observed",
          caveats: [],
        },
      ],
    }),
  });

  it("marks a rule not-run, with the step it lacked, rather than 'found nothing'", () => {
    const out = runRules([hardcodedHosts], ctx(target({ go: goStep(null) })), labels);
    expect(out.rules).toEqual([
      expect.objectContaining({
        id: "hardcoded-hosts",
        status: "not-run",
        reason: "Needs results that this job doesn't have: List strings.",
        findings: 0,
      }),
    ]);
    expect(out.findings).toEqual([]);
  });

  it("fails a rule whose finding cites evidence the job does not hold", () => {
    const out = runRules(
      [citing(`ev_${"9".repeat(64)}`)],
      ctx(target({ go: goStep(null) })),
      labels,
    );
    expect(out.rules[0]).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/did not produce/),
    });
    expect(out.findings).toEqual([]);
  });

  it("keeps other rules' findings when one rule throws", () => {
    const broken: Rule = {
      id: "broken",
      title: "Broken",
      needs: [],
      run: () => {
        throw new Error("bug");
      },
    };
    const out = runRules([broken, citing(EV)], ctx(target({ go: goStep(null) })), labels);
    expect(out.rules.map((r) => r.status)).toEqual(["failed", "ran"]);
    expect(out.findings.map((f) => f.id)).toEqual(["x"]);
  });

  it("does not run a two-target rule on one target when the other failed", () => {
    const out = runRules(
      [goBuildInfo],
      ctx(target({ go: goStep(kubectlInfo) }, 0), target({}, 1)),
      labels,
    );
    expect(out.rules[0]).toMatchObject({
      status: "not-run",
      reason: expect.stringContaining("Read Go build info (Other)"),
    });
  });
});

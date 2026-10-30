import Anthropic from "@anthropic-ai/sdk";
import type { Finding, Job, VerdictBody } from "@binlight/shared";
import { describe, expect, it } from "vitest";
import { rawAnalysisVerdict } from "../recipes/raw-analysis-verdict.js";
import { aiRequest, AiWriteError, claudeWriter } from "./ai.js";
import { assess } from "./assess.js";
import { numbersIn, validateVerdict } from "./validate.js";

const finding = (id: string, statement: string, data?: Record<string, unknown>): Finding => ({
  id,
  rule: "r",
  kind: id.split(":")[0] ?? "k",
  statement,
  evidence: [{ evidenceId: "ev_x", step: "s" }],
  confidence: "observed",
  caveats: [],
  ...(data && { data }),
});

/** Findings shaped like kubectl 1.37.1's (real numbers from the gate run). */
const kubectl: Finding[] = [
  finding("go:toolchain", "Built with Go 1.26.8.", { goVersion: "go1.26.8" }),
  finding("go:module", "Main module k8s.io/kubernetes at version v1.37.1.", {
    path: "k8s.io/kubernetes",
    version: "v1.37.1",
  }),
  finding("go:dependencies", "It embeds 88 Go module dependencies.", {
    dependencies: Array.from({ length: 88 }, (_, i) => ({ path: `m${i}`, version: "v1" })),
  }),
  finding(
    "hosts:summary",
    "14 distinct hostnames appear in hard-coded http(s) URLs in the string list.",
    { hosts: 14 },
  ),
  finding(
    "credentials:summary",
    "No credential-shaped values match the strict patterns in the string list.",
    { found: 0, ignored: 0 },
  ),
];

describe("numbersIn", () => {
  it("reads counts, thousands and versions as written", () => {
    expect(numbersIn("88,901 procedures in v1.37.1, Go 1.26.8, 14 hosts")).toEqual([
      "88901",
      "1.37.1",
      "1.26.8",
      "14",
    ]);
  });
});

describe("validateVerdict", () => {
  const ok: VerdictBody = {
    answer: "A Go 1.26.8 build of k8s.io/kubernetes v1.37.1 with 88 dependencies.",
    claims: [{ text: "It embeds 88 Go module dependencies.", findings: ["go:dependencies"] }],
  };

  it("accepts claims that cite real findings and only their numbers", () => {
    expect(validateVerdict(ok, kubectl)).toEqual({ ok: true });
  });

  it("rejects unknown finding ids and claims citing nothing", () => {
    const out = validateVerdict(
      {
        ...ok,
        claims: [
          { text: "Fine.", findings: ["go:made-up"] },
          { text: "Also fine.", findings: [] },
        ],
      },
      kubectl,
    );
    expect(out).toEqual({
      ok: false,
      reasons: [
        'Claim 1 cites "go:made-up", which is not a finding of this job.',
        "Claim 2 cites no finding.",
      ],
    });
  });

  it("rejects a number the cited findings don't contain, even if another finding does", () => {
    const out = validateVerdict(
      {
        ...ok,
        claims: [{ text: "It embeds 14 Go module dependencies.", findings: ["go:dependencies"] }],
      },
      kubectl,
    );
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reasons).toEqual([
      'Claim 1 states "14", which its findings do not contain.',
    ]);
  });

  it("rejects an invented number in the answer", () => {
    const out = validateVerdict({ ...ok, answer: "It contacts 3 servers." }, kubectl);
    expect(!out.ok && out.reasons[0]).toBe('The answer states "3", which no finding contains.');
  });

  it('refuses "only N servers", behaviour claims and safety judgements', () => {
    const cite = ["hosts:summary"];
    const bad = (text: string) =>
      validateVerdict({ answer: "x", claims: [{ text, findings: cite }] }, kubectl);
    expect(bad("It uses only 14 hostnames.").ok).toBe(false);
    expect(bad("It talks to 14 hosts.").ok).toBe(false);
    expect(bad("The binary is safe.").ok).toBe(false);
    // Honest, negated caveats are fine.
    expect(bad("This is not the list of servers it talks to.").ok).toBe(true);
  });
});

describe("raw-analysis rule-based verdict", () => {
  it("summarises kubectl's findings and passes its own validator", () => {
    const body = rawAnalysisVerdict(kubectl);
    expect(body.answer).toBe(
      "A Go 1.26.8 build of k8s.io/kubernetes v1.37.1 with 88 module dependencies; its string list shows 14 hostnames in hard-coded URLs and no credential-shaped values.",
    );
    expect(validateVerdict(body, kubectl)).toEqual({ ok: true });
    expect(body.claims.every((c) => c.findings.length > 0)).toBe(true);
  });

  it("is honest about a non-Go binary and about having no findings", () => {
    const none = [finding("go:none", "No Go build information is embedded in this binary.")];
    expect(rawAnalysisVerdict(none).answer).toBe("A binary with no Go build information.");
    expect(validateVerdict(rawAnalysisVerdict(none), none)).toEqual({ ok: true });
    expect(rawAnalysisVerdict([]).answer).toMatch(/no findings/);
  });
});

describe("assess", () => {
  const job = (over: Partial<Job>): Job => ({
    id: "j",
    recipe: { id: "r", title: "R", question: "?", targetLabels: ["Binary"] },
    targets: ["/x"],
    status: "done",
    createdAt: "",
    preflights: [null],
    steps: [],
    ...over,
  });

  it("is high when every step and rule ran", () => {
    expect(
      assess(job({ rules: [{ id: "a", title: "A", status: "ran", findings: 1 }] })).confidence,
    ).toBe("high");
  });

  it("is medium with each gap named when something could not run", () => {
    const out = assess(
      job({
        steps: [
          {
            id: "strings",
            label: "List strings",
            why: "w",
            target: 0,
            status: "failed",
            error: { code: "resource_constraint", message: "too big" },
          },
        ],
        rules: [
          { id: "a", title: "Go build information", status: "ran", findings: 3 },
          {
            id: "b",
            title: "Hostnames in hard-coded URLs",
            status: "not-run",
            reason: "Needs List strings.",
            findings: 0,
          },
        ],
      }),
    );
    expect(out.confidence).toBe("medium");
    expect(out.gaps).toEqual([
      "List strings: failed (resource_constraint: too big)",
      "Hostnames in hard-coded URLs: not run (Needs List strings.)",
    ]);
  });

  it("is low when no rule could run", () => {
    expect(
      assess(job({ rules: [{ id: "a", title: "A", status: "not-run", findings: 0 }] })).confidence,
    ).toBe("low");
  });
});

describe("claudeWriter (fake SDK client)", () => {
  const request = aiRequest(
    "Q?",
    "Raw analysis",
    { confidence: "high", gaps: [], rules: rawAnalysisVerdict(kubectl) },
    kubectl,
  );

  function fakeClient(reply: () => Promise<unknown>) {
    const calls: Record<string, unknown>[] = [];
    const client = {
      beta: {
        messages: {
          create: async (params: Record<string, unknown>) => {
            calls.push(params);
            return reply();
          },
        },
      },
    } as unknown as Anthropic;
    return { client, calls };
  }
  const message = (text: string, stop_reason = "end_turn", stop_details: unknown = null) => ({
    content: [{ type: "text", text }],
    stop_reason,
    stop_details,
  });

  it("sends findings' statements only, asks for JSON, and enables refusal fallbacks", async () => {
    const good: VerdictBody = {
      answer: "A Go 1.26.8 build.",
      claims: [{ text: "Built with Go 1.26.8.", findings: ["go:toolchain"] }],
    };
    const { client, calls } = fakeClient(async () => message(JSON.stringify(good)));
    const writer = claudeWriter({ client });
    expect(await writer.write(request)).toEqual(good);
    const params = calls[0] as {
      model: string;
      fallbacks: string;
      betas: string[];
      output_config: { effort: string; format: { type: string } };
      messages: { content: string }[];
    };
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.fallbacks).toBe("default");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params.output_config).toMatchObject({
      effort: "medium",
      format: { type: "json_schema" },
    });
    const sent = JSON.parse(params.messages[0]?.content ?? "{}") as { findings: object[] };
    expect(Object.keys(sent.findings[0] ?? {})).toEqual([
      "id",
      "statement",
      "confidence",
      "caveats",
    ]);
    // The same request again is answered from memory: no second API call.
    await writer.write(request);
    expect(calls).toHaveLength(1);
  });

  it("turns refusals, truncation and malformed output into plain reasons", async () => {
    const run = (reply: unknown) =>
      claudeWriter({ client: fakeClient(async () => reply).client }).write(request);
    await expect(
      run(message("", "refusal", { type: "refusal", category: "cyber" })),
    ).rejects.toThrow(new AiWriteError("Claude declined to write the verdict (cyber)."));
    await expect(run(message("{", "max_tokens"))).rejects.toThrow(/cut off/);
    await expect(run(message("not json"))).rejects.toThrow(/expected format/);
  });

  it("explains a client that isn't set up (no credentials) and points to the fix", async () => {
    const client = {
      beta: {
        messages: {
          create: async () => {
            throw new Anthropic.AnthropicError("Could not resolve authentication method.");
          },
        },
      },
    } as unknown as Anthropic;
    await expect(claudeWriter({ client }).write(request)).rejects.toThrow(
      /not set up .*Set ANTHROPIC_API_KEY to your own key/,
    );
  });

  it("explains API failures: a bad key, a timeout", async () => {
    const fail = (err: Error) =>
      claudeWriter({
        client: fakeClient(async () => {
          throw err;
        }).client,
      }).write(request);
    await expect(
      fail(new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", new Headers())),
    ).rejects.toThrow("The Claude API rejected the API key (401). Check ANTHROPIC_API_KEY.");
    await expect(fail(new Anthropic.APIConnectionTimeoutError())).rejects.toThrow(
      "Claude did not answer within 120 s.",
    );
  });
});

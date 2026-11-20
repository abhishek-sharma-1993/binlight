import { describe, expect, it } from "vitest";
import type { MultiCallResult } from "../jobs/steps.js";
import type {
  CredentialsData,
  NetworkData,
  UrlOccurrence,
  UrlsData,
} from "../recipes/phone-home-steps.js";
import { phoneHomeVerdict } from "../recipes/phone-home-verdict.js";
import { validateVerdict } from "../verdict/validate.js";
import { cleanHost, cleanHosts } from "./hostnames.js";
import { credentialBytes, destinations, networkCapability } from "./phone-home.js";
import { runRules } from "./runner.js";
import type { StepResult } from "./types.js";

const ev = (n: number) => `ev_${n.toString(16).padStart(64, "0")}`;
function multi<T>(id: string, data: T, ids: number[]): StepResult {
  const records = ids.map((i) => ({ evidence_id: ev(i) }));
  const result: MultiCallResult<T> = { operation: "search_bytes", multiCall: true, data, records };
  return { step: id, result, evidenceIds: new Set(records.map((r) => r.evidence_id)) };
}
const run = (steps: StepResult[]) =>
  runRules(
    [destinations, networkCapability, credentialBytes],
    {
      targets: [
        {
          index: 0,
          label: "Binary",
          preflight: null,
          steps: new Map(steps.map((s) => [s.step, s])),
        },
      ],
    },
    new Map(),
  );

describe("cleanHost", () => {
  it("cuts hostnames glued to the next literal back to a known top-level domain", () => {
    expect(cleanHost("ollama.compulling")).toEqual({
      host: "ollama.com",
      kind: "public",
      glued: "pulling",
    });
    expect(cleanHost("opencode.ainemotron-3-nano")).toMatchObject({
      host: "opencode.ai",
      glued: "nemotron-3-nano",
    });
    expect(cleanHost("code.visualstudio.comclaude").host).toBe("code.visualstudio.com");
    expect(cleanHost("kubernetes.io")).toEqual({ host: "kubernetes.io", kind: "public" });
  });

  it("classifies loopback, local, placeholder and odd hosts", () => {
    expect(cleanHost("127.0.0.1").kind).toBe("loopback");
    expect(cleanHost("localhost").kind).toBe("loopback");
    expect(cleanHost("1.2.3.4").kind).toBe("ip");
    expect(cleanHost("printer.local").kind).toBe("local-network");
    expect(cleanHost("example.invalid").kind).toBe("placeholder");
    expect(cleanHost("www.example.com").kind).toBe("placeholder");
    expect(cleanHost("issues.k8s").kind).toBe("unrecognised");
    expect(cleanHost("www.w3.org").kind).toBe("identifier");
  });

  it("maps a host cut short to the longer host in the same binary (kubectl)", () => {
    const m = cleanHosts([
      "htmlpreview.github",
      "htmlpreview.github.io",
      "issues.k8s",
      "issues.k8s.io",
      "ollama.compulling",
    ]);
    expect(m.get("htmlpreview.github")?.host).toBe("htmlpreview.github.io");
    expect(m.get("issues.k8s")?.host).toBe("issues.k8s.io");
    expect(m.get("ollama.compulling")?.host).toBe("ollama.com");
  });
});

// Shaped like Ollama's real results (20 Nov 2026), trimmed.
const occ = (
  address: string,
  text: string,
  search: number,
  read: number,
  uses: UrlOccurrence["uses"] = [],
): UrlOccurrence => ({
  address,
  segment: "__rodata",
  searchEvidenceId: ev(search),
  text,
  readEvidenceId: ev(read),
  uses,
});
const urls: UrlsData = {
  goNames: "read",
  truncated: false,
  occurrences: [
    occ("0x100b00000", "https://api.openai.com/v1https://chatgpt.com", 1, 2, [
      {
        from: "0x1004950fc",
        xrefsEvidenceId: ev(3),
        via: "direct",
        procedure: { address: "0x100495070", name: "FUN_100495070", evidenceId: ev(4) },
        go: {
          name: "github.com/ollama/ollama/internal/proxy.NewCodexDesktop",
          file: "github.com/ollama/ollama/internal/proxy/codex_desktop.go",
          line: 108,
          nameEvidenceId: ev(5),
        },
      },
    ]),
    occ("0x100b00100", "https://ollama.compulling manifest", 1, 6),
    occ("0x100b00200", "https://ollama.com/download", 1, 7),
    occ("0x100b00300", "http://127.0.0.1:11434", 8, 9, [
      {
        from: "0x100683370",
        xrefsEvidenceId: ev(10),
        via: "data-hop",
        dataAddress: "0x101000000",
        hopEvidenceId: ev(11),
        procedure: { address: "0x100683300", name: "FUN_100683300", evidenceId: ev(12) },
      },
    ]),
  ],
};
const network: NetworkData = {
  goNames: true,
  functions: [
    {
      name: "net/http.(*Client).Do",
      capability: "makes HTTP requests",
      searchEvidenceId: ev(20),
      found: { address: "0x101f00001", segment: "__gopclntab", evidenceId: ev(20) },
    },
    {
      name: "net/http.(*Server).Serve",
      capability: "serves HTTP",
      searchEvidenceId: ev(21),
      found: { address: "0x101f00101", segment: "__gopclntab", evidenceId: ev(21) },
    },
    {
      name: "google.golang.org/grpc.NewClient",
      capability: "makes gRPC calls",
      searchEvidenceId: ev(22),
    },
  ],
};
const TOKEN = `ghp_${"Q".repeat(36)}`;
const pad = "x".repeat(36);
const secrets: CredentialsData = {
  searched: 3,
  truncated: false,
  candidates: [
    {
      label: "GitHub token",
      address: "0x100c00000",
      searchEvidenceId: ev(30),
      text: `${pad}${TOKEN}${pad}`,
      valueStart: 36,
      valueEnd: 36 + TOKEN.length,
      readEvidenceId: ev(31),
    },
    {
      label: "OpenAI/Anthropic-style API key",
      address: "0x100c00100",
      searchEvidenceId: ev(30),
      text: `${pad}sk-ecdsa-sha2-nistp256-cert-v01@openssh.com${pad}`,
      valueStart: 36,
      valueEnd: 36 + 39,
      readEvidenceId: ev(32),
    },
  ],
};
const steps = () => [
  multi("urls", urls, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  multi("network", network, [20, 21, 22]),
  multi("secrets", secrets, [30, 31, 32]),
];

describe("phone-home rules", () => {
  it("names the function behind a used host, cites each call, and keeps the rest as text", () => {
    const out = run(steps());
    expect(out.rules.every((r) => r.status === "ran")).toBe(true);
    const byId = new Map(out.findings.map((f) => [f.id, f]));
    const openai = byId.get("dest:api.openai.com");
    expect(openai?.statement).toBe(
      '"api.openai.com" is used by code: github.com/ollama/ollama/internal/proxy.NewCodexDesktop (proxy/codex_desktop.go:108).',
    );
    // The URL's search page, then references, the function, and REA's reading of its name.
    expect(openai?.evidence.map((e) => e.evidenceId)).toEqual([ev(1), ev(3), ev(4), ev(5)]);
    expect(byId.get("dest:127.0.0.1")?.statement).toBe(
      '"127.0.0.1" (this machine (loopback)) is used by code: FUN_100683300.',
    );
    // Glued literals are cut ("ollama.compulling" → ollama.com) and counted once.
    const ollama = byId.get("dest:ollama.com");
    expect(ollama?.kind).toBe("destination-mentioned");
    expect(ollama?.statement).toBe(
      '"ollama.com" appears 2 times in text, with no code referring to it directly.',
    );
    expect(ollama?.caveats[1]).toContain('"…pulling"');
    // The URL ends where the next one begins: chatgpt.com is its own occurrence-less host.
    expect(byId.has("dest:api.openai.comhttps")).toBe(false);
    expect(byId.get("dest:summary")?.statement).toBe(
      "3 hosts appear in http(s):// URLs written into the binary; code refers to 2 of them.",
    );
  });

  it("reports linked network functions by capability", () => {
    const byId = new Map(run(steps()).findings.map((f) => [f.id, f]));
    const statements = [...byId.values()]
      .filter((f) => f.kind === "network-capability")
      .map((f) => f.statement);
    expect(statements).toEqual([
      "It makes HTTP requests: net/http.(*Client).Do is linked in.",
      "It serves HTTP: net/http.(*Server).Serve is linked in.",
    ]);
  });

  it("truncates credential values and suppresses known false alarms with the reason", () => {
    const out = run(steps());
    const values = out.findings.filter((f) => f.kind === "credential-value");
    expect(values).toHaveLength(1);
    expect(JSON.stringify(out.findings)).not.toContain(TOKEN);
    expect(values[0]?.statement).toBe(
      "A value shaped like a GitHub token is embedded: ghp_QQQQQQQQ…",
    );
    expect(out.suppressed).toHaveLength(1);
    expect(out.suppressed[0]?.reason).toMatch(/OpenSSH/);
  });

  it("writes a verdict from the findings that passes the validator", () => {
    const { findings } = run(steps());
    const body = phoneHomeVerdict(findings);
    expect(body.answer).toBe(
      "Code refers to 2 of the 3 hosts written into it, including api.openai.com, 127.0.0.1; the rest appear in text such as help messages and docs; it makes HTTP requests, serves HTTP; 1 key-shaped value needs a look by hand.",
    );
    expect(validateVerdict(body, findings)).toEqual({ ok: true });
  });
});

import Anthropic from "@anthropic-ai/sdk";
import type { VerdictBody } from "@binlight/shared";
import { describe, expect, it } from "vitest";
import type { AiState } from "../settings/ai-service.js";
import { aiRequest, claudeWriter, verdictPreview, type AiWriter } from "../verdict/index.js";
import { deps, dockerRoute, fakeSession } from "./fakes.js";
import { JobManager } from "./manager.js";

const body: VerdictBody = {
  answer: "A Go 1.27.2 program.",
  claims: [{ text: "It was built with Go 1.27.2.", findings: ["go:toolchain"] }],
};

function setup(initial: AiState | "writer") {
  const calls: unknown[] = [];
  const writer: AiWriter = {
    model: "claude-opus-5-5",
    write: async (request) => {
      calls.push(request);
      return body;
    },
  };
  let state: AiState = initial === "writer" ? { writer, ask: true } : initial;
  const provider = { current: async () => state };
  const jobs = new JobManager({ ...deps(fakeSession(dockerRoute)), ai: provider });
  return { jobs, calls, set: (s: AiState) => (state = s) };
}

const settledVerdict = async (jobs: JobManager, id: string, status: string) => {
  for (let i = 0; i < 100; i++) {
    const v = jobs.get(id)?.verdict;
    if (v?.ai.status === status) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  return jobs.get(id)?.verdict;
};

describe("asking before sending to Claude", () => {
  it("finishes the job and waits, showing exactly what would be sent", async () => {
    const { jobs, calls } = setup("writer");
    const job = await jobs.settled(jobs.create({ targets: ["/apps/tool"] }).id);
    expect(job?.status).toBe("done");
    const ai = job?.verdict?.ai;
    expect(ai?.status).toBe("awaiting-consent");
    expect(calls).toEqual([]);
    const request = JSON.parse(ai?.preview?.request ?? "{}") as { findings: { id: string }[] };
    expect(request.findings.map((f) => f.id)).toContain("go:toolchain");
    expect(ai?.preview?.system).toMatch(/verdict of a binary-analysis report/);
  });

  it("sends on consent and shows Claude's validated version", async () => {
    const { jobs, calls } = setup("writer");
    const { id } = jobs.create({ targets: ["/apps/tool"] });
    await jobs.settled(id);
    expect(await jobs.consent(id, true)).toBe(true);
    expect((await settledVerdict(jobs, id, "used"))?.ai).toMatchObject({ status: "used", body });
    expect(calls).toHaveLength(1);
    expect(await jobs.consent(id, true)).toBe(false);
  });

  it("sends nothing when declined", async () => {
    const { jobs, calls } = setup("writer");
    const { id } = jobs.create({ targets: ["/apps/tool"] });
    await jobs.settled(id);
    expect(await jobs.consent(id, false)).toBe(true);
    expect(jobs.get(id)?.verdict?.ai).toMatchObject({ status: "declined" });
    expect(calls).toEqual([]);
  });

  it("does not send if AI was switched off while the preview was open", async () => {
    const { jobs, calls, set } = setup("writer");
    const { id } = jobs.create({ targets: ["/apps/tool"] });
    await jobs.settled(id);
    set({ off: "AI is off (local-only mode)." });
    await jobs.consent(id, true);
    expect(jobs.get(id)?.verdict?.ai).toEqual({
      status: "failed",
      reason: "Not sent: AI is off (local-only mode).",
    });
    expect(calls).toEqual([]);
  });

  it("refuses consent for a job that is not waiting for it", async () => {
    const { jobs } = setup({ off: "AI is off." });
    const { id } = jobs.create({ targets: ["/apps/tool"] });
    await jobs.settled(id);
    expect(await jobs.consent(id, true)).toBe(false);
    expect(await jobs.consent("nope", true)).toBe(false);
  });
});

describe("the preview is what is sent", () => {
  it("matches the system prompt and message of the real API request byte for byte", async () => {
    const sent: { system: string; messages: { content: string }[] }[] = [];
    const client = {
      beta: {
        messages: {
          create: async (params: { system: string; messages: { content: string }[] }) => {
            sent.push(params);
            return {
              content: [{ type: "text", text: JSON.stringify(body) }],
              stop_reason: "end_turn",
            };
          },
        },
      },
    } as unknown as Anthropic;
    const request = aiRequest(
      "Q?",
      "Raw analysis",
      { confidence: "high", gaps: [], rules: body },
      [],
    );
    const preview = verdictPreview("claude-opus-5-5", request);
    await claudeWriter({ client }).write(request);
    expect(sent[0]?.system).toBe(preview.system);
    expect(sent[0]?.messages[0]?.content).toBe(preview.request);
  });
});

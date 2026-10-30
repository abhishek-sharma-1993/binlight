import type { VerdictBody } from "@binlight/shared";
import { describe, expect, it } from "vitest";
import { AiWriteError, type AiWriter } from "../verdict/index.js";
import { deps, dockerRoute, evidence, fakeSession } from "./fakes.js";
import { JobManager } from "./manager.js";

const writer = (write: AiWriter["write"]) => ({
  current: async () => ({ writer: { model: "claude-opus-5-5", write }, ask: false }),
});
const strings = async () =>
  evidence("list_strings", [{ address: "0x1", value: "https://kubernetes.io/docs" }]);

async function run(ai?: ReturnType<typeof writer>) {
  const jobs = new JobManager({
    ...deps(fakeSession(dockerRoute, { list_strings: strings })),
    ...(ai && { ai }),
  });
  return jobs.settled(jobs.create({ targets: ["/apps/tool"] }).id);
}

describe("verdicts in jobs", () => {
  it("always publishes the rule-based verdict; with AI off it says so", async () => {
    const job = await run();
    expect(job?.verdict?.rules.answer).toBe(
      "A Go 1.27.2 build of example.com/tool v1.0.0 with 2 module dependencies; its string list shows 1 hostname in hard-coded URLs and no credential-shaped values.",
    );
    expect(job?.verdict).toMatchObject({ confidence: "high", gaps: [], ai: { status: "off" } });
    expect(job?.status).toBe("done");
  });

  it("shows Claude's version when it passes validation", async () => {
    const body: VerdictBody = {
      answer: "This is a Go 1.27.2 program (example.com/tool v1.0.0).",
      claims: [{ text: "It was built with Go 1.27.2.", findings: ["go:toolchain"] }],
    };
    const job = await run(writer(async () => body));
    expect(job?.verdict?.ai).toEqual({ status: "used", model: "claude-opus-5-5", body });
  });

  it("keeps the rule-based verdict, with the reason, when Claude invents a number", async () => {
    const job = await run(
      writer(async () => ({
        answer: "It talks to 3 servers.",
        claims: [{ text: "x", findings: ["go:toolchain"] }],
      })),
    );
    expect(job?.verdict?.ai.status).toBe("rejected");
    expect(job?.verdict?.ai.reason).toMatch(
      /did not pass Binlight's checks.*"3", which no finding contains/,
    );
    expect(job?.verdict?.ai.body).toBeUndefined();
    expect(job?.status).toBe("done");
  });

  it("keeps the rule-based verdict, with the reason, when the API call fails", async () => {
    const job = await run(
      writer(async () => {
        throw new AiWriteError(
          "The Claude API rejected the API key (401). Check ANTHROPIC_API_KEY.",
        );
      }),
    );
    expect(job?.verdict?.ai).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("rejected the API key (401)"),
    });
  });
});

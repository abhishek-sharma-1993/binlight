import type { Verdict } from "@binlight/shared";
import { describe, expect, it } from "vitest";
import { verdictView } from "./verdictView.js";

const base: Verdict = {
  rules: { answer: "Rules answer.", claims: [{ text: "c", findings: ["f"] }] },
  confidence: "high",
  confidenceReason: "All ran.",
  gaps: [],
  ai: { status: "off", reason: "AI is off (local-only mode)." },
};

describe("verdictView", () => {
  it("shows Claude's version only when it was used", () => {
    const used = verdictView({
      ...base,
      ai: { status: "used", model: "claude-opus-5-5", body: { answer: "AI answer.", claims: [] } },
    });
    expect(used.body.answer).toBe("AI answer.");
    expect(used.alert).toBe(false);
  });

  it("falls back to the rules' version with the real reason when Claude's was rejected or failed", () => {
    for (const status of ["rejected", "failed"] as const) {
      const v = verdictView({ ...base, ai: { status, reason: 'Claim 1 states "3".' } });
      expect(v.body.answer).toBe("Rules answer.");
      expect(v.status).toBe('Claim 1 states "3".');
      expect(v.alert).toBe(true);
    }
  });

  it("says plainly when AI is off", () => {
    expect(verdictView(base).status).toBe("AI is off (local-only mode).");
  });
});

import type { Job, JobStep } from "@binlight/shared";
import { describe, expect, it } from "vitest";
import { applyEvent, MAX_LOG_LINES } from "./jobState.js";

const step = (over: Partial<JobStep>): JobStep => ({
  id: "overview",
  label: "Analyse (overview)",
  status: "pending",
  ...over,
});
const job = (steps: JobStep[]): Job => ({
  id: "j1",
  target: "/apps/tool",
  status: "running",
  createdAt: "2026-10-23T00:00:00.000Z",
  steps,
});

describe("applyEvent", () => {
  it("replaces state on snapshot, then applies step and job events", () => {
    let view = applyEvent({ logs: [] }, { type: "snapshot", job: job([step({})]) });
    view = applyEvent(view, { type: "step", step: step({ status: "running" }) });
    expect(view.job?.steps[0]?.status).toBe("running");
    view = applyEvent(view, { type: "job", status: "running", reaVersion: "6.7.0" });
    expect(view.job?.reaVersion).toBe("6.7.0");
    view = applyEvent(view, { type: "job", status: "done", endedAt: "2026-10-23T00:01:00.000Z" });
    expect(view.job).toMatchObject({
      status: "done",
      endedAt: "2026-10-23T00:01:00.000Z",
      reaVersion: "6.7.0",
    });
  });

  it("lets a reconnect's snapshot override stale local state", () => {
    let view = applyEvent(
      { logs: [] },
      { type: "snapshot", job: job([step({ status: "running" })]) },
    );
    view = applyEvent(view, { type: "snapshot", job: job([step({ status: "done" })]) });
    expect(view.job?.steps[0]?.status).toBe("done");
  });

  it("keeps a bounded log", () => {
    let view = { logs: [] as string[] };
    for (let i = 0; i < MAX_LOG_LINES + 10; i++)
      view = applyEvent(view, { type: "log", line: `l${i}` });
    expect(view.logs).toHaveLength(MAX_LOG_LINES);
    expect(view.logs.at(-1)).toBe(`l${MAX_LOG_LINES + 9}`);
  });

  it("ignores step events before any snapshot", () => {
    expect(applyEvent({ logs: [] }, { type: "step", step: step({}) }).job).toBeUndefined();
  });
});

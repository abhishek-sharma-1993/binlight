import type { JobEvent, JobStep } from "@binlight/shared";
import { describe, expect, it } from "vitest";
import { ReaProcessError, ReaToolError } from "../rea/errors.js";
import { deps, evidence, fakeSession, report, untilAborted } from "./fakes.js";
import { JobManager } from "./manager.js";

const byId = (steps: JobStep[]) => Object.fromEntries(steps.map((s) => [s.id, s]));

describe("JobManager", () => {
  it("runs every step in one REA session and reports counts and evidence", async () => {
    const fake = fakeSession({ route: "docker-ghidra", providerId: "ghidra" });
    const d = deps(fake);
    const jobs = new JobManager(d);
    const job = await jobs.settled(jobs.create("/apps/tool").id);

    expect(job?.status).toBe("done");
    expect(d.opened).toBe(1);
    expect(fake.calls).toEqual([
      "open_binary",
      "inspect_go_binary",
      "binary_overview",
      "list_strings",
      "list_procedures",
      "close_binary",
    ]);
    expect(fake.closed).toBeGreaterThanOrEqual(1);
    const s = byId(job?.steps ?? []);
    expect(s["go"]?.summary).toBe("go1.27.2 · example.com/tool v1.0.0 · 2 dependencies");
    expect(s["overview"]).toMatchObject({
      status: "done",
      counts: { segments: 19, procedures: 37246, strings: 97076 },
      evidenceId: expect.stringMatching(/^ev_/),
      hasResult: true,
    });
    expect(s["strings"]?.summary).toBe("1 strings");
    expect(s["procedures"]?.counts).toEqual({ procedures: 2 });
    expect(job?.steps.every((step) => step.elapsedMs !== undefined)).toBe(true);
    expect(await jobs.result(job?.id ?? "", "procedures")).toMatchObject({
      normalized_result: [{ value: "main" }, { value: "init" }],
    });
  });

  it("streams a snapshot, then step and job events in order", async () => {
    const jobs = new JobManager(
      deps(fakeSession({ route: "docker-ghidra", providerId: "ghidra" })),
    );
    const created = jobs.create("/apps/tool");
    const events: JobEvent[] = [];
    jobs.subscribe(created.id, (e) => events.push(e));
    await jobs.settled(created.id);

    expect(events[0]?.type).toBe("snapshot");
    const trail = events
      .filter((e) => e.type === "step")
      .map((e) => (e.type === "step" ? `${e.step.id}:${e.step.status}` : ""));
    expect(trail.slice(0, 4)).toEqual([
      "preflight:running",
      "preflight:done",
      "start:running",
      "start:done",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "job", status: "done", reaVersion: "6.7.0" });
    // The REA version is announced live as soon as REA starts.
    const firstWithVersion = events.findIndex((e) => e.type === "job" && e.reaVersion);
    const startDone = events.findIndex(
      (e) => e.type === "step" && e.step.id === "start" && e.step.status === "done",
    );
    expect(firstWithVersion).toBeGreaterThan(-1);
    expect(firstWithVersion).toBeLessThan(startDone);
  });

  it("skips deep steps with the reason when no deep route works, and still reads Go info", async () => {
    const fake = fakeSession(undefined);
    const pre = report({
      issues: [
        {
          severity: "limits",
          code: "no_deep_route",
          message: "No deep-analysis provider works on this machine.",
        },
      ],
    });
    delete pre.deep;
    const jobs = new JobManager(deps(fake, pre));
    const job = await jobs.settled(jobs.create("/apps/tool").id);

    expect(job?.status).toBe("done");
    expect(fake.calls).toEqual(["inspect_go_binary"]);
    const s = byId(job?.steps ?? []);
    for (const id of ["open", "overview", "strings", "procedures", "close"]) {
      expect(s[id]).toMatchObject({
        status: "skipped",
        reason: "No deep-analysis provider works on this machine.",
      });
      expect(s[id]?.counts).toBeUndefined();
    }
  });

  it("fails at preflight with the blocker's real reason and never starts REA", async () => {
    const fake = fakeSession(undefined);
    const d = deps(
      fake,
      report({
        canAnalyse: false,
        issues: [
          {
            severity: "blocker",
            code: "target_missing",
            message: "Cannot read /apps/tool: ENOENT",
            remediation: "Check the path.",
          },
        ],
      }),
    );
    const jobs = new JobManager(d);
    const job = await jobs.settled(jobs.create("/apps/tool").id);

    expect(job?.status).toBe("failed");
    expect(d.opened).toBe(0);
    expect(byId(job?.steps ?? [])["preflight"]?.error).toEqual({
      code: "target_missing",
      message: "Cannot read /apps/tool: ENOENT",
      remediation: "Check the path.",
    });
    expect(job?.steps.slice(1).every((s) => s.status === "skipped")).toBe(true);
  });

  it("shows REA's error for a failed analysis, skips dependent steps, still closes", async () => {
    const fake = fakeSession(
      { route: "docker-ghidra", providerId: "ghidra" },
      {
        binary_overview: async () => {
          throw new ReaToolError("binary_overview", {
            code: "execution_failure",
            message: "Analysis could not complete.",
            remediation: { action: "Run rea doctor." },
          });
        },
      },
    );
    const jobs = new JobManager(deps(fake));
    const job = await jobs.settled(jobs.create("/apps/tool").id);

    expect(job?.status).toBe("failed");
    const s = byId(job?.steps ?? []);
    expect(s["overview"]).toMatchObject({
      status: "failed",
      error: {
        code: "execution_failure",
        message: "Analysis could not complete.",
        remediation: "Run rea doctor.",
      },
    });
    expect(s["overview"]?.counts).toBeUndefined();
    expect(s["overview"]?.summary).toBeUndefined();
    expect(s["strings"]).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("overview"),
    });
    expect(fake.calls).not.toContain("list_strings");
    expect(fake.calls.at(-1)).toBe("close_binary");
  });

  it("says plainly when the binary is not Go", async () => {
    const fake = fakeSession(
      { route: "docker-ghidra", providerId: "ghidra" },
      {
        inspect_go_binary: async () =>
          evidence("inspect_go_binary", {
            format: "macho",
            architecture: "arm64",
            build_info: null,
          }),
      },
    );
    const jobs = new JobManager(deps(fake));
    const done = await jobs.settled(jobs.create("/apps/tool").id);
    expect(byId(done?.steps ?? [])["go"]).toMatchObject({
      status: "done",
      summary: "Not a Go binary (no Go build info).",
    });
  });

  it("fails loudly when REA's response no longer matches the schema", async () => {
    const fake = fakeSession(
      { route: "docker-ghidra", providerId: "ghidra" },
      { list_procedures: async () => evidence("list_procedures", { not: "a list" }) },
    );
    const jobs = new JobManager(deps(fake));
    const job = await jobs.settled(jobs.create("/apps/tool").id);
    expect(byId(job?.steps ?? [])["procedures"]).toMatchObject({
      status: "failed",
      error: { code: "unexpected_rea_response" },
    });
  });

  it("halts with the real reason when REA exits mid-job", async () => {
    const fake = fakeSession(
      { route: "docker-ghidra", providerId: "ghidra" },
      {
        binary_overview: async () => {
          throw new ReaProcessError("REA exited during binary_overview.", [
            "java.lang.OutOfMemoryError",
          ]);
        },
      },
    );
    const jobs = new JobManager(deps(fake));
    const job = await jobs.settled(jobs.create("/apps/tool").id);
    const s = byId(job?.steps ?? []);
    expect(s["overview"]?.error?.code).toBe("rea_exited");
    expect(s["overview"]?.error?.message).toContain("OutOfMemoryError");
    expect(s["overview"]?.error?.message).not.toContain("--help");
    expect(s["close"]).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("REA stopped"),
    });
    expect(fake.calls).not.toContain("close_binary");
  });

  it("cancels a running analysis: aborts the call, stops REA, marks the rest cancelled", async () => {
    const fake = fakeSession(
      { route: "docker-ghidra", providerId: "ghidra" },
      { binary_overview: untilAborted },
    );
    const jobs = new JobManager(deps(fake));
    const { id } = jobs.create("/apps/tool");
    await new Promise<void>((resolve) => {
      jobs.subscribe(id, (e) => {
        if (e.type === "step" && e.step.id === "overview" && e.step.status === "running") resolve();
      });
    });

    expect(await jobs.cancel(id)).toBe(true);
    const job = await jobs.settled(id);
    expect(job?.status).toBe("cancelled");
    const s = byId(job?.steps ?? []);
    expect(s["go"]?.status).toBe("done");
    expect(s["overview"]?.status).toBe("cancelled");
    expect(s["strings"]?.status).toBe("cancelled");
    expect(fake.closed).toBeGreaterThanOrEqual(1);
    expect(await jobs.cancel(id)).toBe(false);
  });

  it("queues jobs beyond the concurrency limit and can cancel a queued job", async () => {
    const slow = fakeSession(
      { route: "docker-ghidra", providerId: "ghidra" },
      { binary_overview: untilAborted },
    );
    const jobs = new JobManager(deps(slow));
    const first = jobs.create("/apps/one");
    const second = jobs.create("/apps/two");
    expect(jobs.get(second.id)?.status).toBe("queued");

    expect(await jobs.cancel(second.id)).toBe(true);
    expect(jobs.get(second.id)?.status).toBe("cancelled");
    expect(jobs.get(second.id)?.steps.every((s) => s.status === "cancelled")).toBe(true);

    await jobs.cancel(first.id);
    await jobs.settled(first.id);
  });

  it("sends heartbeats with the running step's elapsed time", async () => {
    const fake = fakeSession(
      { route: "docker-ghidra", providerId: "ghidra" },
      { binary_overview: untilAborted },
    );
    const jobs = new JobManager(deps(fake));
    const { id } = jobs.create("/apps/tool");
    const beat = await new Promise<JobEvent>((resolve) => {
      jobs.subscribe(id, (e) => {
        if (e.type === "heartbeat" && e.runningStep === "overview") resolve(e);
      });
    });
    expect(beat).toMatchObject({ type: "heartbeat", runningStep: "overview" });
    await jobs.cancel(id);
    await jobs.settled(id);
  });
});

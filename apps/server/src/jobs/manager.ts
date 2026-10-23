import { randomUUID } from "node:crypto";
import {
  JOB_STEPS,
  type Job,
  type JobEvent,
  type JobStatus,
  type JobStep,
  type PreflightReport,
  type RouteDecision,
  type StepId,
} from "@binlight/shared";
import type { CacheKey, EvidenceCache } from "../cache/evidence.js";
import type { CallOptions, ReaToolResult } from "../rea/client.js";
import type { ToolOutput } from "../rea/schemas.js";
import { PINNED_REA_VERSION } from "../rea/version.js";
import {
  goOutcome,
  listOutcome,
  overviewOutcome,
  parseResult,
  StepFailure,
  toStepError,
  type StepOutcome,
} from "./steps.js";

/** What a job needs from a REA session (a real ReaSession, or a fake in tests). */
export interface JobSession {
  rea: {
    version: string;
    callTool(
      name: string,
      args?: Record<string, unknown>,
      options?: CallOptions,
    ): Promise<ReaToolResult>;
  };
  deep?: Pick<RouteDecision, "route" | "providerId">;
  target: string;
  close(): Promise<void>;
}

export interface JobDeps {
  preflight(path: string): Promise<PreflightReport>;
  openSession(
    analysisPath: string,
    deep: RouteDecision | undefined,
    onLog: (line: string) => void,
  ): Promise<JobSession>;
  /** How often running jobs report elapsed time. */
  heartbeatMs?: number;
  /** Jobs analysed at once. Deep analysis is memory-heavy; default 1. */
  maxConcurrent?: number;
  /** Per-step REA call timeouts; the overview step is where the long analysis happens. */
  timeouts?: Partial<Record<StepId, number>>;
  /** Evidence cache; without one every job analyses from scratch and results stay in memory. */
  cache?: EvidenceCache;
  /** REA version results are cached under (the client refuses any other). */
  reaVersion?: string;
}

/** Steps whose REA results are cached, and how to rebuild their feed line from a result. */
const ANALYSIS_STEPS = ["go", "overview", "strings", "procedures"] as const;
type AnalysisStep = (typeof ANALYSIS_STEPS)[number];
const DEEP_STEPS = ["overview", "strings", "procedures"] as const;

const OUTCOMES: Record<AnalysisStep, (result: unknown) => StepOutcome> = {
  go: (r) => goOutcome(r as ToolOutput<"inspect_go_binary">),
  overview: (r) => overviewOutcome(r as ToolOutput<"binary_overview">),
  strings: (r) => listOutcome("strings", r as ToolOutput<"list_strings">),
  procedures: (r) => listOutcome("procedures", r as ToolOutput<"list_procedures">),
};

const TOOLS: Partial<Record<StepId, string>> = {
  open: "open_binary",
  go: "inspect_go_binary",
  overview: "binary_overview",
  strings: "list_strings",
  procedures: "list_procedures",
  close: "close_binary",
};

const DEFAULT_TIMEOUTS: Record<StepId, number> = {
  preflight: 5 * 60_000,
  start: 5 * 60_000,
  open: 30 * 60_000,
  go: 10 * 60_000,
  overview: 8 * 60 * 60_000,
  strings: 60 * 60_000,
  procedures: 60 * 60_000,
  close: 10 * 60_000,
};

const MAX_LOG_LINE = 500;

type Listener = (event: JobEvent) => void;

interface JobState {
  job: Job;
  abort: AbortController;
  listeners: Set<Listener>;
  /** Step results kept in memory (preflight, or everything when there is no cache). */
  results: Map<StepId, unknown>;
  /** Where cached step results live, so they are read from disk on request. */
  cacheKeys: Map<StepId, CacheKey>;
  session?: JobSession;
  /** REA stopped mid-job; later steps cannot run. */
  halted?: boolean;
}

/**
 * Runs analysis jobs: one REA session per job (open the binary once, then
 * every step reuses it), a FIFO queue, live events, and cancel. Jobs live in
 * memory for the server's lifetime, so a page reload reconnects to them.
 */
export class JobManager {
  private readonly jobs = new Map<string, JobState>();
  private readonly queue: string[] = [];
  private running = 0;
  private readonly timeouts: Record<StepId, number>;

  constructor(private readonly deps: JobDeps) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
  }

  create(target: string, options: { fresh?: boolean } = {}): Job {
    const job: Job = {
      id: randomUUID(),
      target,
      ...(options.fresh && { fresh: true }),
      status: "queued",
      createdAt: new Date().toISOString(),
      steps: JOB_STEPS.map((s) => ({
        id: s.id,
        label: s.label,
        ...(TOOLS[s.id] && { tool: TOOLS[s.id] }),
        status: "pending",
      })),
    };
    this.jobs.set(job.id, {
      job,
      abort: new AbortController(),
      listeners: new Set(),
      results: new Map(),
      cacheKeys: new Map(),
    });
    this.queue.push(job.id);
    // Start on the next tick, so the caller can subscribe before the first event.
    setImmediate(() => this.pump());
    return structuredClone(job);
  }

  get(id: string): Job | undefined {
    const state = this.jobs.get(id);
    return state && structuredClone(state.job);
  }

  list(): Job[] {
    return [...this.jobs.values()]
      .map((s) => structuredClone(s.job))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** The full REA result of a finished step, if it produced one. */
  async result(id: string, step: StepId): Promise<unknown> {
    const state = this.jobs.get(id);
    if (!state) return undefined;
    const key = state.cacheKeys.get(step);
    const tool = TOOLS[step];
    if (key && tool && this.deps.cache) {
      const read = await this.deps.cache.get(key, tool);
      if (read.hit) return read.entry.result;
    }
    return state.results.get(step);
  }

  /** Sends a snapshot now, then every event. Returns the unsubscribe function. */
  subscribe(id: string, listener: Listener): (() => void) | undefined {
    const state = this.jobs.get(id);
    if (!state) return undefined;
    listener({ type: "snapshot", job: structuredClone(state.job) });
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  /** Cancels a queued or running job. Running REA work is aborted and its process stopped. */
  async cancel(id: string): Promise<boolean> {
    const state = this.jobs.get(id);
    if (!state || isFinished(state.job.status)) return false;
    state.abort.abort();
    const queued = this.queue.indexOf(id);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.cancelRemaining(state);
      this.setStatus(state, "cancelled");
      return true;
    }
    // Stop REA now (kills the container); the job loop finishes the bookkeeping.
    await state.session?.close().catch(() => undefined);
    return true;
  }

  /** Waits for a job to finish (tests and CLI). */
  async settled(id: string): Promise<Job | undefined> {
    const state = this.jobs.get(id);
    if (!state) return undefined;
    if (isFinished(state.job.status)) return structuredClone(state.job);
    return new Promise((resolve) => {
      const off = this.subscribe(id, (e) => {
        if (e.type === "job" && isFinished(e.status)) {
          off?.();
          resolve(structuredClone(state.job));
        }
      });
    });
  }

  private pump(): void {
    const max = this.deps.maxConcurrent ?? 1;
    while (this.running < max && this.queue.length > 0) {
      const id = this.queue.shift();
      const state = id ? this.jobs.get(id) : undefined;
      if (!state) continue;
      this.running++;
      void this.run(state).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(state: JobState): Promise<void> {
    const { job } = state;
    job.startedAt = new Date().toISOString();
    this.setStatus(state, "running");
    const heartbeat = setInterval(() => this.heartbeat(state), this.deps.heartbeatMs ?? 5_000);

    try {
      const report = await this.step(state, "preflight", async () => {
        const r = await this.deps.preflight(job.target);
        job.preflight = r;
        const blocker = r.issues.find((i) => i.severity === "blocker");
        if (!r.canAnalyse || !r.analysisPath) {
          throw new StepFailure({
            code: blocker?.code ?? "cannot_analyse",
            message: blocker?.message ?? "Preflight found nothing Binlight can analyse.",
            ...(blocker?.remediation && { remediation: blocker.remediation }),
          });
        }
        const what = `${r.target.format} ${r.analysisArchitecture ?? ""}`.trim();
        return {
          summary: r.deep
            ? `${what}; deep analysis via ${r.deep.route}`
            : `${what}; no deep-analysis route on this machine`,
          result: r,
        };
      });
      if (!report.ok) return this.skipRemaining(state, "Preflight found a problem (see above).");
      const preflight = job.preflight as PreflightReport;
      const analysisPath = preflight.analysisPath as string;
      const deep = preflight.deep;
      const wanted: readonly AnalysisStep[] = deep ? ANALYSIS_STEPS : ["go"];

      // Cache first: each step is reused if this exact binary was analysed by the
      // same REA version and provider. REA starts only if something is missing.
      const cached = new Map<AnalysisStep, StepOutcome>();
      for (const id of wanted) {
        const key = this.cacheKey(preflight, id);
        if (!key) continue;
        state.cacheKeys.set(id, key);
        if (job.fresh || !this.deps.cache) continue;
        const read = await this.deps.cache.get(key, TOOLS[id] as string);
        if (read.hit) {
          cached.set(id, { ...OUTCOMES[id](read.entry.result), cachedAt: read.entry.cachedAt });
        } else if (read.reason) {
          this.emit(state, { type: "log", line: `cache ${id}: ${read.reason}` });
        }
      }
      const needsRea = wanted.some((id) => !cached.has(id));
      const needsOpen = deep !== undefined && DEEP_STEPS.some((id) => !cached.has(id));
      const fromCache = "Not needed: every result came from the evidence cache.";

      if (!needsRea) {
        job.reaVersion = this.reaVersion;
        this.skip(state, "start", fromCache);
      } else {
        const started = await this.step(state, "start", async () => {
          const session = await this.deps.openSession(analysisPath, deep, (line) =>
            this.emit(state, { type: "log", line: line.slice(0, MAX_LOG_LINE) }),
          );
          state.session = session;
          job.reaVersion = session.rea.version;
          return {
            summary: `REA ${session.rea.version}${session.deep ? ` (${session.deep.route})` : " (local, no deep provider)"}`,
          };
        });
        if (!started.ok) return this.skipRemaining(state, "REA did not start.");
      }
      const session = state.session;

      let opened = false;
      if (!deep) {
        const reason =
          preflight.issues.find((i) => i.code === "no_deep_route")?.message ??
          "No deep-analysis route.";
        for (const id of ["open", "overview", "strings", "procedures", "close"] as const) {
          this.skip(state, id, reason);
        }
      } else if (!needsOpen) {
        this.skip(state, "open", "Not needed: the analysis results came from the evidence cache.");
      } else if (session) {
        opened = (
          await this.step(state, "open", async () => {
            await this.call(state, "open", { path: session.target, provider_id: deep.providerId });
            return { summary: `Opened with ${deep.providerId}` };
          })
        ).ok;
      }
      if (this.stopped(state)) return;

      await this.analysisStep(state, "go", cached, () => ({ path: session?.target }));
      if (this.stopped(state)) return;

      if (deep) {
        let overviewOk = true;
        for (const id of DEEP_STEPS) {
          if (!cached.has(id) && !opened) {
            this.skip(state, id, "Opening the binary failed (see above).");
            continue;
          }
          if (!cached.has(id) && !overviewOk) {
            // A failed analysis re-runs (and fails again) on every later call.
            this.skip(state, id, "Skipped: the analysis failed at the overview step.");
            continue;
          }
          const ok = await this.analysisStep(state, id, cached, () => ({}));
          if (id === "overview") overviewOk = ok;
          if (this.stopped(state)) return;
        }
        if (opened) {
          await this.step(state, "close", async () => {
            await this.call(state, "close", {});
            return { summary: "Closed" };
          });
        } else if (!needsOpen) {
          this.skip(state, "close", "Not needed: nothing was opened.");
        } else {
          this.skip(state, "close", "Opening the binary failed (see above).");
        }
      }
    } finally {
      clearInterval(heartbeat);
      await state.session?.close().catch(() => undefined);
      if (state.abort.signal.aborted) this.cancelRemaining(state);
      const failed = job.steps.some((s) => s.status === "failed");
      job.endedAt = new Date().toISOString();
      this.setStatus(state, state.abort.signal.aborted ? "cancelled" : failed ? "failed" : "done");
    }
  }

  private get reaVersion(): string {
    return this.deps.reaVersion ?? PINNED_REA_VERSION;
  }

  /** Go build info doesn't depend on the deep provider, so it is keyed under "none". */
  private cacheKey(preflight: PreflightReport, id: AnalysisStep): CacheKey | undefined {
    if (!preflight.analysisSha256) return undefined;
    const provider = id === "go" ? "none" : preflight.deep?.providerId;
    if (!provider) return undefined;
    return { sha256: preflight.analysisSha256, reaVersion: this.reaVersion, provider };
  }

  /** Runs an analysis step from the cache, or live (then caches its result). */
  private async analysisStep(
    state: JobState,
    id: AnalysisStep,
    cached: Map<AnalysisStep, StepOutcome>,
    args: () => Record<string, unknown>,
  ): Promise<boolean> {
    const hit = cached.get(id);
    const { ok } = await this.step(state, id, async () => {
      if (hit) return hit;
      const outcome = OUTCOMES[id](await this.call(state, id, args()));
      const key = state.cacheKeys.get(id);
      if (key && this.deps.cache && outcome.result !== undefined) {
        await this.deps.cache
          .put(key, TOOLS[id] as string, outcome.result, state.job.id)
          .catch((err: unknown) =>
            this.emit(state, { type: "log", line: `cache ${id}: could not save: ${String(err)}` }),
          );
      }
      return outcome;
    });
    return ok;
  }

  /** Calls the step's REA tool and checks the result against Binlight's schema. */
  private async call(state: JobState, id: StepId, args: Record<string, unknown>): Promise<unknown> {
    const tool = TOOLS[id] as string;
    const session = state.session as JobSession;
    const { structured } = await session.rea.callTool(tool, args, {
      timeoutMs: this.timeouts[id],
      signal: state.abort.signal,
    });
    return parseResult(tool, structured);
  }

  private async step(
    state: JobState,
    id: StepId,
    work: () => Promise<StepOutcome>,
  ): Promise<{ ok: boolean }> {
    const step = this.findStep(state, id);
    const started = Date.now();
    step.status = "running";
    step.startedAt = new Date(started).toISOString();
    this.emitStep(state, step);
    try {
      const outcome = await work();
      if (state.abort.signal.aborted) throw new Error("cancelled");
      step.status = "done";
      step.summary = outcome.summary;
      if (outcome.counts) step.counts = outcome.counts;
      if (outcome.evidenceId) step.evidenceId = outcome.evidenceId;
      if (outcome.cachedAt) {
        step.cached = true;
        step.cachedAt = outcome.cachedAt;
      }
      if (outcome.result !== undefined) {
        // With a cache, analysis results are read back from disk on request.
        if (!(this.deps.cache && state.cacheKeys.has(id))) state.results.set(id, outcome.result);
        step.hasResult = true;
      }
      return { ok: true };
    } catch (err) {
      if (state.abort.signal.aborted) {
        step.status = "cancelled";
      } else {
        step.status = "failed";
        step.error = toStepError(err);
        if (step.error.code === "rea_exited") state.halted = true;
      }
      return { ok: false };
    } finally {
      step.endedAt = new Date().toISOString();
      step.elapsedMs = Date.now() - started;
      this.emitStep(state, step);
      if (state.halted) this.skipRemaining(state, "REA stopped (see the failed step).");
    }
  }

  private stopped(state: JobState): boolean {
    return state.abort.signal.aborted || state.halted === true;
  }

  private skip(state: JobState, id: StepId, reason: string): void {
    const step = this.findStep(state, id);
    if (step.status !== "pending") return;
    step.status = "skipped";
    step.reason = reason;
    this.emitStep(state, step);
  }

  private skipRemaining(state: JobState, reason: string): void {
    for (const step of state.job.steps) this.skip(state, step.id, reason);
  }

  private cancelRemaining(state: JobState): void {
    for (const step of state.job.steps) {
      if (step.status === "pending" || step.status === "running") {
        step.status = "cancelled";
        this.emitStep(state, step);
      }
    }
  }

  private heartbeat(state: JobState): void {
    const running = state.job.steps.find((s) => s.status === "running");
    this.emit(state, {
      type: "heartbeat",
      at: new Date().toISOString(),
      ...(running && {
        runningStep: running.id,
        elapsedMs: Date.now() - Date.parse(running.startedAt ?? ""),
      }),
    });
  }

  private setStatus(state: JobState, status: JobStatus): void {
    state.job.status = status;
    const { startedAt, endedAt } = state.job;
    this.emit(state, {
      type: "job",
      status,
      ...(startedAt && { startedAt }),
      ...(endedAt && { endedAt }),
    });
  }

  private findStep(state: JobState, id: StepId): JobStep {
    const step = state.job.steps.find((s) => s.id === id);
    if (!step) throw new Error(`unknown step ${id}`);
    return step;
  }

  private emitStep(state: JobState, step: JobStep): void {
    this.emit(state, { type: "step", step: structuredClone(step) });
  }

  private emit(state: JobState, event: JobEvent): void {
    for (const listener of state.listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener (closed connection) must not stop the job.
      }
    }
  }
}

function isFinished(status: JobStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

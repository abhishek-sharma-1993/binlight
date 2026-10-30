import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
  Job,
  JobEvent,
  JobStatus,
  JobStep,
  PreflightReport,
  RouteDecision,
  StepId,
} from "@binlight/shared";
import { argsVariant, type CacheKey, type EvidenceCache } from "../cache/evidence.js";
import type { CallOptions, ReaToolResult } from "../rea/client.js";
import { PINNED_REA_VERSION } from "../rea/version.js";
import {
  DEFAULT_RECIPE_ID,
  RECIPES,
  stepsFor,
  type Recipe,
  type RecipeStep,
} from "../recipes/index.js";
import { runRules } from "../rules/runner.js";
import { aiRequest, assess, validateVerdict, type AiWriter } from "../verdict/index.js";
import type { StepResult, TargetInput } from "../rules/types.js";
import { parseResult, StepFailure, toStepError, type StepOutcome } from "./steps.js";

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
  /** Recipes this manager runs. Default: the server's recipe list. */
  recipes?: Recipe[];
  /** How often running jobs report elapsed time. */
  heartbeatMs?: number;
  /** Jobs analysed at once. Deep analysis is memory-heavy; default 1. */
  maxConcurrent?: number;
  /** REA call timeouts by kind of step. */
  timeouts?: Partial<Timeouts>;
  /** Evidence cache; without one every job analyses from scratch and results stay in memory. */
  cache?: EvidenceCache;
  /** REA version results are cached under (the client refuses any other). */
  reaVersion?: string;
  /** Claude rewrites verdicts when set; otherwise local-only (rule-based verdicts). */
  ai?: AiWriter;
}

export interface CreateJob {
  /** Recipe id; default raw analysis. */
  recipe?: string;
  /** One path per recipe target. */
  targets: string[];
  fresh?: boolean;
}

/** A request the manager refuses (unknown recipe, wrong number of targets). */
export class JobRequestError extends Error {}

interface Timeouts {
  system: number;
  /** Provider-free REA tools, e.g. inspect_go_binary. */
  light: number;
  /**
   * REA analyses lazily: whichever deep step runs first after open_binary
   * carries the whole disassembler analysis (minutes to hours under emulation).
   */
  deep: number;
}

const DEFAULT_TIMEOUTS: Timeouts = {
  system: 5 * 60_000,
  light: 10 * 60_000,
  deep: 12 * 60 * 60_000,
};

const MAX_LOG_LINE = 500;
const FROM_CACHE = "Not needed: every result came from the evidence cache.";

type Listener = (event: JobEvent) => void;

interface CacheRef {
  key: CacheKey;
  tool: string;
  variant: string;
}

interface JobState {
  job: Job;
  recipe: Recipe;
  abort: AbortController;
  listeners: Set<Listener>;
  /** Step results kept in memory (preflight, or everything when there is no cache). */
  results: Map<StepId, unknown>;
  /** Where cached step results live, so they are read from disk on request. */
  cacheRefs: Map<StepId, CacheRef>;
  /** The REA session of the target being analysed. */
  session?: JobSession;
  /** REA stopped mid-target; that target's later steps cannot run. */
  halted?: boolean;
}

/** A step id, suffixed with the target number when a recipe takes two targets. */
export function stepId(base: string, target: number, targets: number): StepId {
  return targets > 1 ? `${base}@${target + 1}` : base;
}

/**
 * Runs recipe jobs: per target, one REA session (open the binary once, then
 * every step reuses it), cache first, a FIFO queue, live events, and cancel.
 * Jobs live in memory for the server's lifetime, so a page reload reconnects.
 */
export class JobManager {
  private readonly jobs = new Map<string, JobState>();
  private readonly queue: string[] = [];
  private running = 0;
  private readonly timeouts: Timeouts;
  private readonly recipes: Map<string, Recipe>;

  constructor(private readonly deps: JobDeps) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
    this.recipes = new Map((deps.recipes ?? RECIPES).map((r) => [r.id, r]));
  }

  create(request: CreateJob): Job {
    const recipe = this.recipes.get(request.recipe ?? DEFAULT_RECIPE_ID);
    if (!recipe) throw new JobRequestError(`No recipe "${request.recipe}".`);
    const targets = request.targets.map((t) => t.trim());
    if (targets.length !== recipe.targets || targets.some((t) => !t)) {
      throw new JobRequestError(
        `"${recipe.title}" needs ${recipe.targets} target${recipe.targets > 1 ? "s" : ""}: ${recipe.targetLabels.join(", ")}.`,
      );
    }

    const job: Job = {
      id: randomUUID(),
      recipe: {
        id: recipe.id,
        title: recipe.title,
        question: recipe.question,
        targetLabels: recipe.targetLabels,
      },
      targets,
      ...(request.fresh && { fresh: true }),
      status: "queued",
      createdAt: new Date().toISOString(),
      preflights: targets.map(() => null),
      steps: planSteps(recipe, targets),
    };
    this.jobs.set(job.id, {
      job,
      recipe,
      abort: new AbortController(),
      listeners: new Set(),
      results: new Map(),
      cacheRefs: new Map(),
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
    const ref = state.cacheRefs.get(step);
    if (ref && this.deps.cache) {
      const read = await this.deps.cache.get(ref.key, ref.tool, ref.variant);
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
      for (let t = 0; t < job.targets.length; t++) {
        try {
          await this.runTarget(state, t);
        } finally {
          await state.session?.close().catch(() => undefined);
          delete state.session;
          state.halted = false;
        }
        if (state.abort.signal.aborted) break;
      }
      if (!state.abort.signal.aborted) await this.runFindings(state);
      if (!state.abort.signal.aborted) await this.runVerdict(state);
    } finally {
      clearInterval(heartbeat);
      if (state.abort.signal.aborted) this.cancelRemaining(state);
      const failed =
        job.steps.some((s) => s.status === "failed") ||
        (job.rules ?? []).some((r) => r.status === "failed");
      job.endedAt = new Date().toISOString();
      this.setStatus(state, state.abort.signal.aborted ? "cancelled" : failed ? "failed" : "done");
    }
  }

  /** Preflight, then the recipe's steps for one target in one REA session. */
  private async runTarget(state: JobState, t: number): Promise<void> {
    const { job, recipe } = state;
    const n = job.targets.length;
    const id = (base: string) => stepId(base, t, n);
    const target = job.targets[t] as string;

    const pre = await this.step(state, id("preflight"), async () => {
      const r = await this.deps.preflight(target);
      job.preflights[t] = r;
      this.setStatus(state, "running");
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
    if (!pre.ok) return this.skipTarget(state, t, "Preflight found a problem (see above).");
    const report = job.preflights[t] as PreflightReport;
    const deep = report.deep;
    const recipeSteps = stepsFor(recipe, t);
    const noDeepReason =
      report.issues.find((i) => i.code === "no_deep_route")?.message ?? "No deep-analysis route.";

    // Cache first: a step is reused if this exact binary was analysed by the same
    // REA version and provider with the same arguments.
    const cached = new Map<string, StepOutcome>();
    for (const rs of recipeSteps) {
      if (rs.deep && !deep) continue;
      const key = this.cacheKey(report, rs);
      if (!key) continue;
      const ref = { key, tool: rs.tool, variant: argsVariant(rs.args?.("") ?? {}) };
      state.cacheRefs.set(id(rs.id), ref);
      if (job.fresh || !this.deps.cache) continue;
      const read = await this.deps.cache.get(ref.key, ref.tool, ref.variant);
      if (read.hit) {
        cached.set(rs.id, { ...rs.outcome(read.entry.result), cachedAt: read.entry.cachedAt });
      } else if (read.reason) {
        this.emit(state, { type: "log", line: `cache ${id(rs.id)}: ${read.reason}` });
      }
    }
    const live = recipeSteps.filter((rs) => !(rs.deep && !deep) && !cached.has(rs.id));
    const needsOpen = live.some((rs) => rs.deep);
    const hasDeepSteps = recipeSteps.some((rs) => rs.deep);

    if (live.length === 0) {
      job.reaVersion = this.reaVersion;
      this.setStatus(state, "running");
      this.skip(state, id("start"), FROM_CACHE);
    } else {
      const started = await this.step(state, id("start"), async () => {
        // Provider-free steps only: local REA, no disassembler or container.
        const route = needsOpen ? deep : undefined;
        const session = await this.deps.openSession(report.analysisPath as string, route, (line) =>
          this.emit(state, { type: "log", line: line.slice(0, MAX_LOG_LINE) }),
        );
        state.session = session;
        job.reaVersion = session.rea.version;
        this.setStatus(state, "running");
        return {
          summary: `REA ${session.rea.version}${session.deep ? ` (${session.deep.route})` : " (local, no deep provider)"}`,
        };
      });
      if (!started.ok) return this.skipTarget(state, t, "REA did not start.");
    }
    const session = state.session;

    let opened = false;
    if (hasDeepSteps) {
      if (!deep) this.skip(state, id("open"), noDeepReason);
      else if (!needsOpen) this.skip(state, id("open"), FROM_CACHE);
      else if (session) {
        opened = (
          await this.step(state, id("open"), async () => {
            await this.call(state, id("open"), "open_binary", this.timeouts.deep, {
              path: session.target,
              provider_id: deep.providerId,
            });
            return { summary: `Opened with ${deep.providerId}` };
          })
        ).ok;
      }
    }
    if (this.stopped(state)) return;

    // The first live deep call carries the whole analysis; if it fails, later
    // deep calls would re-run it and fail the same way.
    let analysisFailed: string | undefined;
    let analysisTried = false;
    for (const rs of recipeSteps) {
      const sid = id(rs.id);
      const hit = cached.get(rs.id);
      if (rs.deep && !deep) {
        this.skip(state, sid, noDeepReason);
        continue;
      }
      if (!hit && rs.deep && !opened) {
        this.skip(state, sid, "Opening the binary failed (see above).");
        continue;
      }
      if (!hit && rs.deep && analysisFailed) {
        this.skip(state, sid, `Skipped: the analysis failed at "${analysisFailed}".`);
        continue;
      }
      const carriesAnalysis = !hit && rs.deep && !analysisTried;
      if (carriesAnalysis) analysisTried = true;
      const { ok } = await this.step(state, sid, async () => {
        if (hit) return hit;
        const args = rs.args?.(session?.target ?? "") ?? {};
        const result = await this.call(
          state,
          sid,
          rs.tool,
          rs.deep ? this.timeouts.deep : this.timeouts.light,
          args,
        );
        const outcome = rs.outcome(result);
        await this.save(state, sid, outcome);
        return outcome;
      });
      if (!ok && carriesAnalysis) analysisFailed = rs.label;
      if (this.stopped(state)) return;
    }

    if (hasDeepSteps) {
      if (opened) {
        await this.step(state, id("close"), async () => {
          await this.call(state, id("close"), "close_binary", this.timeouts.light, {});
          return { summary: "Closed" };
        });
      } else {
        this.skip(
          state,
          id("close"),
          !deep
            ? noDeepReason
            : needsOpen
              ? "Opening the binary failed (see above)."
              : "Not needed: nothing was opened.",
        );
      }
    }
  }

  /** Runs the recipe's rules over the steps that succeeded, then publishes the findings. */
  private async runFindings(state: JobState): Promise<void> {
    const { job, recipe } = state;
    if (recipe.rules.length === 0) return;
    const n = job.targets.length;
    const targets: TargetInput[] = [];
    for (let t = 0; t < n; t++) {
      const steps = new Map<string, StepResult>();
      for (const rs of stepsFor(recipe, t)) {
        const sid = stepId(rs.id, t, n);
        const step = job.steps.find((s) => s.id === sid);
        if (step?.status !== "done") continue;
        const result = await this.result(job.id, sid);
        if (result === undefined) continue;
        steps.set(rs.id, {
          step: sid,
          result,
          ...(step.evidenceId && { evidenceId: step.evidenceId }),
        });
      }
      targets.push({
        index: t,
        label: recipe.targetLabels[t] ?? `Target ${t + 1}`,
        preflight: job.preflights[t] ?? null,
        steps,
      });
    }
    const labels = new Map(recipe.steps.map((s) => [s.id, s.label]));
    const out = runRules(recipe.rules, { targets }, labels);
    job.findings = out.findings;
    job.suppressed = out.suppressed;
    job.rules = out.rules;
    this.emit(state, {
      type: "findings",
      findings: structuredClone(out.findings),
      suppressed: structuredClone(out.suppressed),
      rules: structuredClone(out.rules),
    });
  }

  /**
   * The rule-based verdict first (always), then Claude's rewrite if AI is on.
   * The rewrite is shown only if it passes the same validation; otherwise the
   * rule-based verdict stays, with the reason.
   */
  private async runVerdict(state: JobState): Promise<void> {
    const { job, recipe } = state;
    if (!recipe.verdict || !job.findings || !job.rules) return;
    const findings = job.findings;
    const rules = recipe.verdict(findings);
    const ai = this.deps.ai;
    job.verdict = {
      rules,
      ...assess(job),
      ai: ai
        ? { status: "running", model: ai.model }
        : {
            status: "off",
            reason: "AI is off (local-only mode): this verdict comes from Binlight's rules alone.",
          },
    };
    this.emit(state, { type: "verdict", verdict: structuredClone(job.verdict) });
    if (!ai) return;

    const verdict = job.verdict;
    try {
      const body = await ai.write(
        aiRequest(recipe.question, recipe.title, verdict, findings),
        state.abort.signal,
      );
      const check = validateVerdict(body, findings);
      verdict.ai = check.ok
        ? { status: "used", model: ai.model, body }
        : {
            status: "rejected",
            model: ai.model,
            reason: `Claude's version did not pass Binlight's checks, so the rule-based verdict is shown: ${check.reasons.join(" ")}`,
          };
    } catch (err) {
      if (state.abort.signal.aborted) return;
      verdict.ai = {
        status: "failed",
        model: ai.model,
        reason: `Claude could not write the verdict, so the rule-based verdict is shown: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    this.emit(state, { type: "verdict", verdict: structuredClone(verdict) });
  }

  private get reaVersion(): string {
    return this.deps.reaVersion ?? PINNED_REA_VERSION;
  }

  /** Provider-free tools don't depend on the deep provider, so they are keyed under "none". */
  private cacheKey(report: PreflightReport, rs: RecipeStep): CacheKey | undefined {
    if (!report.analysisSha256) return undefined;
    const provider = rs.deep ? report.deep?.providerId : "none";
    if (!provider) return undefined;
    return { sha256: report.analysisSha256, reaVersion: this.reaVersion, provider };
  }

  private async save(state: JobState, sid: StepId, outcome: StepOutcome): Promise<void> {
    const ref = state.cacheRefs.get(sid);
    if (!ref || !this.deps.cache || outcome.result === undefined) return;
    await this.deps.cache
      .put(ref.key, ref.tool, outcome.result, state.job.id, ref.variant)
      .catch((err: unknown) =>
        this.emit(state, { type: "log", line: `cache ${sid}: could not save: ${String(err)}` }),
      );
  }

  /** Calls a REA tool and checks the result against Binlight's schema. */
  private async call(
    state: JobState,
    sid: StepId,
    tool: string,
    timeoutMs: number,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const session = state.session;
    if (!session) throw new Error(`No REA session for step ${sid}.`);
    const { structured } = await session.rea.callTool(tool, args, {
      timeoutMs,
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
        if (!(this.deps.cache && state.cacheRefs.has(id))) state.results.set(id, outcome.result);
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
      if (state.halted) this.skipTarget(state, step.target, "REA stopped (see the failed step).");
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

  private skipTarget(state: JobState, target: number, reason: string): void {
    for (const step of state.job.steps) {
      if (step.target === target) this.skip(state, step.id, reason);
    }
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
    const { startedAt, endedAt, reaVersion, preflights } = state.job;
    this.emit(state, {
      type: "job",
      status,
      ...(startedAt && { startedAt }),
      ...(endedAt && { endedAt }),
      ...(reaVersion && { reaVersion }),
      preflights: structuredClone(preflights),
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

/** Every step of a job, target by target: system steps around the recipe's. */
function planSteps(recipe: Recipe, targets: string[]): JobStep[] {
  const n = targets.length;
  const steps: JobStep[] = [];
  for (let t = 0; t < n; t++) {
    const id = (base: string) => stepId(base, t, n);
    const suffix = n > 1 ? ` (${recipe.targetLabels[t]}: ${basename(targets[t] ?? "")})` : "";
    const own = stepsFor(recipe, t);
    const deep = own.some((s) => s.deep);
    const system = (base: string, label: string, tool?: string): JobStep => ({
      id: id(base),
      label: label + suffix,
      target: t,
      ...(tool && { tool }),
      status: "pending",
    });
    steps.push(system("preflight", "Check the target and this machine"));
    steps.push(system("start", "Start REA"));
    if (deep) steps.push(system("open", "Open the binary", "open_binary"));
    for (const rs of own) {
      steps.push({
        id: id(rs.id),
        label: rs.label + suffix,
        why: rs.why,
        target: t,
        tool: rs.tool,
        status: "pending",
      });
    }
    if (deep) steps.push(system("close", "Close the binary", "close_binary"));
  }
  return steps;
}

function isFinished(status: JobStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

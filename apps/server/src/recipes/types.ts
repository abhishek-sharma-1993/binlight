import type { Finding, RecipeInfo, TargetFormat, VerdictBody } from "@binlight/shared";
import type { StepOutcome } from "../jobs/steps.js";
import type { Rule } from "../rules/types.js";

/** What a many-call step gets: schema-checked REA calls on the open binary. */
export interface StepContext {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** The target path as REA sees it. */
  target: string;
  /** The analysed file on this machine (e.g. for reading Go's function table). */
  hostPath: string;
  /** A line for the job's REA log. */
  log(line: string): void;
}

/** One REA call a recipe makes against one target. */
export interface RecipeStep {
  /** Unique within the recipe; also the step id in single-target jobs. */
  id: string;
  /** What the step does, in plain words. */
  label: string;
  /** Why the recipe needs it, in plain words. */
  why: string;
  tool: string;
  /**
   * Needs a disassembler: runs only on a deep-analysis route, after
   * `open_binary`. Provider-free tools (e.g. `inspect_go_binary`) set false.
   */
  deep: boolean;
  /**
   * Works on the open binary (e.g. `inspect_macho`), without needing a
   * disassembler: the binary is opened with no provider. Deep steps open too.
   */
  opens?: boolean;
  /** File formats it applies to; on others it is skipped with that reason. Default: all. */
  formats?: TargetFormat[];
  /**
   * For a step that needs many REA calls (e.g. one per URL): runs them through
   * `ctx.call`. Every evidence record those calls return is kept in the
   * step's result, so findings can cite any of them. `tool` then names the
   * step's main tool, for display and the cache. `args` is not used.
   */
  run?: (ctx: StepContext) => Promise<unknown>;
  /** For a `run` step: bump when its logic changes, so cached results aren't reused. */
  version?: number;
  /** Arguments, given the target path as REA sees it. Default: none. */
  args?: (target: string) => Record<string, unknown>;
  /** Turns the (schema-checked) REA result into the feed line and counts. */
  outcome: (result: unknown) => StepOutcome;
  /** Targets (0-based) it runs on. Default: every target. */
  targets?: number[];
}

export interface Recipe {
  id: string;
  title: string;
  question: string;
  description: string;
  targets: 1 | 2;
  targetLabels: string[];
  steps: RecipeStep[];
  /** Turn the steps' results into findings, after the last step. */
  rules: Rule[];
  /**
   * The rule-based verdict: a short answer and claims that cite findings.
   * Must use only what the findings state (the same validator checks it).
   */
  verdict?: (findings: Finding[]) => VerdictBody;
}

export function recipeInfo(recipe: Recipe): RecipeInfo {
  return {
    id: recipe.id,
    title: recipe.title,
    question: recipe.question,
    description: recipe.description,
    targets: recipe.targets,
    targetLabels: recipe.targetLabels,
    needsDeep: recipe.steps.some((s) => s.deep),
    steps: recipe.steps.map(({ id, label, why, tool, deep }) => ({ id, label, why, tool, deep })),
    rules: recipe.rules.map(({ id, title }) => ({ id, title })),
  };
}

/** The recipe's steps for one target, in order. */
export function stepsFor(recipe: Recipe, target: number): RecipeStep[] {
  return recipe.steps.filter((s) => !s.targets || s.targets.includes(target));
}

/** Checks a recipe definition; throws on mistakes a test should catch. */
export function validateRecipe(recipe: Recipe): void {
  const ids = new Set<string>();
  const reserved = new Set(["preflight", "start", "open", "close"]);
  if (recipe.targetLabels.length !== recipe.targets) {
    throw new Error(`${recipe.id}: needs one target label per target`);
  }
  for (const step of recipe.steps) {
    if (!/^[a-z][a-z0-9-]*$/.test(step.id)) throw new Error(`${recipe.id}: bad step id ${step.id}`);
    if (reserved.has(step.id)) throw new Error(`${recipe.id}: step id ${step.id} is reserved`);
    if (ids.has(step.id)) throw new Error(`${recipe.id}: duplicate step id ${step.id}`);
    ids.add(step.id);
    for (const t of step.targets ?? []) {
      if (t < 0 || t >= recipe.targets) throw new Error(`${recipe.id}/${step.id}: no target ${t}`);
    }
  }
  for (let t = 0; t < recipe.targets; t++) {
    if (stepsFor(recipe, t).length === 0) throw new Error(`${recipe.id}: target ${t} has no steps`);
  }
  const ruleIds = new Set<string>();
  for (const rule of recipe.rules) {
    if (ruleIds.has(rule.id)) throw new Error(`${recipe.id}: duplicate rule ${rule.id}`);
    ruleIds.add(rule.id);
    for (const need of rule.needs) {
      if (!ids.has(need)) throw new Error(`${recipe.id}/${rule.id}: needs unknown step ${need}`);
    }
  }
}

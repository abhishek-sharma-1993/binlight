import type { RecipeInfo } from "@binlight/shared";
import type { StepOutcome } from "../jobs/steps.js";

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
}

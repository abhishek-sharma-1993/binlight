import { rawAnalysis } from "./raw-analysis.js";
import { validateRecipe, type Recipe } from "./types.js";

export { recipeInfo, stepsFor, validateRecipe, type Recipe, type RecipeStep } from "./types.js";

/** The recipe a job gets when none is named (phase 0's raw analysis). */
export const DEFAULT_RECIPE_ID = "raw-analysis";

/** Recipes the server offers, in the order the page lists them. */
export const RECIPES: Recipe[] = [rawAnalysis];

for (const recipe of RECIPES) validateRecipe(recipe);

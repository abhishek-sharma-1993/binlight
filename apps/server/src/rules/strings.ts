import type { ToolOutput } from "../rea/schemas.js";
import type { StepResult } from "./types.js";

export interface StringItem {
  address: string;
  value: string;
}

/** The string list from a `list_strings` step. */
export function stringItems(step: StepResult): StringItem[] {
  return (step.result as ToolOutput<"list_strings">).normalized_result;
}

/** Caveats every string-based finding carries. */
export const STRING_LIST_CAVEATS = [
  "Read from the disassembler's string list. Go packs string literals end to end, so text inside packed data can be missing from it.",
];

import { goOutcome, listOutcome, overviewOutcome } from "../jobs/steps.js";
import type { ToolOutput } from "../rea/schemas.js";
import type { Recipe } from "./types.js";

/** Phase 0's analysis as a recipe: the raw REA results, no findings or verdict. */
export const rawAnalysis: Recipe = {
  id: "raw-analysis",
  title: "Raw analysis",
  question: "What does REA see in this binary?",
  description:
    "Go build info, then a full disassembler pass: segments, procedures and strings as REA reports them. Raw results, no verdict.",
  targets: 1,
  targetLabels: ["Binary"],
  steps: [
    {
      id: "go",
      label: "Read Go build info",
      why: "Go binaries embed their toolchain version and dependency list; reading it needs no disassembler.",
      tool: "inspect_go_binary",
      deep: false,
      args: (target) => ({ path: target }),
      outcome: (r) => goOutcome(r as ToolOutput<"inspect_go_binary">),
    },
    {
      id: "overview",
      label: "Analyse (overview)",
      why: "Runs the disassembler's analysis once; every later step reuses it.",
      tool: "binary_overview",
      deep: true,
      outcome: (r) => overviewOutcome(r as ToolOutput<"binary_overview">),
    },
    {
      id: "strings",
      label: "List strings",
      why: "Text the binary contains: URLs, messages, names.",
      tool: "list_strings",
      deep: true,
      outcome: (r) => listOutcome("strings", r as ToolOutput<"list_strings">),
    },
    {
      id: "procedures",
      label: "List procedures",
      why: "Every function the disassembler found, by name and address.",
      tool: "list_procedures",
      deep: true,
      outcome: (r) => listOutcome("procedures", r as ToolOutput<"list_procedures">),
    },
  ],
};

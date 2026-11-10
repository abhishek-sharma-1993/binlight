import { goOutcome, machoOutcome, rustOutcome, signatureOutcome } from "../jobs/steps.js";
import type { ToolOutput } from "../rea/schemas.js";
import {
  goBuildInfo,
  goSupportRule,
  machoPlatform,
  noDependencyMetadata,
  rustDependencies,
  signing,
} from "../rules/index.js";
import type { Recipe } from "./types.js";
import { whatsInsideVerdict } from "./whats-inside-verdict.js";

/** What a binary is built from, read from its metadata: no disassembler, seconds not minutes. */
export const whatsInside: Recipe = {
  id: "whats-inside",
  title: "What's inside?",
  question: "What is it built from, and is it current?",
  description:
    "Reads the build metadata the binary carries: Go or Rust toolchain and dependencies, the platform and libraries it targets, and who signed it. It takes seconds.",
  targets: 1,
  targetLabels: ["Binary"],
  rules: [
    goBuildInfo,
    goSupportRule,
    rustDependencies,
    noDependencyMetadata,
    machoPlatform,
    signing,
  ],
  verdict: whatsInsideVerdict,
  steps: [
    {
      id: "go",
      label: "Read Go build info",
      why: "Go binaries embed their toolchain version and every module they were built from.",
      tool: "inspect_go_binary",
      deep: false,
      args: (target) => ({ path: target }),
      outcome: (r) => goOutcome(r as ToolOutput<"inspect_go_binary">),
    },
    {
      id: "rust",
      label: "Read Rust build info",
      why: "Rust binaries built with cargo-auditable embed their crate list.",
      tool: "inspect_rust_binary",
      deep: false,
      args: (target) => ({ path: target }),
      outcome: (r) => rustOutcome(r as ToolOutput<"inspect_rust_binary">),
    },
    {
      id: "macho",
      label: "Read its platform and libraries",
      why: "The macOS version it targets, the SDK it was built with, and the libraries it loads.",
      tool: "inspect_macho",
      deep: false,
      opens: true,
      formats: ["mach-o"],
      args: () => ({ detail: "complete" }),
      outcome: (r) => machoOutcome(r as ToolOutput<"inspect_macho">),
    },
    {
      id: "signature",
      label: "Check who signed it",
      why: "A developer identity, Apple, ad-hoc or nobody: the first thing to know about where it came from.",
      tool: "inspect_signature",
      deep: false,
      opens: true,
      formats: ["mach-o"],
      outcome: (r) => signatureOutcome(r as ToolOutput<"inspect_signature">),
    },
  ],
};

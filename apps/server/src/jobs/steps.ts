import type { StepError } from "@binlight/shared";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { ReaProcessError, ReaToolError } from "../rea/errors.js";
import { isContractTool, toolSchemas, type ToolOutput } from "../rea/schemas.js";

/** A step outcome for the feed: one line, counts and the evidence it cites. */
export interface StepOutcome {
  summary: string;
  counts?: Record<string, number>;
  evidenceId?: string;
  /** Full REA result, served on request (never inlined in events). */
  result?: unknown;
}

/** A failure Binlight itself detects (e.g. a preflight blocker), with the user-facing reason. */
export class StepFailure extends Error {
  constructor(readonly error: StepError) {
    super(error.message);
    this.name = "StepFailure";
  }
}

/** Parses a REA result with Binlight's schema, so a changed shape fails loudly instead of misleading. */
export function parseResult(tool: string, value: unknown): unknown {
  if (!isContractTool(tool)) return value;
  const parsed = toolSchemas[tool].safeParse(value);
  if (parsed.success) return parsed.data;
  throw new StepFailure({
    code: "unexpected_rea_response",
    message: `REA's ${tool} response does not match what Binlight expects: ${parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "$"}: ${i.message}`)
      .join("; ")}`,
    remediation: "REA may have changed. Run npm run test:contract.",
  });
}

/** Turns anything a step can throw into the real reason shown to the user. */
export function toStepError(err: unknown): StepError {
  if (err instanceof StepFailure) return err.error;
  if (err instanceof ReaToolError) {
    return {
      code: err.rea.code,
      message: err.rea.message,
      ...(err.rea.remediation && { remediation: err.rea.remediation.action }),
    };
  }
  if (err instanceof ReaProcessError) {
    // Prefer lines that say what went wrong over trailing hints like "Run --help".
    const tail = err.stderrTail.filter((l) => l.trim());
    const errors = tail.filter((l) => /error|exception|denied|not found|does not exist/i.test(l));
    const shown = (errors.length > 0 ? errors : tail).slice(-3).map((l) => l.slice(0, 500));
    return {
      code: "rea_exited",
      message: shown.length > 0 ? `${err.message} REA output: ${shown.join(" | ")}` : err.message,
    };
  }
  if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) {
    return {
      code: "timeout",
      message: `REA did not answer in time: ${err.message}`,
      remediation: "Large binaries under emulation can take hours; raise the step timeout.",
    };
  }
  return { code: "internal_error", message: err instanceof Error ? err.message : String(err) };
}

type Evidence = { evidence_id: string };
const n = (v: number) => v.toLocaleString("en-US");

export function goOutcome(value: ToolOutput<"inspect_go_binary">): StepOutcome {
  const info = value.normalized_result.build_info;
  if (!info) {
    return {
      summary: "Not a Go binary (no Go build info).",
      evidenceId: value.evidence_id,
      result: value,
    };
  }
  const main = info.module.main;
  return {
    summary: `${info.go_version} · ${main.path} ${main.version} · ${n(info.module.dependencies.length)} dependencies`,
    counts: { dependencies: info.module.dependencies.length },
    evidenceId: value.evidence_id,
    result: value,
  };
}

export function overviewOutcome(value: ToolOutput<"binary_overview">): StepOutcome {
  const r = value.normalized_result;
  return {
    summary: `${n(r.segment_count)} segments, ${n(r.procedure_count)} procedures, ${n(r.string_count)} strings`,
    counts: { segments: r.segment_count, procedures: r.procedure_count, strings: r.string_count },
    evidenceId: value.evidence_id,
    result: value,
  };
}

export function listOutcome(
  noun: "strings" | "procedures",
  value: Evidence & { normalized_result: unknown[] },
): StepOutcome {
  const count = value.normalized_result.length;
  return {
    summary: `${n(count)} ${noun}`,
    counts: { [noun]: count },
    evidenceId: value.evidence_id,
    result: value,
  };
}

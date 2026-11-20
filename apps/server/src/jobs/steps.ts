import type { StepError } from "@binlight/shared";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { ReaProcessError, ReaToolError } from "../rea/errors.js";
import { isContractTool, toolSchemas, type ToolOutput } from "../rea/schemas.js";

/** A step outcome for the feed: one line, counts and the evidence it cites. */
export interface StepOutcome {
  summary: string;
  counts?: Record<string, number>;
  evidenceId?: string;
  /** For a many-call step: how many evidence records its result holds. */
  evidenceCount?: number;
  /** Full REA result, served on request (never inlined in events). */
  result?: unknown;
  /** Set when the outcome was rebuilt from the evidence cache. */
  cachedAt?: string;
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
    // REA's generic message ("Analysis input is invalid") often has the real
    // reason in details.issues; show it.
    const issues = Array.isArray(err.rea.details?.["issues"])
      ? (err.rea.details["issues"] as unknown[])
          .map((i) =>
            i && typeof i === "object" ? (i as { message?: unknown }).message : undefined,
          )
          .filter((m): m is string => typeof m === "string" && m.length > 0)
      : [];
    return {
      code: err.rea.code,
      message: issues.length > 0 ? `${err.rea.message} ${issues.join("; ")}` : err.rea.message,
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
    summary: `${info.go_version} · ${main ? `${main.path} ${main.version}` : info.module.path} · ${n(info.module.dependencies.length)} dependencies`,
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

export function rustOutcome(value: ToolOutput<"inspect_rust_binary">): StepOutcome {
  const r = value.normalized_result;
  const root = r.auditable_metadata?.packages.find((p) => p.root);
  const deps = r.auditable_metadata ? r.auditable_metadata.packages.length - (root ? 1 : 0) : 0;
  return {
    summary: r.auditable_metadata
      ? `${root ? `${root.name} ${root.version} · ` : ""}${n(deps)} crate ${deps === 1 ? "dependency" : "dependencies"} (cargo-auditable)`
      : r.rustc_commit
        ? "Rust compiler path found, but no crate list (not built with cargo-auditable)"
        : "Not a Rust binary built with cargo-auditable (no crate list)",
    ...(r.auditable_metadata && { counts: { dependencies: deps } }),
    evidenceId: value.evidence_id,
    result: value,
  };
}

export function machoOutcome(value: ToolOutput<"inspect_macho">): StepOutcome {
  const r = value.normalized_result;
  const build = r.build_metadata.items[0];
  const platform = build
    ? `${build.platform === "MACOS" ? "macOS" : build.platform}${build.minimum_os ? ` ${build.minimum_os}+` : ""}`
    : "no platform record";
  return {
    summary: `${platform} · ${n(r.dependencies.total)} linked libraries`,
    counts: { libraries: r.dependencies.total },
    evidenceId: value.evidence_id,
    result: value,
  };
}

export function signatureOutcome(value: ToolOutput<"inspect_signature">): StepOutcome {
  const s = value.normalized_result;
  return {
    summary: !s.signed
      ? "Not signed"
      : s.team_identifier
        ? `Signed · Team ID ${s.team_identifier}`
        : (s.authorities ?? []).length > 0
          ? `Signed · ${(s.authorities ?? [])[0]}`
          : "Ad-hoc signed (no identity)",
    evidenceId: value.evidence_id,
    result: value,
  };
}

/** One REA evidence record as a many-call step keeps it (bulky facets dropped). */
export interface EvidenceRecord {
  evidence_id: string;
  operation?: string;
  parameters?: unknown;
  subject?: unknown;
  provider?: unknown;
  confidence?: string;
  limitations?: string[];
  normalized_result?: unknown;
}

/** A many-call step's result: what its `run` returned, plus every record it saw. */
export interface MultiCallResult<T = unknown> {
  operation: string;
  multiCall: true;
  data: T;
  records: EvidenceRecord[];
}

export function isMultiCall(v: unknown): v is MultiCallResult {
  return typeof v === "object" && v !== null && (v as { multiCall?: unknown }).multiCall === true;
}

/** Keeps the parts of a REA response a report or rule needs. */
export function keepRecord(value: unknown): EvidenceRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v["evidence_id"] !== "string") return undefined;
  const keep = [
    "evidence_id",
    "operation",
    "parameters",
    "subject",
    "provider",
    "confidence",
    "limitations",
    "normalized_result",
  ];
  return Object.fromEntries(
    keep.filter((k) => k in v).map((k) => [k, v[k]]),
  ) as unknown as EvidenceRecord;
}

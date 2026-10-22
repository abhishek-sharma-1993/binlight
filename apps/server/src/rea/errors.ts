import { isReaError, type ReaError } from "@binlight/shared";
import type { CallToolResult } from "@modelcontextprotocol/client";

/** A REA tool ran and reported a failure. Carries REA's own code and remediation. */
export class ReaToolError extends Error {
  readonly tool: string;
  readonly rea: ReaError;

  constructor(tool: string, rea: ReaError) {
    super(`${tool}: ${rea.message}`);
    this.name = "ReaToolError";
    this.tool = tool;
    this.rea = rea;
  }
}

/** The REA process is missing, died, or is not the pinned version. */
export class ReaProcessError extends Error {
  readonly stderrTail: string[];

  constructor(message: string, stderrTail: string[] = [], options?: ErrorOptions) {
    super(message, options);
    this.name = "ReaProcessError";
    this.stderrTail = stderrTail;
  }
}

function textOf(result: CallToolResult): string {
  return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/**
 * Extracts REA's structured error from a failed `tools/call` result.
 * REA puts `{"error": {...}}` JSON in a text block. If that is ever missing or
 * malformed we still return the raw text, so the user never sees a blank.
 */
export function reaErrorFromResult(result: CallToolResult): ReaError {
  const text = textOf(result);
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const { error } = parsed;
      if (isReaError(error)) return error;
    }
  } catch {
    // fall through to the raw text
  }
  return {
    code: "unparsed_rea_error",
    message: text.trim() || "REA reported an error with no message.",
  };
}

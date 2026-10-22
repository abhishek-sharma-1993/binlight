/**
 * Types shared by the server and the web app for talking about REA.
 * The browser never talks to REA directly; these describe what the server reports.
 */

/** A tool advertised by REA's MCP server (`tools/list`). */
export interface ReaToolInfo {
  name: string;
  title?: string;
  description?: string;
}

/**
 * REA's structured tool error, as returned by REA 6.7.0 inside a failed
 * `tools/call` result: `{ "error": { code, category, message, retryable, remediation, details } }`.
 * Binlight shows the message and remediation to the user verbatim.
 */
export interface ReaError {
  code: string;
  message: string;
  category?: string;
  retryable?: boolean;
  remediation?: { action: string };
  details?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isReaError(value: unknown): value is ReaError {
  if (!isRecord(value)) return false;
  const { code, message, category, retryable, remediation, details } = value;
  return (
    typeof code === "string" &&
    typeof message === "string" &&
    (category === undefined || typeof category === "string") &&
    (retryable === undefined || typeof retryable === "boolean") &&
    (remediation === undefined ||
      (isRecord(remediation) && typeof remediation["action"] === "string")) &&
    (details === undefined || isRecord(details))
  );
}

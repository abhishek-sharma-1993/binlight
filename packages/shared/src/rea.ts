/**
 * Types shared by the server and the web app for talking about REA.
 * The browser never talks to REA directly; these describe what the server reports.
 */

/** A tool advertised by REA's MCP server (`tools/list`). */
export interface ReaToolInfo {
  name: string;
  description?: string;
}

/**
 * REA's structured error. REA reports failures as JSON with a code, a message
 * and a remediation; Binlight shows all three to the user.
 */
export interface ReaError {
  code: string;
  message: string;
  remediation?: string;
}

export function isReaError(value: unknown): value is ReaError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["code"] === "string" &&
    typeof v["message"] === "string" &&
    (v["remediation"] === undefined || typeof v["remediation"] === "string")
  );
}

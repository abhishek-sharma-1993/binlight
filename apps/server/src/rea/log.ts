/**
 * REA logs JSON lines (pino) to stderr. Turns one into a short feed line, e.g.
 * "binary_overview error 70285 ms: MCP tool execution completed". Other lines
 * pass through unchanged.
 */
export function formatReaLog(line: string): string {
  try {
    const entry = JSON.parse(line) as Record<string, unknown>;
    const parts = [
      typeof entry["tool"] === "string" ? entry["tool"] : undefined,
      typeof entry["status"] === "string" ? entry["status"] : undefined,
      typeof entry["durationMs"] === "number" ? `${Math.round(entry["durationMs"])} ms` : undefined,
    ].filter(Boolean);
    const msg = typeof entry["msg"] === "string" ? entry["msg"] : "";
    return parts.length > 0 ? `${parts.join(" ")}: ${msg}` : msg || line;
  } catch {
    return line;
  }
}

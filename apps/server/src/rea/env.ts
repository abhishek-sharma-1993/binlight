import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

/** What REA's providers need to find. Unset values are left out, never guessed. */
export interface ReaEnvOptions {
  ghidraInstallDir?: string | undefined;
  ghidraStartupTimeoutMs?: number | undefined;
  javaHome?: string | undefined;
  extra?: Record<string, string> | undefined;
}

/**
 * The full environment for `rea --mcp`. Built explicitly rather than inherited:
 * a server started outside a terminal does not see the user's shell variables,
 * so anything REA needs is passed here (see docs/lessons-learned.md).
 */
export function buildReaEnv(
  options: ReaEnvOptions,
  base: Record<string, string> = getDefaultEnvironment(),
): Record<string, string> {
  const env: Record<string, string> = { ...base };
  const tmp = process.env["TMPDIR"];
  if (tmp && env["TMPDIR"] === undefined) env["TMPDIR"] = tmp;
  if (options.ghidraInstallDir) env["GHIDRA_INSTALL_DIR"] = options.ghidraInstallDir;
  if (options.ghidraStartupTimeoutMs !== undefined) {
    env["REA_GHIDRA_STARTUP_TIMEOUT_MS"] = String(options.ghidraStartupTimeoutMs);
  }
  if (options.javaHome) env["JAVA_HOME"] = options.javaHome;
  return { ...env, ...options.extra };
}

/** Reads REA settings from the Binlight server's own environment. */
export function reaEnvOptionsFromProcess(env: NodeJS.ProcessEnv = process.env): ReaEnvOptions {
  const timeout = env["REA_GHIDRA_STARTUP_TIMEOUT_MS"];
  return {
    ghidraInstallDir: env["GHIDRA_INSTALL_DIR"],
    // Ollama took 21 min of initial analysis natively; default to 45 min.
    ghidraStartupTimeoutMs: timeout ? Number(timeout) : 45 * 60 * 1000,
    javaHome: env["JAVA_HOME"],
  };
}

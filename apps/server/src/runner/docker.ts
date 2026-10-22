import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { promisify } from "node:util";
import { RUNNER_IMAGE } from "../preflight/health.js";

const run = promisify(execFile);

export interface DockerRunnerOptions {
  image?: string;
  /** Ghidra headless heap; REA's own default is 2G. */
  ghidraMaxMem?: string;
  ghidraStartupTimeoutMs?: number;
}

export interface DockerReaCommand {
  command: string;
  args: string[];
  /** Where the target appears inside the container; pass this to open_binary. */
  containerTarget: string;
  containerName: string;
  /** Named volume holding this session's Ghidra project and REA runtime files. */
  volume: string;
}

/** Hostname the container resolves to itself; Java's getLocalHost needs it with no network. */
const HOSTNAME = "binlight-runner";

/**
 * The `docker run` that starts `rea --mcp` in the runner image for one target:
 * no network, the image's non-root user, read-only root filesystem, no
 * capabilities, the target mounted read-only, and only a per-session named
 * volume writable. The volume is a Linux filesystem: REA's Ghidra bridge
 * chmods a Unix socket there, which fails on a macOS bind mount.
 */
export async function dockerReaCommand(
  hostTarget: string,
  options: DockerRunnerOptions = {},
): Promise<DockerReaCommand> {
  const session = randomUUID();
  const volume = `binlight-work-${session}`;
  await run("docker", ["volume", "create", "--label", "dev.binlight.session", volume]);

  const containerTarget = `/target/${basename(hostTarget)}`;
  const containerName = `binlight-rea-${session}`;
  const env: Record<string, string> = {
    GHIDRA_HEADLESS_MAXMEM: options.ghidraMaxMem ?? "4G",
    REA_GHIDRA_STARTUP_TIMEOUT_MS: String(options.ghidraStartupTimeoutMs ?? 6 * 60 * 60 * 1000),
  };

  const args = [
    "run",
    "-i",
    "--rm",
    "--name",
    containerName,
    "--platform",
    "linux/amd64",
    "--network",
    "none",
    "--hostname",
    HOSTNAME,
    "--add-host",
    `${HOSTNAME}:127.0.0.1`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,exec,size=256m",
    "--mount",
    `type=volume,source=${volume},target=/work`,
    "--mount",
    `type=bind,source=${hostTarget},target=${containerTarget},readonly`,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    options.image ?? RUNNER_IMAGE,
    "--mcp",
  ];
  return { command: "docker", args, containerTarget, containerName, volume };
}

/** Removes the container if it is still around, then the session's volume. */
export async function disposeDockerSession(cmd: DockerReaCommand): Promise<void> {
  await run("docker", ["rm", "-f", cmd.containerName]).catch(() => undefined);
  await run("docker", ["volume", "rm", "-f", cmd.volume]).catch(() => undefined);
}

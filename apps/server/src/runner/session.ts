import type { DeepRoute } from "@binlight/shared";
import { ReaClient, type ReaClientOptions } from "../rea/client.js";
import { reaEnvOptionsFromProcess, type ReaEnvOptions } from "../rea/env.js";
import { disposeDockerSession, dockerReaCommand, type DockerRunnerOptions } from "./docker.js";

export interface ReaSession {
  rea: ReaClient;
  route: DeepRoute;
  /** `provider_id` for open_binary. */
  providerId: string;
  /** The target path as REA sees it (inside the container for docker-ghidra). */
  target: string;
  /** Closes REA and removes anything the route created. */
  close(): Promise<void>;
}

export interface SessionOptions {
  env?: ReaEnvOptions;
  docker?: DockerRunnerOptions;
  onStderr?: ReaClientOptions["onStderr"];
}

/**
 * Starts REA for one target on the route preflight chose. One session per
 * binary: open_binary once, then reuse the analysis for every step.
 */
export async function openReaSession(
  route: DeepRoute,
  providerId: string,
  hostTarget: string,
  options: SessionOptions = {},
): Promise<ReaSession> {
  const onStderr = options.onStderr ? { onStderr: options.onStderr } : {};

  if (route !== "docker-ghidra") {
    const rea = await ReaClient.connect({
      ...(options.env ?? reaEnvOptionsFromProcess()),
      ...onStderr,
    });
    return { rea, route, providerId, target: hostTarget, close: () => rea.close() };
  }

  const cmd = await dockerReaCommand(hostTarget, options.docker);
  let rea: ReaClient;
  try {
    // The docker CLI only needs the default environment (PATH, HOME for its config).
    rea = await ReaClient.connect({
      command: { command: cmd.command, args: cmd.args },
      connectTimeoutMs: 180_000,
      ...onStderr,
    });
  } catch (err) {
    await disposeDockerSession(cmd);
    throw err;
  }
  return {
    rea,
    route,
    providerId,
    target: cmd.containerTarget,
    close: async () => {
      await rea.close().catch(() => undefined);
      await disposeDockerSession(cmd);
    },
  };
}

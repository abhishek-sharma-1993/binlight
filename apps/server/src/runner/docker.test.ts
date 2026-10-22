import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RUNNER_IMAGE } from "../preflight/health.js";
import { PINNED_REA_VERSION } from "../rea/version.js";
import { disposeDockerSession, dockerReaCommand } from "./docker.js";

const repo = new URL("../../../../", import.meta.url);

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function volumeExists(name: string): boolean {
  try {
    execFileSync("docker", ["volume", "inspect", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(dockerAvailable())("dockerReaCommand", () => {
  it("isolates REA: no network, non-root image user, read-only root and target", async () => {
    const cmd = await dockerReaCommand("/data/apps/kubectl");
    try {
      const args = cmd.args.join(" ");
      expect(cmd.command).toBe("docker");
      expect(args).toContain("--network none");
      expect(args).toContain("--read-only");
      expect(args).toContain("--cap-drop ALL");
      expect(args).toContain("--security-opt no-new-privileges");
      expect(args).toContain("--platform linux/amd64");
      expect(args).not.toContain("--user");
      expect(args).toContain("type=bind,source=/data/apps/kubectl,target=/target/kubectl,readonly");
      expect(args).toContain(`type=volume,source=${cmd.volume},target=/work`);
      expect(cmd.args.slice(-2)).toEqual([RUNNER_IMAGE, "--mcp"]);
      expect(cmd.containerTarget).toBe("/target/kubectl");
      expect(args).toContain("GHIDRA_HEADLESS_MAXMEM=4G");
      expect(volumeExists(cmd.volume)).toBe(true);
    } finally {
      await disposeDockerSession(cmd);
    }
    expect(volumeExists(cmd.volume)).toBe(false);
  });
});

describe("runner image pins", () => {
  it("build.sh and the Dockerfile install the pinned REA version", () => {
    const build = readFileSync(new URL("docker/runner/build.sh", repo), "utf8");
    const dockerfile = readFileSync(new URL("docker/runner/Dockerfile", repo), "utf8");
    expect(build).toContain(`REA_VERSION="${PINNED_REA_VERSION}"`);
    expect(dockerfile).toContain(`ARG REA_VERSION=${PINNED_REA_VERSION}`);
    expect(RUNNER_IMAGE).toBe(`binlight-runner:rea-${PINNED_REA_VERSION}`);
  });

  it("checks the Ghidra zip against the SHA-256 in lessons-learned", () => {
    const sha = "ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db";
    for (const file of [
      "docker/runner/build.sh",
      "docker/runner/Dockerfile",
      "docs/lessons-learned.md",
    ]) {
      expect(readFileSync(new URL(file, repo), "utf8"), file).toContain(sha);
    }
  });
});

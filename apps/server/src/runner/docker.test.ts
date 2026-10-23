import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RUNNER_IMAGE } from "../preflight/health.js";
import { PINNED_REA_VERSION } from "../rea/version.js";
import { disposeDockerSession, dockerReaCommand, stageTarget } from "./docker.js";

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
    const dir = mkdtempSync(join(tmpdir(), "binlight-cmd-"));
    const target = join(dir, "kubectl");
    writeFileSync(target, "binary bytes");
    const cmd = await dockerReaCommand(target, { stageRoot: join(dir, "stage") });
    try {
      const args = cmd.args.join(" ");
      expect(cmd.command).toBe("docker");
      expect(args).toContain("--network none");
      expect(args).toContain("--read-only");
      expect(args).toContain("--cap-drop ALL");
      expect(args).toContain("--security-opt no-new-privileges");
      expect(args).toContain("--platform linux/amd64");
      expect(args).not.toContain("--user");
      // The staged copy (Docker can't mount every host folder) is what's mounted, read-only.
      expect(cmd.staged).toMatch(/\/stage\/[a-f0-9]{64}\/kubectl$/);
      expect(args).toContain(`type=bind,source=${cmd.staged},target=/target/kubectl,readonly`);
      expect(args).toContain(`type=volume,source=${cmd.volume},target=/work`);
      expect(cmd.args.slice(-2)).toEqual([RUNNER_IMAGE, "--mcp"]);
      expect(cmd.containerTarget).toBe("/target/kubectl");
      expect(args).toContain("GHIDRA_HEADLESS_MAXMEM=4G");
      expect(volumeExists(cmd.volume)).toBe(true);
    } finally {
      await disposeDockerSession(cmd);
      rmSync(dir, { recursive: true, force: true });
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

describe("stageTarget", () => {
  it("copies the target under its SHA-256, keeping its name, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "binlight-stage-"));
    try {
      const source = join(dir, "kubectl");
      writeFileSync(source, "binary bytes");
      const staged = await stageTarget(source, join(dir, "stage"));
      expect(staged).toMatch(/\/stage\/[a-f0-9]{64}\/kubectl$/);
      expect(readFileSync(staged, "utf8")).toBe("binary bytes");
      expect(await stageTarget(source, join(dir, "stage"))).toBe(staged);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

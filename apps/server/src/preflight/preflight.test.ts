import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RUNNER_IMAGE, type DeepHealth } from "./health.js";
import { preflight } from "./preflight.js";

const nothingWorks: DeepHealth = {
  ghidra: { available: false, failed: [{ name: "native_decompiler" }] },
  hopper: { installed: false, reason: "not installed" },
  docker: { daemon: false, reason: "Docker is not running" },
};
const dockerWorks: DeepHealth = {
  ...nothingWorks,
  docker: { daemon: true, image: { name: RUNNER_IMAGE, architecture: "amd64" } },
};

describe("preflight", () => {
  const dir = mkdtempSync(join(tmpdir(), "binlight-preflight-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("blocks a missing file with the real reason, and never throws", async () => {
    const report = await preflight("/nonexistent/binlight", { health: nothingWorks });
    expect(report.canAnalyse).toBe(false);
    expect(report.issues[0]).toMatchObject({ severity: "blocker", code: "target_missing" });
    expect(report.issues[0]?.message).toContain("ENOENT");
  });

  it("blocks a file that is not an executable", async () => {
    const notes = join(dir, "notes.txt");
    writeFileSync(notes, "hello");
    const report = await preflight(notes, { health: nothingWorks });
    expect(report.canAnalyse).toBe(false);
    expect(report.issues.map((i) => i.code)).toEqual(["unsupported_format"]);
  });

  it("reports when no deep route works, with every route's reason", async () => {
    const elf = join(dir, "tool");
    const head = Buffer.alloc(64);
    head.writeUInt32BE(0x7f454c46, 0);
    head[5] = 1;
    head.writeUInt16LE(183, 18);
    writeFileSync(elf, head);

    const none = await preflight(elf, { health: nothingWorks, cacheDir: dir });
    expect(none.canAnalyse).toBe(true);
    expect(none.deep).toBeUndefined();
    expect(none.issues).toContainEqual(
      expect.objectContaining({ severity: "limits", code: "no_deep_route" }),
    );
    expect(none.routes.map((r) => r.reason)).toEqual([
      expect.stringContaining("native_decompiler"),
      "not installed",
      "Docker is not running",
    ]);

    const docker = await preflight(elf, { health: dockerWorks, cacheDir: dir });
    expect(docker.deep).toMatchObject({ route: "docker-ghidra", providerId: "ghidra" });
    expect(docker.analysisArchitecture).toBe("arm64");
    expect(docker.analysisSha256).toBe(docker.target.sha256);
    expect(docker.issues).toEqual([]);
  });

  it.runIf(process.platform === "darwin")(
    "thins a real universal binary and analyses the host's slice",
    async () => {
      const report = await preflight("/bin/ls", {
        health: dockerWorks,
        cacheDir: dir,
        hostArch: "arm64",
      });
      expect(report.analysisArchitecture).toBe("arm64e");
      expect(report.analysisPath).toMatch(/-arm64e$/);
      // Keyed on the slice's own bytes, not the universal file's.
      expect(report.analysisSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report.analysisSha256).not.toBe(report.target.sha256);
      expect(report.issues.map((i) => i.code)).toEqual(["thinned_universal"]);
    },
  );
});

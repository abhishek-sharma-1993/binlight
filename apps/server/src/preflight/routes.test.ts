import { describe, expect, it } from "vitest";
import { isHopperDemoVersion, RUNNER_IMAGE, type DeepHealth } from "./health.js";
import { decideRoutes } from "./routes.js";

const noDecompiler: DeepHealth["ghidra"] = {
  available: false,
  failed: [
    {
      name: "native_decompiler",
      code: "executable_missing",
      detail: "Matching native decompiler for darwin/arm64 was not found",
      remediation: "Provide an executable decompile",
    },
  ],
};
const licensedHopper: DeepHealth["hopper"] = {
  installed: true,
  appPath: "/Applications/Hopper Disassembler.app",
  version: "6.6.0",
  demo: false,
};
const demoHopper: DeepHealth["hopper"] = { ...licensedHopper, version: "6.6.0-demo", demo: true };
const dockerReady: DeepHealth["docker"] = {
  daemon: true,
  image: { name: RUNNER_IMAGE, architecture: "amd64" },
};

const chosen = (health: DeepHealth) =>
  decideRoutes(health, "mach-o").find((r) => r.available)?.route;

describe("decideRoutes", () => {
  it("prefers native Ghidra when REA says it works", () => {
    expect(
      chosen({
        ghidra: { available: true, failed: [] },
        hopper: licensedHopper,
        docker: dockerReady,
      }),
    ).toBe("native-ghidra");
  });

  it("uses a licensed Hopper when Ghidra has no native decompiler", () => {
    expect(chosen({ ghidra: noDecompiler, hopper: licensedHopper, docker: dockerReady })).toBe(
      "hopper",
    );
  });

  it("avoids demo Hopper and falls back to the Docker runner", () => {
    const routes = decideRoutes(
      { ghidra: noDecompiler, hopper: demoHopper, docker: dockerReady },
      "mach-o",
    );
    expect(routes.find((r) => r.available)).toMatchObject({
      route: "docker-ghidra",
      providerId: "ghidra",
    });
    expect(routes.find((r) => r.route === "hopper")?.reason).toContain("demo");
  });

  it("explains every route when none works (this Mac today)", () => {
    const routes = decideRoutes(
      { ghidra: noDecompiler, hopper: demoHopper, docker: { daemon: true, image: undefined } },
      "mach-o",
    );
    expect(routes.every((r) => !r.available)).toBe(true);
    expect(routes.map((r) => r.reason)).toEqual([
      expect.stringContaining("native_decompiler"),
      expect.stringContaining("demo"),
      expect.stringContaining("not built"),
    ]);
  });

  it("rejects an arm64 runner image and a stopped Docker", () => {
    const arm = decideRoutes(
      {
        ghidra: noDecompiler,
        hopper: demoHopper,
        docker: { daemon: true, image: { name: RUNNER_IMAGE, architecture: "arm64" } },
      },
      "mach-o",
    );
    expect(arm[2]?.reason).toContain("must be amd64");
    const stopped = decideRoutes(
      {
        ghidra: noDecompiler,
        hopper: demoHopper,
        docker: { daemon: false, reason: "not running" },
      },
      "mach-o",
    );
    expect(stopped[2]).toMatchObject({ available: false, reason: "not running" });
  });
});

describe("isHopperDemoVersion", () => {
  it("spots the demo build from its version string", () => {
    expect(isHopperDemoVersion("6.6.0-demo")).toBe(true);
    expect(isHopperDemoVersion("6.6.0")).toBe(false);
    expect(isHopperDemoVersion(undefined)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { buildReaEnv, reaEnvOptionsFromProcess } from "./env.js";

describe("buildReaEnv", () => {
  it("passes Ghidra and Java settings explicitly", () => {
    const env = buildReaEnv(
      { ghidraInstallDir: "/g", ghidraStartupTimeoutMs: 1000, javaHome: "/j" },
      { PATH: "/bin" },
    );
    expect(env).toMatchObject({
      PATH: "/bin",
      GHIDRA_INSTALL_DIR: "/g",
      REA_GHIDRA_STARTUP_TIMEOUT_MS: "1000",
      JAVA_HOME: "/j",
    });
  });

  it("leaves unset values out instead of guessing", () => {
    const env = buildReaEnv({}, { PATH: "/bin" });
    expect(env).not.toHaveProperty("GHIDRA_INSTALL_DIR");
    expect(env).not.toHaveProperty("JAVA_HOME");
  });
});

describe("reaEnvOptionsFromProcess", () => {
  it("defaults the Ghidra startup budget to 45 minutes", () => {
    expect(reaEnvOptionsFromProcess({}).ghidraStartupTimeoutMs).toBe(2_700_000);
    expect(
      reaEnvOptionsFromProcess({ REA_GHIDRA_STARTUP_TIMEOUT_MS: "5" }).ghidraStartupTimeoutMs,
    ).toBe(5);
  });
});

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUNNER_IMAGE } from "../preflight/health.js";
import { PINNED_REA_VERSION } from "../rea/version.js";
import {
  buildGoFixture,
  compareRecordings,
  loadRecordings,
  openContractSession,
  recordContracts,
  type ContractRun,
  type ContractRunner,
  type ContractSession,
} from "./run.js";

// Live: analyses a fresh Go fixture with the pinned REA, locally (whichever
// provider REA selects) and in the Docker runner (Ghidra) when its image is
// built. Run with `npm run test:contract`.

function runnerImageBuilt(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", RUNNER_IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const runners: { runner: ContractRunner; enabled: boolean }[] = [
  { runner: "local", enabled: true },
  { runner: "docker", enabled: runnerImageBuilt() },
];

describe.each(runners)(`REA ${PINNED_REA_VERSION} contract ($runner)`, ({ runner, enabled }) => {
  let fixture: string;
  let session: ContractSession | undefined;
  let run: ContractRun;

  beforeAll(async () => {
    if (!enabled) return;
    fixture = buildGoFixture();
    session = await openContractSession(runner, fixture);
    run = await recordContracts(session.rea, session.target, session.provider);
  }, 60 * 60_000);

  afterAll(async () => {
    await session?.close();
    if (fixture) rmSync(dirname(fixture), { recursive: true, force: true });
  });

  it.skipIf(!enabled)("live responses parse with Binlight's schemas", () => {
    expect(run.schemaProblems).toEqual([]);
  });

  it.skipIf(!enabled)("live responses match the recorded shapes for this provider", () => {
    const recorded = loadRecordings(PINNED_REA_VERSION).find(
      (r) => r.provider === run.recording.provider,
    );
    if (!recorded) {
      expect.fail(
        `No contract recorded for REA ${PINNED_REA_VERSION} with provider "${run.recording.provider}". ` +
          `Run: npm run contracts:record${runner === "docker" ? " -- --runner docker" : ""}`,
      );
    }
    const problems = compareRecordings(recorded, run.recording);
    expect(problems, `REA contract broken:\n${problems.join("\n")}`).toEqual([]);
  });
});

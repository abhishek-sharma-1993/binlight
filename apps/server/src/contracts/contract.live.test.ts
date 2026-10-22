import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReaClient } from "../rea/client.js";
import { PINNED_REA_VERSION } from "../rea/version.js";
import {
  buildGoFixture,
  compareRecordings,
  connectForContracts,
  loadRecordings,
  recordContracts,
  type ContractRun,
} from "./run.js";

// Live: spawns the pinned `rea --mcp` and analyses a fresh Go fixture with
// whichever deep provider REA selects here. Run with `npm run test:contract`.

describe(`REA ${PINNED_REA_VERSION} contract (live)`, () => {
  let rea: ReaClient;
  let target: string;
  let run: ContractRun;

  beforeAll(async () => {
    target = buildGoFixture();
    rea = await connectForContracts();
    run = await recordContracts(rea, target);
  }, 25 * 60_000);

  afterAll(async () => {
    await rea?.close();
    if (target) rmSync(dirname(target), { recursive: true, force: true });
  });

  it("live responses parse with Binlight's schemas", () => {
    expect(run.schemaProblems).toEqual([]);
  });

  it("live responses match the recorded shapes for this provider", () => {
    const recorded = loadRecordings(PINNED_REA_VERSION).find(
      (r) => r.provider === run.recording.provider,
    );
    if (!recorded) {
      expect.fail(
        `No contract recorded for REA ${PINNED_REA_VERSION} with provider "${run.recording.provider}". ` +
          `Run: npm run contracts:record`,
      );
    }
    const problems = compareRecordings(recorded, run.recording);
    expect(problems, `REA contract broken:\n${problems.join("\n")}`).toEqual([]);
  });
});

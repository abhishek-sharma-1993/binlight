/**
 * Records REA's response shapes for the tools Binlight calls.
 *   npm run contracts:record                      local REA, auto provider
 *   npm run contracts:record -- --provider ghidra local REA, forced provider
 *   npm run contracts:record -- --runner docker   Ghidra in the runner image
 * Run after deliberately upgrading REA, then review the diff in git.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  buildGoFixture,
  openContractSession,
  recordContracts,
  recordingPath,
  type ContractRunner,
} from "./run.js";

const option = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const runner: ContractRunner = option("--runner") === "docker" ? "docker" : "local";

const fixture = buildGoFixture();
const session = await openContractSession(runner, fixture);
try {
  const started = Date.now();
  const provider = option("--provider") ?? session.provider;
  const { recording, schemaProblems } = await recordContracts(
    session.rea,
    session.target,
    provider,
  );
  if (schemaProblems.length > 0) {
    console.error("REA responses do not match src/rea/schemas.ts; nothing written:");
    for (const p of schemaProblems) console.error(`  ${p}`);
    process.exitCode = 1;
  } else {
    recording.recordedOn.runner = runner;
    const file = recordingPath(recording.reaVersion, recording.provider);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(recording, null, 2) + "\n");
    console.log(
      `Recorded REA ${recording.reaVersion} / ${recording.provider} in ${Date.now() - started} ms -> ${file}`,
    );
  }
} finally {
  await session.close();
  rmSync(dirname(fixture), { recursive: true, force: true });
}

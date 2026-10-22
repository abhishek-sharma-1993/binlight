/**
 * Records REA's response shapes for the tools Binlight calls.
 *   npm run contracts:record                      auto provider
 *   npm run contracts:record -- --provider ghidra force a deep provider
 * Run after deliberately upgrading REA, then review the diff in git.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildGoFixture, connectForContracts, recordContracts, recordingPath } from "./run.js";

const flag = process.argv.indexOf("--provider");
const provider = flag >= 0 ? process.argv[flag + 1] : undefined;

const target = buildGoFixture();
const rea = await connectForContracts();
try {
  const started = Date.now();
  const { recording, schemaProblems } = await recordContracts(rea, target, provider);
  if (schemaProblems.length > 0) {
    console.error("REA responses do not match src/rea/schemas.ts; nothing written:");
    for (const p of schemaProblems) console.error(`  ${p}`);
    process.exitCode = 1;
  } else {
    const file = recordingPath(recording.reaVersion, recording.provider);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(recording, null, 2) + "\n");
    console.log(
      `Recorded REA ${recording.reaVersion} / ${recording.provider} in ${Date.now() - started} ms -> ${file}`,
    );
  }
} finally {
  await rea.close();
  rmSync(dirname(target), { recursive: true, force: true });
}

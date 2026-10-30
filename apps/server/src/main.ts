import { createApp } from "./app.js";
import { EvidenceCache } from "./cache/evidence.js";
import { JobManager } from "./jobs/manager.js";
import { preflight } from "./preflight/index.js";
import { formatReaLog } from "./rea/log.js";
import { openReaSession } from "./runner/index.js";
import { claudeWriter, DEFAULT_AI_MODEL } from "./verdict/index.js";

const port = Number(process.env["PORT"] ?? 8787);
/** Ghidra heap inside the Docker runner, e.g. "6G". Default 4G (the Docker VM has 8 GB). */
const ghidraMaxMem = process.env["BINLIGHT_GHIDRA_MAXMEM"];
/**
 * AI verdicts are opt-in until the page has key entry and a privacy preview
 * (phase 1 task 4): BINLIGHT_AI=on, with your key in ANTHROPIC_API_KEY.
 */
const ai =
  process.env["BINLIGHT_AI"] === "on"
    ? claudeWriter({ model: process.env["BINLIGHT_AI_MODEL"] ?? DEFAULT_AI_MODEL })
    : undefined;

const jobs = new JobManager({
  cache: new EvidenceCache(),
  ...(ai && { ai }),
  preflight: (path) => preflight(path),
  openSession: (path, deep, onLog) =>
    openReaSession(path, deep, {
      onStderr: (line) => onLog(formatReaLog(line)),
      ...(ghidraMaxMem && { docker: { ghidraMaxMem } }),
    }),
});

createApp({ jobs }).listen(port, "127.0.0.1", () => {
  console.log(`binlight server on http://127.0.0.1:${port}`);
  console.log(ai ? `AI verdicts: on (${ai.model})` : "AI verdicts: off (local-only)");
});

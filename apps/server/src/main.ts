import { createApp } from "./app.js";
import { EvidenceCache } from "./cache/evidence.js";
import { HistoryFile } from "./history/history.js";
import { JobManager } from "./jobs/manager.js";
import { preflight } from "./preflight/index.js";
import { formatReaLog } from "./rea/log.js";
import { openReaSession } from "./runner/index.js";
import { AiService, MacKeychain, SettingsFile } from "./settings/index.js";

const port = Number(process.env["PORT"] ?? 8787);
/** Ghidra heap inside the Docker runner, e.g. "6G". Default 4G (the Docker VM has 8 GB). */
const ghidraMaxMem = process.env["BINLIGHT_GHIDRA_MAXMEM"];
/**
 * AI settings live in ~/.binlight/settings.json (local-only by default); the
 * user's key in the macOS Keychain, entered in the page, or ANTHROPIC_API_KEY.
 */
const settingsPath = process.env["BINLIGHT_SETTINGS_PATH"];
const ai = new AiService(new SettingsFile(settingsPath), new MacKeychain());

const jobs = new JobManager({
  cache: new EvidenceCache(),
  ai,
  history: new HistoryFile(),
  preflight: (path) => preflight(path),
  openSession: (path, deep, onLog) =>
    openReaSession(path, deep, {
      onStderr: (line) => onLog(formatReaLog(line)),
      ...(ghidraMaxMem && { docker: { ghidraMaxMem } }),
    }),
});

createApp({ jobs, ai }).listen(port, "127.0.0.1", () => {
  console.log(`binlight server on http://127.0.0.1:${port}`);
  void ai.status().then((s) => console.log(`AI: ${s.mode} (${s.model}); key: ${s.key.source}`));
});

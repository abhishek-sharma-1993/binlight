import { createApp } from "./app.js";
import { JobManager } from "./jobs/manager.js";
import { preflight } from "./preflight/index.js";
import { formatReaLog } from "./rea/log.js";
import { openReaSession } from "./runner/index.js";

const port = Number(process.env["PORT"] ?? 8787);

const jobs = new JobManager({
  preflight: (path) => preflight(path),
  openSession: (path, deep, onLog) =>
    openReaSession(path, deep, { onStderr: (line) => onLog(formatReaLog(line)) }),
});

createApp({ jobs }).listen(port, "127.0.0.1", () => {
  console.log(`binlight server on http://127.0.0.1:${port}`);
});

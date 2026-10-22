/**
 * Runs preflight on a target and prints the report.
 *   npm run preflight -- <path> [--json]
 */
import { preflight } from "../preflight/index.js";

const target = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!target) {
  console.error("usage: npm run preflight -- <path> [--json]");
  process.exit(2);
}

const started = Date.now();
const report = await preflight(target);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const t = report.target;
  console.log(`${t.path}`);
  console.log(`  format:        ${t.format} [${t.architectures.join(", ")}]`);
  if (t.executable) console.log(`  executable:    ${t.executable.path} (${t.executable.format})`);
  if (report.analysisPath) {
    console.log(`  analyse:       ${report.analysisPath} (${report.analysisArchitecture})`);
  }
  for (const r of report.routes) {
    const mark = r === report.deep ? "->" : r.available ? "ok" : "--";
    console.log(`  ${mark} ${r.route.padEnd(14)} ${r.available ? "available" : r.reason}`);
  }
  for (const i of report.issues) {
    console.log(`  [${i.severity}] ${i.code}: ${i.message}`);
    if (i.remediation) console.log(`      fix: ${i.remediation}`);
  }
  const deep = report.deep ? `${report.deep.route} (provider ${report.deep.providerId})` : "none";
  console.log(`  deep analysis: ${report.canAnalyse ? deep : "n/a"}`);
  console.log(`  can analyse:   ${report.canAnalyse}  (${Date.now() - started} ms)`);
}

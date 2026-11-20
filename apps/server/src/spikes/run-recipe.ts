// Runs one recipe on one binary through the real job engine and prints the
// outcome (a development aid): run-recipe.ts <recipe-id> <binary>
import { EvidenceCache } from "../cache/evidence.js";
import { JobManager } from "../jobs/manager.js";
import { preflight } from "../preflight/index.js";
import { RECIPES } from "../recipes/index.js";
import { openReaSession } from "../runner/index.js";

const [recipe, target] = process.argv.slice(2);
if (!recipe || !target) throw new Error("usage: run-recipe.ts <recipe-id> <binary>");
const jobs = new JobManager({
  recipes: RECIPES,
  cache: new EvidenceCache(),
  preflight: (path) => preflight(path),
  openSession: (path, deep) => openReaSession(path, deep),
});
const job = await jobs.settled(jobs.create({ recipe, targets: [target] }).id);
for (const s of job?.steps ?? []) {
  console.log(
    `${s.status.padEnd(8)} ${String(s.elapsedMs ?? "").padStart(8)} ms  ${s.id}: ${s.summary ?? s.reason ?? s.error?.message ?? ""}`,
  );
}
for (const r of job?.rules ?? []) console.log(`rule ${r.id}: ${r.status} ${r.reason ?? ""}`);
for (const f of job?.findings ?? []) console.log(`  [${f.kind}] ${f.statement}`);
console.log(`VERDICT: ${job?.verdict?.rules.answer}`);

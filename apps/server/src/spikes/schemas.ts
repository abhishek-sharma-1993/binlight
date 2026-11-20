// Prints REA input schemas for the tools the phone-home spike needs.
import { ReaClient } from "../rea/client.js";
import { reaEnvOptionsFromProcess } from "../rea/env.js";

const wanted = new Set(process.argv.slice(2));
const rea = await ReaClient.connect(reaEnvOptionsFromProcess());
try {
  for (const t of await rea.listTools()) {
    if (wanted.has(t.name)) console.log(t.name, JSON.stringify(t.inputSchema));
  }
} finally {
  await rea.close();
}

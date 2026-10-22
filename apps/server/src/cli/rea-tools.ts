/**
 * Connects to the pinned `rea --mcp` and prints its `tools/list`.
 *   npm run rea:tools            summary
 *   npm run rea:tools -- --json  full tool list as JSON
 */
import { ReaClient, reaEnvOptionsFromProcess } from "../rea/index.js";

const rea = await ReaClient.connect(reaEnvOptionsFromProcess());
try {
  const tools = await rea.listToolInfo();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(tools, null, 2));
  } else {
    console.log(`REA ${rea.version}: ${tools.length} tools`);
    for (const tool of tools) {
      console.log(`  ${tool.name.padEnd(42)} ${tool.title ?? ""}`);
    }
  }
} finally {
  await rea.close();
}

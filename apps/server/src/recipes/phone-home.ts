import { overviewOutcome } from "../jobs/steps.js";
import type { ToolOutput } from "../rea/schemas.js";
import { credentialBytes, destinations, networkCapability } from "../rules/index.js";
import { phoneHomeVerdict } from "./phone-home-verdict.js";
import {
  credentialsOutcome,
  findCredentials,
  findNetworkFunctions,
  networkOutcome,
  traceUrls,
  urlsOutcome,
} from "./phone-home-steps.js";
import type { Recipe } from "./types.js";

/** Hard-coded destinations, what code uses them, network capability and embedded keys. */
export const phoneHome: Recipe = {
  id: "phone-home",
  title: "Does it phone home?",
  question: "What could it contact, and from where in its code?",
  description:
    "Finds the web addresses written into the binary, which ones its code uses (and in which function), what network work it can do, and any embedded keys. Needs the disassembler: minutes, not seconds.",
  targets: 1,
  targetLabels: ["Binary"],
  rules: [destinations, networkCapability, credentialBytes],
  verdict: phoneHomeVerdict,
  steps: [
    {
      id: "overview",
      label: "Analyse with the disassembler",
      why: "Runs the disassembler's analysis once; every later step reuses it.",
      tool: "binary_overview",
      deep: true,
      outcome: (r) => overviewOutcome(r as ToolOutput<"binary_overview">),
    },
    {
      id: "urls",
      label: "Find web addresses and the code that uses them",
      why: "Searches the bytes for http(s)://, then follows references from each address to the function that uses it.",
      tool: "search_bytes",
      deep: true,
      run: traceUrls,
      outcome: urlsOutcome,
    },
    {
      id: "network",
      label: "Check what network work it can do",
      why: "Looks for well-known Go network functions (HTTP client and server, TLS, sockets) linked into the binary.",
      tool: "search_bytes",
      deep: true,
      run: findNetworkFunctions,
      outcome: networkOutcome,
    },
    {
      id: "secrets",
      label: "Look for embedded keys",
      why: "Searches the bytes for well-known key formats (AWS, GitHub, Slack, Google, OpenAI-style, private keys).",
      tool: "search_bytes",
      deep: true,
      run: findCredentials,
      outcome: credentialsOutcome,
    },
  ],
};

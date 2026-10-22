export {
  ReaClient,
  type CallOptions,
  type ReaClientOptions,
  type ReaToolResult,
} from "./client.js";
export { buildReaEnv, reaEnvOptionsFromProcess, type ReaEnvOptions } from "./env.js";
export { ReaProcessError, ReaToolError, reaErrorFromResult } from "./errors.js";
export { installedRea, PINNED_REA_VERSION } from "./version.js";

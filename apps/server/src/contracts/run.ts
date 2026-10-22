import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReaClient } from "../rea/client.js";
import { reaEnvOptionsFromProcess } from "../rea/env.js";
import { ReaToolError } from "../rea/errors.js";
import { isContractTool, reaErrorSchema, toolSchemas } from "../rea/schemas.js";
import { openReaSession } from "../runner/session.js";
import { diffShapes, formatShapeDiff, shapeOf, type Shape } from "./shape.js";

/**
 * Contract runs: call each REA tool Binlight uses against a tiny Go binary
 * built from test/fixtures/hello-go, and either record the response shapes
 * (`npm run contracts:record`) or check them against the recording
 * (`npm run test:contract`).
 */

const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
export const contractsDir = join(serverRoot, "test/contracts");
const fixtureSource = join(serverRoot, "test/fixtures/hello-go");
const FIXTURE = "$FIXTURE";
const CALL_TIMEOUT_MS = 20 * 60_000;
const SAMPLE_ITEMS = 5;

type Args = (target: string) => Record<string, unknown>;

/** The tools Binlight calls, in session order: one open, many reads, one close. */
const STEPS: { tool: string; args: Args }[] = [
  { tool: "inspect_go_binary", args: (t) => ({ path: t }) },
  { tool: "open_binary", args: (t) => ({ path: t }) },
  { tool: "binary_overview", args: () => ({}) },
  { tool: "list_strings", args: () => ({}) },
  { tool: "list_procedures", args: () => ({}) },
  { tool: "close_binary", args: () => ({}) },
];

/** Failures Binlight must be able to explain, run after the session is closed. */
const ERROR_CASES: { name: string; tool: string; args: Args; code: string }[] = [
  {
    name: "missing file",
    tool: "open_binary",
    args: () => ({ path: "/nonexistent/binlight-contract-target" }),
    code: "target_unavailable",
  },
  { name: "nothing open", tool: "binary_overview", args: () => ({}), code: "target_unavailable" },
];

export interface StepRecord {
  tool: string;
  args: Record<string, unknown>;
  shape: Shape;
  /** The real response, with the fixture path replaced and arrays cut to a few items. */
  sample: unknown;
}

export interface ErrorRecord {
  name: string;
  tool: string;
  code: string;
  shape: Shape;
  sample: unknown;
}

export interface ContractRecording {
  reaVersion: string;
  /** The deep-analysis provider REA chose for open_binary. */
  provider: string;
  /** Host that ran the recording; `runner` says whether REA ran on it or in Docker. */
  recordedOn: { platform: string; arch: string; goVersion: string; runner?: ContractRunner };
  inputSchemas: Record<string, unknown>;
  steps: StepRecord[];
  errors: ErrorRecord[];
}

export function buildGoFixture(): string {
  const out = join(mkdtempSync(join(tmpdir(), "binlight-contract-")), "hello-go");
  try {
    // Reproducible build: same Go version, same bytes, so recordings don't churn.
    execFileSync(
      "go",
      ["build", "-trimpath", "-buildvcs=false", "-ldflags=-buildid=", "-o", out, "."],
      {
        cwd: fixtureSource,
        env: { ...process.env, CGO_ENABLED: "0" },
        stdio: "pipe",
      },
    );
  } catch (err) {
    throw new Error(
      `Could not build the contract fixture with Go (needed for contract runs): ${String(err)}`,
      { cause: err },
    );
  }
  return out;
}

function goVersion(): string {
  return execFileSync("go", ["env", "GOVERSION"], { encoding: "utf8" }).trim();
}

/** Replaces the fixture's temp path and cuts long arrays, so recordings stay small and stable. */
function sampleOf(value: unknown, target: string): unknown {
  const cut = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.slice(0, SAMPLE_ITEMS).map(cut);
    if (typeof v === "object" && v !== null) {
      return Object.fromEntries(Object.entries(v).map(([k, c]) => [k, cut(c)]));
    }
    return typeof v === "string" ? v.replaceAll(target, FIXTURE) : v;
  };
  return cut(value);
}

function substituted(args: Record<string, unknown>, target: string): Record<string, unknown> {
  return sampleOf(args, target) as Record<string, unknown>;
}

export interface ContractRun {
  recording: ContractRecording;
  /** Full live responses that Binlight's schemas reject. */
  schemaProblems: string[];
}

/** Runs every step and error case against a live REA and records what came back. */
export async function recordContracts(
  rea: ReaClient,
  target: string,
  provider?: string,
): Promise<ContractRun> {
  const schemaIssues: string[] = [];
  const tools = await rea.listTools();
  const used = new Set([...STEPS, ...ERROR_CASES].map((s) => s.tool));
  const inputSchemas = Object.fromEntries(
    tools.filter((t) => used.has(t.name)).map((t) => [t.name, t.inputSchema]),
  );

  const steps: StepRecord[] = [];
  let chosenProvider: string | undefined;
  for (const step of STEPS) {
    const args = step.args(target);
    if (step.tool === "open_binary" && provider) args["provider_id"] = provider;
    const { structured } = await rea.callTool(step.tool, args, { timeoutMs: CALL_TIMEOUT_MS });
    schemaIssues.push(...schemaProblems(step.tool, structured));
    if (step.tool === "list_strings") {
      chosenProvider = (structured as { provider?: { id?: string } }).provider?.id;
    }
    steps.push({
      tool: step.tool,
      args: substituted(args, target),
      shape: shapeOf(structured),
      sample: sampleOf(structured, target),
    });
  }

  const errors: ErrorRecord[] = [];
  for (const c of ERROR_CASES) {
    const err = await rea.callTool(c.tool, c.args(target)).then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(err instanceof ReaToolError)) {
      throw new Error(
        `Expected ${c.tool} (${c.name}) to fail with a REA error, got ${String(err)}`,
      );
    }
    const body = { error: err.rea };
    schemaIssues.push(...errorSchemaProblems(c.name, body));
    errors.push({
      name: c.name,
      tool: c.tool,
      code: err.rea.code,
      shape: shapeOf(body),
      sample: sampleOf(body, target),
    });
  }

  if (!chosenProvider) throw new Error("list_strings returned no provider id");
  return {
    recording: {
      reaVersion: rea.version,
      provider: chosenProvider,
      recordedOn: { platform: process.platform, arch: process.arch, goVersion: goVersion() },
      inputSchemas,
      steps,
      errors,
    },
    schemaProblems: schemaIssues,
  };
}

export function recordingPath(reaVersion: string, provider: string): string {
  return join(contractsDir, `rea-${reaVersion}`, `${provider}.json`);
}

export function loadRecordings(reaVersion: string): ContractRecording[] {
  const dir = join(contractsDir, `rea-${reaVersion}`);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as ContractRecording);
}

/** Checks a value against the schema Binlight parses it with. */
export function schemaProblems(tool: string, value: unknown): string[] {
  const schema = isContractTool(tool) ? toolSchemas[tool] : undefined;
  if (!schema) return [`${tool}: no schema in src/rea/schemas.ts`];
  const parsed = schema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((i) => `${tool}: ${i.path.join(".") || "$"}: ${i.message}`);
}

export function errorSchemaProblems(name: string, value: unknown): string[] {
  const parsed = reaErrorSchema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((i) => `error "${name}": ${i.path.join(".")}: ${i.message}`);
}

/**
 * Everything that differs between a recording and a live run. Empty means the
 * REA contract holds. Any change, even an added field, is reported so a REA
 * upgrade is reviewed and re-recorded deliberately.
 */
export function compareRecordings(recorded: ContractRecording, live: ContractRecording): string[] {
  const problems: string[] = [];
  if (recorded.reaVersion !== live.reaVersion) {
    problems.push(`REA version: recorded ${recorded.reaVersion}, live ${live.reaVersion}`);
  }

  for (const [tool, schema] of Object.entries(recorded.inputSchemas)) {
    if (JSON.stringify(schema) !== JSON.stringify(live.inputSchemas[tool])) {
      problems.push(`${tool}: input schema changed`);
    }
  }

  const pairs: [string, Shape, Shape | undefined][] = [
    ...recorded.steps.map((s): [string, Shape, Shape | undefined] => [
      s.tool,
      s.shape,
      live.steps.find((l) => l.tool === s.tool)?.shape,
    ]),
    ...recorded.errors.map((e): [string, Shape, Shape | undefined] => [
      `error "${e.name}"`,
      e.shape,
      live.errors.find((l) => l.name === e.name)?.shape,
    ]),
  ];
  for (const [what, before, after] of pairs) {
    if (!after) {
      problems.push(`${what}: missing from live run`);
      continue;
    }
    const diff = diffShapes(before, after);
    if (diff.added.length + diff.removed.length + diff.changed.length > 0) {
      problems.push(`${what}: response shape changed\n${formatShapeDiff(diff)}`);
    }
  }

  for (const e of recorded.errors) {
    const l = live.errors.find((x) => x.name === e.name);
    if (l && l.code !== e.code) problems.push(`error "${e.name}": code ${e.code} -> ${l.code}`);
  }
  return problems;
}

export type ContractRunner = "local" | "docker";

export interface ContractSession {
  rea: ReaClient;
  /** The fixture path as REA sees it. */
  target: string;
  /** Deep provider to force, if the runner implies one. */
  provider?: string;
  close(): Promise<void>;
}

/**
 * "local": the pinned REA on this machine, provider chosen by REA.
 * "docker": REA + Ghidra in the runner image, the route used on Apple Silicon.
 */
export async function openContractSession(
  runner: ContractRunner,
  hostTarget: string,
): Promise<ContractSession> {
  if (runner === "docker") {
    const session = await openReaSession("docker-ghidra", "ghidra", hostTarget);
    return { rea: session.rea, target: session.target, provider: "ghidra", close: session.close };
  }
  const rea = await ReaClient.connect(reaEnvOptionsFromProcess());
  return { rea, target: hostTarget, close: () => rea.close() };
}

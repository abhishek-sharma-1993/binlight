import type { PreflightReport, RouteDecision } from "@binlight/shared";
import type { CallOptions, ReaToolResult } from "../rea/client.js";
import type { JobDeps, JobSession } from "./manager.js";

// Test doubles for the job runner: a scripted REA whose results pass Binlight's real schemas.

const hex = (c: string) => c.repeat(64);

export function evidence(operation: string, normalized: unknown) {
  return {
    evidence_id: `ev_${hex("a")}`,
    subject: {
      name: "tool",
      digest: { sha256: hex("b") },
      local_path: "/target/tool",
      format: "mach-o",
      architecture: "arm64",
    },
    provider: { id: "ghidra", name: "Ghidra", version: "12.1.4" },
    operation,
    confidence: "observed",
    limitations: [],
    normalized_result: normalized,
  };
}

const goModule = (path: string, version: string) => ({ path, version, sum: "", replacement: null });

export const goodResults: Record<string, unknown> = {
  open_binary: {
    result: {
      path: "/target/tool",
      format: "mach-o",
      kind: "executable",
      sha256: hex("b"),
      architecture: "arm64",
    },
  },
  inspect_go_binary: evidence("inspect_go_binary", {
    format: "macho",
    architecture: "arm64",
    build_info: {
      go_version: "go1.27.2",
      module: {
        path: "example.com/tool",
        main: goModule("example.com/tool", "v1.0.0"),
        dependencies: [goModule("example.com/a", "v1"), goModule("example.com/b", "v2")],
        settings: [],
        complete: true,
      },
    },
  }),
  binary_overview: evidence("binary_overview", {
    document: "tool",
    segments: [],
    segment_count: 19,
    procedure_count: 37246,
    string_count: 97076,
  }),
  list_strings: evidence("list_strings", [{ address: "0x1", value: "hello" }]),
  list_procedures: evidence("list_procedures", [
    { address: "0x1", value: "main" },
    { address: "0x2", value: "init" },
  ]),
  close_binary: { result: null },
};

type Handler = (args: Record<string, unknown>, options: CallOptions) => Promise<unknown>;

export interface FakeRea {
  calls: string[];
  closed: number;
  session: JobSession;
}

/** A session whose tools return `goodResults` unless `handlers` override them. */
export function fakeSession(
  deep: Pick<RouteDecision, "route" | "providerId"> | undefined,
  handlers: Record<string, Handler> = {},
): FakeRea {
  const fake: FakeRea = {
    calls: [],
    closed: 0,
    session: {
      rea: {
        version: "6.7.0",
        async callTool(name, args = {}, options = {}): Promise<ReaToolResult> {
          fake.calls.push(name);
          const handler = handlers[name];
          const structured = handler ? await handler(args, options) : goodResults[name];
          return { structured, untrustedContent: true, raw: { content: [] } };
        },
      },
      ...(deep && { deep }),
      target: "/target/tool",
      close: async () => {
        fake.closed++;
      },
    },
  };
  return fake;
}

/** Resolves when the call's abort signal fires, like a long REA analysis being cancelled. */
export const untilAborted: Handler = (_args, options) =>
  new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

export const dockerRoute: RouteDecision = {
  route: "docker-ghidra",
  providerId: "ghidra",
  available: true,
};

export function report(overrides: Partial<PreflightReport> = {}): PreflightReport {
  return {
    target: { path: "/apps/tool", format: "mach-o", architectures: ["arm64"] },
    analysisPath: "/apps/tool",
    analysisArchitecture: "arm64",
    deep: dockerRoute,
    routes: [dockerRoute],
    issues: [],
    canAnalyse: true,
    ...overrides,
  };
}

export function deps(fake: FakeRea, pre: PreflightReport = report()): JobDeps & { opened: number } {
  const d = {
    opened: 0,
    preflight: async () => pre,
    openSession: async () => {
      d.opened++;
      return fake.session;
    },
    heartbeatMs: 10,
  };
  return d;
}

import type { ReaToolInfo } from "@binlight/shared";
import { Client, type CallToolResult, type Tool } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildReaEnv, REA_MAX_RESPONSE_BYTES, type ReaEnvOptions } from "./env.js";
import { ReaProcessError, ReaToolError, reaErrorFromResult } from "./errors.js";
import { installedRea, PINNED_REA_VERSION } from "./version.js";

const STDERR_TAIL_LINES = 50;

export interface ReaClientOptions extends ReaEnvOptions {
  /** Override the command (tests, or the Docker runner in task 5). Defaults to the pinned rea-agents. */
  command?: { command: string; args: string[] };
  /** Refuse to talk to any other REA version. Defaults to the pinned version. */
  expectedVersion?: string;
  /** Each line REA writes to stderr (it logs JSON there). */
  onStderr?: (line: string) => void;
  /** Timeout for the MCP handshake. */
  connectTimeoutMs?: number;
}

export interface CallOptions {
  /** Per-call timeout. Deep analysis needs minutes, so pass this for slow tools. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ReaToolResult {
  /** REA's structured result (usually an Evidence record with an `evidence_id`). */
  structured: unknown;
  /** REA marks content that came from the analysed target as untrusted. */
  untrustedContent: boolean;
  raw: CallToolResult;
}

/** One `rea --mcp` process and MCP session. Open one binary per client and reuse it. */
export class ReaClient {
  private closed = false;

  private constructor(
    private readonly client: Client,
    /** Shared with the stderr listener, which keeps appending after connect. */
    private readonly stderrTail: string[],
    readonly version: string,
  ) {}

  static async connect(options: ReaClientOptions = {}): Promise<ReaClient> {
    const expected = options.expectedVersion ?? PINNED_REA_VERSION;
    const command = options.command ?? {
      command: process.execPath,
      args: [installedRea().entry, "--mcp"],
    };

    const transport = new StdioClientTransport({
      command: command.command,
      args: command.args,
      env: buildReaEnv(options),
      stderr: "pipe",
      // Must be at least REA's response budget, plus room for the JSON-RPC envelope.
      maxBufferSize: REA_MAX_RESPONSE_BYTES + 1024 * 1024,
    });
    const client = new Client({ name: "binlight", version: "0.0.0" });
    const tail: string[] = [];
    transport.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > STDERR_TAIL_LINES) tail.shift();
        options.onStderr?.(line);
      }
    });

    try {
      await client.connect(transport, { timeout: options.connectTimeoutMs ?? 60_000 });
    } catch (err) {
      await transport.close().catch(() => undefined);
      throw new ReaProcessError(
        `Could not start REA (${command.command} ${command.args.join(" ")}): ${String(err)}`,
        tail,
        { cause: err },
      );
    }

    const server = client.getServerVersion();
    if (server?.name !== "rea" || server.version !== expected) {
      await client.close();
      throw new ReaProcessError(
        `Expected REA ${expected}, but the MCP server reports ${server?.name ?? "?"} ${server?.version ?? "?"}.`,
        tail,
      );
    }

    const rea = new ReaClient(client, tail, server.version);
    client.onclose = () => {
      rea.closed = true;
    };
    return rea;
  }

  /** Every tool REA advertises (all pages). */
  async listTools(): Promise<Tool[]> {
    return this.guard("tools/list", async () => (await this.client.listTools()).tools);
  }

  async listToolInfo(): Promise<ReaToolInfo[]> {
    return (await this.listTools()).map((t) => ({
      name: t.name,
      ...(t.title !== undefined && { title: t.title }),
      ...(t.description !== undefined && { description: t.description }),
    }));
  }

  /**
   * Calls a REA tool. Resolves with REA's structured result, or throws
   * `ReaToolError` (REA's own code, message and remediation) when the tool fails.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: CallOptions = {},
  ): Promise<ReaToolResult> {
    const raw = await this.guard(name, () =>
      this.client.callTool(
        { name, arguments: args },
        {
          ...(options.timeoutMs !== undefined && { timeout: options.timeoutMs }),
          ...(options.signal !== undefined && { signal: options.signal }),
        },
      ),
    );
    if (raw.isError) throw new ReaToolError(name, reaErrorFromResult(raw));
    const provenance = raw._meta?.["provenance"];
    return {
      structured: raw.structuredContent,
      untrustedContent:
        typeof provenance === "object" &&
        provenance !== null &&
        (provenance as Record<string, unknown>)["untrusted_content"] === true,
      raw,
    };
  }

  /** REA's recent stderr lines, for showing the real reason when something fails. */
  recentStderr(): string[] {
    return [...this.stderrTail];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close();
  }

  private async guard<T>(what: string, run: () => Promise<T>): Promise<T> {
    if (this.closed)
      throw new ReaProcessError(`REA is not running (${what}).`, this.recentStderr());
    try {
      return await run();
    } catch (err) {
      if (this.closed) {
        throw new ReaProcessError(`REA exited during ${what}.`, this.recentStderr(), {
          cause: err,
        });
      }
      throw err;
    }
  }
}

/**
 * The "Does it phone home?" steps. Each makes many REA calls (one per URL,
 * name or candidate), so findings can cite the exact call behind each claim.
 * See docs/spike-phone-home.md for why it works this way.
 */
import { openSync, readSync, closeSync } from "node:fs";
import type { StepOutcome, MultiCallResult } from "../jobs/steps.js";
import { GoFuncTable } from "../gosym/gosym.js";
import type { ToolOutput } from "../rea/schemas.js";
import { CREDENTIAL_PATTERNS } from "../rules/credentials.js";
import type { StepContext } from "./types.js";

type Ev<T> = T & { evidence_id: string };
const n = (v: number) => v.toLocaleString("en-US");
export const hexOf = (bytes: Buffer) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
const addr = (v: bigint | number) => `0x${v.toString(16)}`;
/** search_bytes pages are capped at 1,000; a few pages per pattern is plenty. */
const MAX_PAGES = 20;

async function searchAll(ctx: StepContext, pattern: Buffer) {
  const pages: {
    evidenceId: string;
    matches: ToolOutput<"search_bytes">["normalized_result"]["matches"];
  }[] = [];
  let cursor: string | undefined;
  do {
    const r = (await ctx.call("search_bytes", {
      pattern: hexOf(pattern),
      limit: 1000,
      ...(cursor && { cursor }),
    })) as Ev<ToolOutput<"search_bytes">>;
    pages.push({ evidenceId: r.evidence_id, matches: r.normalized_result.matches });
    cursor = r.normalized_result.next_cursor ?? undefined;
  } while (cursor && pages.length < MAX_PAGES);
  return { pages, truncated: cursor !== undefined };
}

async function readText(ctx: StepContext, address: string, length: number) {
  const r = (await ctx.call("read_bytes", { address, length })) as Ev<ToolOutput<"read_bytes">>;
  return {
    evidenceId: r.evidence_id,
    text: Buffer.from(r.normalized_result.bytes_hex, "hex").toString("latin1"),
  };
}

// --- URLs → code -----------------------------------------------------------

export interface UrlUse {
  /** Address of the reference (an instruction, or data for a hop). */
  from: string;
  xrefsEvidenceId: string;
  via: "direct" | "data-hop";
  /** For a hop: the data address (e.g. a Go string header) code refers to. */
  dataAddress?: string;
  hopEvidenceId?: string;
  procedure: { address: string; name: string; evidenceId: string };
  /** From Go's function table, checked against Ghidra's entry and REA's bytes. */
  go?: { name: string; file?: string; line?: number; nameEvidenceId: string };
}

export interface UrlOccurrence {
  address: string;
  segment?: string;
  searchEvidenceId: string;
  /** Up to 160 characters from the URL's start, as REA read them. */
  text: string;
  readEvidenceId: string;
  uses: UrlUse[];
}

export interface UrlsData {
  /** Whether Go's function table was read (names for Go binaries). */
  goNames: "read" | "not-go" | "unreadable";
  truncated: boolean;
  occurrences: UrlOccurrence[];
}

export async function traceUrls(ctx: StepContext): Promise<UrlsData> {
  let table: GoFuncTable | undefined;
  let goNames: UrlsData["goNames"];
  try {
    table = GoFuncTable.fromFile(ctx.hostPath);
    goNames = table ? "read" : "not-go";
  } catch {
    goNames = "unreadable";
  }
  const confirmed = new Map<string, UrlUse["go"] | null>();

  // A Go name counts only when its entry is Ghidra's and REA reads the same bytes.
  async function goName(from: string, procedure: string): Promise<UrlUse["go"] | undefined> {
    const f = table?.at(Number(BigInt(from)));
    if (!f || BigInt(f.entry) !== BigInt(procedure)) return undefined;
    const key = String(f.entry);
    if (!confirmed.has(key)) {
      const read = await readText(ctx, addr(f.nameAddress), Buffer.byteLength(f.name) + 1);
      const ok = Buffer.from(read.text, "latin1").equals(Buffer.from(`${f.name}\0`, "utf8"));
      confirmed.set(key, ok ? { name: f.name, nameEvidenceId: read.evidenceId } : null);
    }
    const base = confirmed.get(key);
    if (!base) return undefined;
    return {
      ...base,
      ...(f.file && { file: f.file }),
      ...(f.line !== undefined && { line: f.line }),
    };
  }

  async function procedureAt(from: string) {
    const r = (await ctx.call("resolve_containing_procedure", { address: from })) as Ev<
      ToolOutput<"resolve_containing_procedure">
    >;
    const p = r.normalized_result.procedure;
    return r.normalized_result.found && p
      ? { address: p.address, name: p.name, evidenceId: r.evidence_id }
      : undefined;
  }

  async function refsTo(address: string) {
    const r = (await ctx.call("xrefs", { address })) as Ev<ToolOutput<"xrefs">>;
    return { evidenceId: r.evidence_id, froms: [...new Set(r.normalized_result)] };
  }

  const occurrences: UrlOccurrence[] = [];
  let truncated = false;
  for (const scheme of ["https://", "http://"]) {
    const found = await searchAll(ctx, Buffer.from(scheme, "latin1"));
    truncated ||= found.truncated;
    for (const page of found.pages) {
      for (const m of page.matches) {
        const read = await readText(ctx, m.address, 160);
        const occ: UrlOccurrence = {
          address: m.address,
          ...(m.segment && { segment: m.segment }),
          searchEvidenceId: page.evidenceId,
          text: read.text,
          readEvidenceId: read.evidenceId,
          uses: [],
        };
        const direct = await refsTo(m.address);
        for (const from of direct.froms) {
          const procedure = await procedureAt(from);
          if (procedure) {
            const go = await goName(from, procedure.address);
            occ.uses.push({
              from,
              xrefsEvidenceId: direct.evidenceId,
              via: "direct",
              procedure,
              ...(go && { go }),
            });
            continue;
          }
          // Data that points at the URL (a Go string header): one hop to code.
          const hop = await refsTo(from);
          for (const from2 of hop.froms) {
            const p2 = await procedureAt(from2);
            if (!p2) continue;
            const go = await goName(from2, p2.address);
            occ.uses.push({
              from: from2,
              xrefsEvidenceId: direct.evidenceId,
              via: "data-hop",
              dataAddress: from,
              hopEvidenceId: hop.evidenceId,
              procedure: p2,
              ...(go && { go }),
            });
          }
        }
        occurrences.push(occ);
      }
    }
    ctx.log(`${scheme}: ${occurrences.length} occurrences so far`);
  }
  return { goNames, truncated, occurrences };
}

export function urlsOutcome(r: unknown): StepOutcome {
  const m = r as MultiCallResult<UrlsData>;
  const used = m.data.occurrences.filter((o) => o.uses.length > 0).length;
  return {
    summary: `${n(m.data.occurrences.length)} URLs in the file; ${n(used)} used by code it can point to`,
    counts: { urls: m.data.occurrences.length, used },
    evidenceCount: m.records.length,
    result: r,
  };
}

// --- Network capability (Go function names) ---------------------------------

/** Go standard-library and common functions that show what network work a binary can do. */
export const NETWORK_FUNCTIONS: { name: string; capability: string }[] = [
  { name: "net/http.(*Client).Do", capability: "makes HTTP requests" },
  { name: "net/http.(*Transport).RoundTrip", capability: "makes HTTP requests" },
  { name: "net.(*Dialer).DialContext", capability: "opens network connections" },
  { name: "crypto/tls.(*Conn).Handshake", capability: "uses TLS (HTTPS) connections" },
  { name: "net/http.(*Server).Serve", capability: "serves HTTP" },
  { name: "net.(*ListenConfig).Listen", capability: "listens for incoming connections" },
  {
    name: "github.com/gorilla/websocket.(*Dialer).DialContext",
    capability: "opens WebSocket connections",
  },
  { name: "google.golang.org/grpc.NewClient", capability: "makes gRPC calls" },
];

export interface NetworkData {
  goNames: boolean;
  functions: {
    name: string;
    capability: string;
    found?: { address: string; segment?: string; evidenceId: string };
    /** Searched, not found: its evidence. */
    searchEvidenceId: string;
  }[];
}

export async function findNetworkFunctions(ctx: StepContext): Promise<NetworkData> {
  let isGo: boolean;
  try {
    isGo = GoFuncTable.fromFile(ctx.hostPath) !== undefined;
  } catch {
    isGo = false;
  }
  const functions: NetworkData["functions"] = [];
  if (!isGo) return { goNames: false, functions };
  for (const f of NETWORK_FUNCTIONS) {
    // NUL on both sides: the exact name in Go's function-name table.
    const { pages } = await searchAll(ctx, Buffer.from(`\0${f.name}\0`, "utf8"));
    const page = pages[0] as (typeof pages)[number];
    const hit = pages
      .flatMap((p) => p.matches.map((m) => ({ ...m, evidenceId: p.evidenceId })))
      .find((m) => m.segment === "__gopclntab" || m.segment === ".gopclntab");
    functions.push({
      ...f,
      searchEvidenceId: page.evidenceId,
      ...(hit && {
        found: {
          // The name starts one byte after the leading NUL.
          address: addr(BigInt(hit.address) + 1n),
          ...(hit.segment && { segment: hit.segment }),
          evidenceId: hit.evidenceId,
        },
      }),
    });
  }
  return { goNames: true, functions };
}

export function networkOutcome(r: unknown): StepOutcome {
  const m = r as MultiCallResult<NetworkData>;
  if (!m.data.goNames) {
    return {
      summary: "Not a Go binary: network functions are only named for Go for now",
      evidenceCount: m.records.length,
      result: r,
    };
  }
  const found = m.data.functions.filter((f) => f.found).length;
  return {
    summary: `${found} of ${m.data.functions.length} network functions linked in`,
    counts: { found },
    evidenceCount: m.records.length,
    result: r,
  };
}

// --- Credential values ---------------------------------------------------------

/** Literal prefixes of CREDENTIAL_PATTERNS, searched as bytes. */
const CREDENTIAL_PREFIXES = [
  "AKIA",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "xox",
  "AIza",
  "-----BEGIN ",
  "eyJ",
];
const CONTEXT = 36;
const MAX_VALUE = 400;

export interface CredentialCandidate {
  label: string;
  /** Address of the match. */
  address: string;
  searchEvidenceId: string;
  /** Exactly what REA read: CONTEXT bytes before, the value, CONTEXT after. */
  text: string;
  valueStart: number;
  valueEnd: number;
  readEvidenceId: string;
}

export interface CredentialsData {
  searched: number;
  truncated: boolean;
  candidates: CredentialCandidate[];
}

/**
 * Searches each pattern's prefix with REA, pre-filters the matches against the
 * file's own bytes (search_bytes gives file offsets), and asks REA to read only
 * those that match a strict pattern.
 */
export async function findCredentials(ctx: StepContext): Promise<CredentialsData> {
  const fd = openSync(ctx.hostPath, "r");
  const local = (offset: number, length: number) => {
    const b = Buffer.alloc(length);
    const got = readSync(fd, b, 0, length, offset);
    return b.subarray(0, got).toString("latin1");
  };
  const candidates: CredentialCandidate[] = [];
  let searched = 0;
  let truncated = false;
  try {
    for (const prefix of CREDENTIAL_PREFIXES) {
      const found = await searchAll(ctx, Buffer.from(prefix, "latin1"));
      truncated ||= found.truncated;
      for (const page of found.pages) {
        for (const m of page.matches) {
          searched++;
          if (m.file_offset == null) continue;
          const ahead = local(m.file_offset, MAX_VALUE);
          for (const { label, pattern } of CREDENTIAL_PATTERNS) {
            const anchored = new RegExp(`^(?:${pattern.source})`);
            const hit = anchored.exec(ahead);
            if (!hit) continue;
            const start = BigInt(m.address) - BigInt(CONTEXT);
            const read = await readText(ctx, addr(start), CONTEXT + hit[0].length + CONTEXT);
            // Trust REA's bytes, not the pre-filter: the value must be there.
            if (read.text.slice(CONTEXT, CONTEXT + hit[0].length) !== hit[0]) continue;
            candidates.push({
              label,
              address: m.address,
              searchEvidenceId: page.evidenceId,
              text: read.text,
              valueStart: CONTEXT,
              valueEnd: CONTEXT + hit[0].length,
              readEvidenceId: read.evidenceId,
            });
            break;
          }
        }
      }
    }
  } finally {
    closeSync(fd);
  }
  return { searched, truncated, candidates };
}

export function credentialsOutcome(r: unknown): StepOutcome {
  const m = r as MultiCallResult<CredentialsData>;
  return {
    summary: `${n(m.data.searched)} prefix matches checked; ${n(m.data.candidates.length)} match a strict credential pattern`,
    counts: { candidates: m.data.candidates.length },
    evidenceCount: m.records.length,
    result: r,
  };
}

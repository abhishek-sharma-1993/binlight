/**
 * Phase 1 task 10 spike: from a hard-coded URL to the code that uses it.
 *
 *   npx tsx --conditions=@binlight/source src/spikes/phone-home.ts <binary> <out-dir>
 *
 * 1. Byte scan of the analysed file (Binlight, no REA): every "http(s)://" and
 *    its hostname. This is the oracle for what is really in the file.
 * 2. REA (Ghidra): `search_bytes` for "https://" and "http://", so each
 *    occurrence has an address and an evidence ID; `read_bytes` for its host.
 * 3. `xrefs` to each occurrence; `resolve_containing_procedure` for each
 *    reference. When a reference is data (a Go string header), one more hop:
 *    references to that data address.
 *
 * Writes raw first responses and a summary to <out-dir>. A spike, not product
 * code: it is kept for the record and is not imported by the server.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { preflight } from "../preflight/index.js";
import { ReaToolError } from "../rea/errors.js";
import { openReaSession } from "../runner/index.js";

const [target, outDir] = process.argv.slice(2);
if (!target || !outDir) throw new Error("usage: phone-home.ts <binary> <out-dir>");

const URL_START = /https?:\/\//gi;
const HOST = /^https?:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/i;
const hex = (s: string) =>
  [...Buffer.from(s, "latin1")].map((b) => b.toString(16).padStart(2, "0")).join(" ");
const WALK = 96;
const hostOf = (text: string) => HOST.exec(text)?.[1]?.toLowerCase();
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// --- 1. Byte scan (oracle) -------------------------------------------------
const report = await preflight(target);
if (!report.analysisPath || !report.deep) {
  throw new Error(`No deep route: ${JSON.stringify(report.issues.map((i) => i.message))}`);
}
const bytes = readFileSync(report.analysisPath).toString("latin1");
const scan = [...bytes.matchAll(URL_START)].map((m) => {
  const host = hostOf(bytes.slice(m.index, m.index + 300));
  return { offset: m.index, host };
});
const scanHosts = new Set(scan.flatMap((s) => (s.host ? [s.host] : [])));
log(
  `byte scan: ${scan.length} "http(s)://" (${scan.filter((s) => s.host).length} with a host), ${scanHosts.size} hosts`,
);

// --- 2. REA session --------------------------------------------------------
const session = await openReaSession(report.analysisPath, report.deep);
const raw: Record<string, unknown> = {};
const firstRaw = (tool: string, v: unknown) => (raw[tool] ??= v);
const timing: Record<string, { calls: number; ms: number }> = {};
async function call(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const started = Date.now();
  try {
    const { structured } = await session.rea.callTool(tool, args, { timeoutMs: 12 * 3600_000 });
    firstRaw(tool, structured);
    return structured;
  } finally {
    const t = (timing[tool] ??= { calls: 0, ms: 0 });
    t.calls++;
    t.ms += Date.now() - started;
  }
}
const nr = (v: unknown) => (v as { normalized_result?: unknown }).normalized_result ?? v;
/** Every value under `key` anywhere in a response (shapes are not known yet). */
function find(v: unknown, key: string): unknown[] {
  if (Array.isArray(v)) return v.flatMap((x) => find(x, key));
  if (v && typeof v === "object") {
    return Object.entries(v).flatMap(([k, x]) => (k === key ? [x] : find(x, key)));
  }
  return [];
}

try {
  log(`opening with ${report.deep.providerId} (Ghidra analysis runs now)…`);
  await call("open_binary", { path: session.target, provider_id: report.deep.providerId });
  const overview = nr(await call("binary_overview", {})) as Record<string, unknown>;
  log(`analysed: ${overview["procedure_count"]} procedures`);

  // search_bytes, paged.
  const matches: { address: string; evidenceId?: string }[] = [];
  for (const scheme of ["https://", "http://"]) {
    let cursor: string | undefined;
    do {
      const r = await call("search_bytes", {
        pattern: hex(scheme),
        limit: 1000,
        ...(cursor && { cursor }),
      });
      const evidenceId = (r as { evidence_id?: string }).evidence_id;
      const items = (find(nr(r), "matches")[0] ?? find(nr(r), "items")[0] ?? nr(r)) as unknown[];
      for (const m of Array.isArray(items) ? items : []) {
        const address =
          (m as { address?: string; start?: string }).address ?? (m as { start?: string }).start;
        if (address) matches.push({ address, ...(evidenceId && { evidenceId }) });
      }
      cursor = find(r, "next_cursor").find((c): c is string => typeof c === "string");
    } while (cursor);
  }
  log(`search_bytes: ${matches.length} matches`);

  // Per match: host, references, containing procedure.
  type Row = {
    address: string;
    host?: string;
    refs: string[];
    procedures: string[];
    via: "direct" | "data-hop" | "string-start" | "walk-back" | "none";
    /** Walk-back: bytes between the referenced address and the URL, and that text. */
    walkBack?: { distance: number; prefix: string };
    /** Start of the Ghidra string object that contains the URL, when it isn't the URL itself. */
    stringStart?: string;
    note?: string;
  };
  const rows: Row[] = [];
  const procOf = async (address: string): Promise<string | undefined> => {
    try {
      const r = nr(await call("resolve_containing_procedure", { address }));
      const name = find(r, "name")[0] ?? find(r, "procedure_name")[0];
      const entry = find(r, "entry")[0] ?? find(r, "entry_address")[0];
      const found = find(r, "found")[0] ?? find(r, "resolved")[0];
      if (found === false) return undefined;
      return typeof name === "string" ? name : typeof entry === "string" ? entry : undefined;
    } catch (err) {
      if (err instanceof ReaToolError) return undefined;
      throw err;
    }
  };
  const refsTo = async (address: string): Promise<string[]> => {
    // REA 6.7.0 / Ghidra: normalized_result is a plain list of addresses.
    const r = nr(await call("xrefs", { address }));
    const froms = Array.isArray(r) ? r : [...find(r, "from"), ...find(r, "address")];
    return [...new Set(froms.filter((f): f is string => typeof f === "string"))];
  };

  // Ghidra's string objects, to find the literal a mid-string URL belongs to.
  // Skip strings in other address spaces ("__DWARF:0x…"): code never points there.
  const strings = (nr(await call("list_strings", {})) as { address: string; value: string }[])
    .filter((x) => /^0x[0-9a-f]+$/i.test(x.address))
    .map((x) => ({
      start: BigInt(x.address),
      end: BigInt(x.address) + BigInt(Buffer.byteLength(x.value, "utf8")),
    }))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  log(`list_strings: ${strings.length} string objects`);
  const containing = (address: string) => {
    const a = BigInt(address);
    let lo = 0;
    let hi = strings.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((strings[mid] as { start: bigint }).start <= a) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const s = strings[best];
    return s && s.start < a && a < s.end ? `0x${s.start.toString(16)}` : undefined;
  };

  for (const m of matches) {
    const text = Buffer.from(
      String(
        (nr(await call("read_bytes", { address: m.address, length: 96 })) as { bytes_hex?: string })
          .bytes_hex ?? "",
      ),
      "hex",
    ).toString("latin1");
    const row: Row = { address: m.address, refs: [], procedures: [], via: "none" };
    const host = hostOf(text);
    if (host) row.host = host;
    row.refs = await refsTo(m.address);
    for (const from of row.refs) {
      const p = await procOf(from);
      if (p) row.procedures.push(p);
    }
    if (row.procedures.length > 0) row.via = "direct";
    else {
      for (const from of row.refs) {
        for (const from2 of await refsTo(from)) {
          const p = await procOf(from2);
          if (p) row.procedures.push(p);
        }
      }
      if (row.procedures.length > 0) row.via = "data-hop";
    }
    if (row.via === "none") {
      const start = containing(m.address);
      if (start) {
        row.stringStart = start;
        for (const from of await refsTo(start)) {
          const p = await procOf(from);
          if (p) row.procedures.push(p);
        }
        if (row.procedures.length > 0) row.via = "string-start";
      }
    }
    if (row.via === "none") {
      // Go references a literal's start; the URL may be inside the literal.
      // Walk back to the nearest referenced byte (inferred: it could be the
      // previous literal's reference).
      const a = BigInt(m.address);
      const before = Buffer.from(
        String(
          (
            nr(
              await call("read_bytes", {
                address: `0x${(a - BigInt(WALK)).toString(16)}`,
                length: WALK,
              }),
            ) as {
              bytes_hex?: string;
            }
          ).bytes_hex ?? "",
        ),
        "hex",
      ).toString("latin1");
      for (let d = 1; d <= WALK; d++) {
        const at = `0x${(a - BigInt(d)).toString(16)}`;
        const froms = await refsTo(at);
        if (froms.length === 0) continue;
        for (const from of froms) {
          const p = await procOf(from);
          if (p) row.procedures.push(p);
        }
        row.walkBack = { distance: d, prefix: before.slice(WALK - d) };
        if (row.procedures.length > 0) row.via = "walk-back";
        break;
      }
    }
    rows.push(row);
  }

  const withHost = rows.filter((r) => r.host);
  const hosts = new Map<string, Row[]>();
  for (const r of withHost)
    hosts.set(r.host as string, [...(hosts.get(r.host as string) ?? []), r]);
  const hostReached = [...hosts].filter(([, rs]) => rs.some((r) => r.via !== "none"));
  const summary = {
    target,
    analysisPath: report.analysisPath,
    route: report.deep.route,
    byteScan: {
      occurrences: scan.length,
      withHost: scan.filter((s) => s.host).length,
      hosts: scanHosts.size,
    },
    rea: {
      matches: matches.length,
      withHost: withHost.length,
      hosts: hosts.size,
      missingFromRea: [...scanHosts].filter((h) => !hosts.has(h)),
    },
    reach: {
      occurrencesWithRefs: withHost.filter((r) => r.refs.length > 0).length,
      direct: withHost.filter((r) => r.via === "direct").length,
      dataHop: withHost.filter((r) => r.via === "data-hop").length,
      stringStart: withHost.filter((r) => r.via === "string-start").length,
      walkBack: withHost.filter((r) => r.via === "walk-back").length,
      insideAStringObject: withHost.filter((r) => r.stringStart).length,
      none: withHost.filter((r) => r.via === "none").length,
      hostsReached: hostReached.length,
      hostsTotal: hosts.size,
    },
    timing,
    seconds: (Date.now() - t0) / 1000,
    hosts: Object.fromEntries(
      [...hosts].map(([h, rs]) => [
        h,
        {
          occurrences: rs.length,
          reached: rs.filter((r) => r.via !== "none").length,
          procedures: [...new Set(rs.flatMap((r) => r.procedures))].slice(0, 5),
        },
      ]),
    ),
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, "rows.json"), JSON.stringify(rows, null, 2));
  writeFileSync(join(outDir, "raw-first.json"), JSON.stringify(raw, null, 2).slice(0, 2_000_000));
  log(
    JSON.stringify({ byteScan: summary.byteScan, rea: { ...summary.rea }, reach: summary.reach }),
  );
} finally {
  writeFileSync(join(outDir, "raw-first.json"), JSON.stringify(raw, null, 2).slice(0, 2_000_000));
  await call("close_binary", {}).catch(() => undefined);
  await session.close();
}

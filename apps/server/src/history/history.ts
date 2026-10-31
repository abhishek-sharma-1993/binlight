import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { StepExpectation } from "@binlight/shared";

/** One live (not cached) step that finished on this machine. */
export interface StepRun {
  at: string;
  sha256: string;
  bytes: number;
  /** The REA tool, or a system step name ("start"). */
  tool: string;
  /** Deep-analysis route ("docker-ghidra"), or "local". */
  route: string;
  /** This call carried the disassembler's whole analysis (the first live deep call). */
  carriesAnalysis: boolean;
  elapsedMs: number;
}

/** What a step is, for matching it against history. */
export type StepKind = Pick<StepRun, "tool" | "route" | "carriesAnalysis">;

export interface StepHistory {
  record(run: StepRun): Promise<void>;
  expect(
    kind: StepKind,
    sha256: string,
    bytes: number | undefined,
  ): Promise<StepExpectation | undefined>;
}

export const defaultHistoryPath = (): string => join(homedir(), ".binlight", "history.jsonl");

/** Below this, a size-scaled estimate would mostly be start-up noise, so none is made. */
const MIN_SCALE_BYTES = 1024 * 1024;

const same = (a: StepKind, b: StepKind) =>
  a.tool === b.tool && a.route === b.route && a.carriesAnalysis === b.carriesAnalysis;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * Expected duration from past runs: the same bytes' last run of this kind of
 * step; otherwise, for analysis-carrying steps, other binaries' times scaled
 * by size. When past sizes differ enough, fit fixed time + time per byte (so
 * Ghidra's start-up cost is not multiplied by size); otherwise use the median
 * time per byte. No history means no expectation, never a guess.
 */
export function estimate(
  runs: StepRun[],
  kind: StepKind,
  sha256: string,
  bytes: number | undefined,
): StepExpectation | undefined {
  const matching = runs.filter((r) => same(r, kind));
  const mine = matching.filter((r) => r.sha256 === sha256);
  const last = mine.at(-1);
  if (last)
    return { ms: last.elapsedMs, basis: "same-binary", samples: mine.length, lastAt: last.at };
  // Only the analysis scales with size; quick calls are dominated by fixed costs.
  if (!kind.carriesAnalysis || !bytes) return undefined;
  const others = matching.filter((r) => r.bytes >= MIN_SCALE_BYTES);
  if (others.length === 0) return undefined;
  const fit = linearFit(others);
  const ms = fit
    ? fit.fixed + fit.perByte * bytes
    : median(others.map((r) => r.elapsedMs / r.bytes)) * bytes;
  return { ms: Math.round(ms), basis: "size-scaled", samples: others.length };
}

/** Least-squares fixed + perByte·bytes, when sizes span at least 2×; both terms non-negative. */
function linearFit(runs: StepRun[]): { fixed: number; perByte: number } | undefined {
  const sizes = runs.map((r) => r.bytes);
  if (Math.max(...sizes) < 2 * Math.min(...sizes)) return undefined;
  const n = runs.length;
  const mx = sizes.reduce((a, b) => a + b, 0) / n;
  const my = runs.reduce((a, r) => a + r.elapsedMs, 0) / n;
  const sxx = runs.reduce((a, r) => a + (r.bytes - mx) ** 2, 0);
  const sxy = runs.reduce((a, r) => a + (r.bytes - mx) * (r.elapsedMs - my), 0);
  const perByte = sxy / sxx;
  const fixed = my - perByte * mx;
  // A negative slope or intercept means the data don't support this model.
  if (perByte <= 0 || fixed < 0) return undefined;
  return { fixed, perByte };
}

/** History as JSON lines on disk; unreadable lines are skipped, never fatal. */
export class HistoryFile implements StepHistory {
  constructor(readonly path: string = defaultHistoryPath()) {}

  async record(run: StepRun): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, `${JSON.stringify(run)}\n`, { mode: 0o600 });
  }

  async read(): Promise<StepRun[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    return text.split("\n").flatMap((line) => {
      try {
        const run = JSON.parse(line) as StepRun;
        return typeof run.elapsedMs === "number" && typeof run.sha256 === "string" ? [run] : [];
      } catch {
        return [];
      }
    });
  }

  async expect(kind: StepKind, sha256: string, bytes: number | undefined) {
    return estimate(await this.read(), kind, sha256, bytes);
  }
}

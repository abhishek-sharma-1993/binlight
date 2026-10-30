import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseResult } from "../jobs/steps.js";

/** What a cached result depends on: the analysed bytes, REA, and the deep provider. */
export interface CacheKey {
  /** SHA-256 of the exact bytes REA analysed. */
  sha256: string;
  reaVersion: string;
  /** Deep provider id, or "none" for provider-free tools such as inspect_go_binary. */
  provider: string;
}

export interface CacheEntry {
  result: unknown;
  cachedAt: string;
  /** The job that produced it. */
  jobId: string;
}

export type CacheRead = { hit: true; entry: CacheEntry } | { hit: false; reason?: string };

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const VARIANT = /^[a-f0-9]{16}$/;

export const defaultEvidenceRoot = (): string => join(homedir(), ".binlight", "cache", "evidence");

/**
 * Successful REA results on disk, keyed by SHA-256 + REA version + provider,
 * one file per tool (and per argument set, when a call takes arguments beyond
 * the target path):
 *   <root>/<sha256>/rea-<version>/<provider>/<tool>[-<args hash>].json
 * Results are re-checked against Binlight's schemas when read, so a corrupt or
 * outdated entry is a miss (with the reason), never a wrong answer.
 */
export class EvidenceCache {
  constructor(readonly root: string = defaultEvidenceRoot()) {}

  pathFor(key: CacheKey, tool: string, variant = ""): string {
    if (!SHA256.test(key.sha256)) throw new Error(`Bad cache key sha256: ${key.sha256}`);
    if (!VERSION.test(key.reaVersion)) throw new Error(`Bad cache key version: ${key.reaVersion}`);
    if (!NAME.test(key.provider)) throw new Error(`Bad cache key provider: ${key.provider}`);
    if (!NAME.test(tool)) throw new Error(`Bad cache tool name: ${tool}`);
    if (variant && !VARIANT.test(variant)) throw new Error(`Bad cache variant: ${variant}`);
    const file = variant ? `${tool}-${variant}.json` : `${tool}.json`;
    return join(this.root, key.sha256, `rea-${key.reaVersion}`, key.provider, file);
  }

  async get(key: CacheKey, tool: string, variant = ""): Promise<CacheRead> {
    const path = this.pathFor(key, tool, variant);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === "ENOENT" ? { hit: false } : { hit: false, reason: `unreadable: ${code}` };
    }
    try {
      const entry = JSON.parse(text) as Partial<CacheEntry>;
      if (typeof entry.cachedAt !== "string" || typeof entry.jobId !== "string") {
        throw new Error("missing cachedAt/jobId");
      }
      return {
        hit: true,
        entry: {
          result: parseResult(tool, entry.result),
          cachedAt: entry.cachedAt,
          jobId: entry.jobId,
        },
      };
    } catch (err) {
      // Corrupt or no longer valid: drop it so the next run re-analyses and rewrites it.
      await rm(path, { force: true });
      return {
        hit: false,
        reason: `discarded invalid entry: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async put(
    key: CacheKey,
    tool: string,
    result: unknown,
    jobId: string,
    variant = "",
  ): Promise<void> {
    const path = this.pathFor(key, tool, variant);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    const entry: CacheEntry = { result, cachedAt: new Date().toISOString(), jobId };
    const partial = `${path}.${randomUUID()}.partial`;
    await writeFile(partial, JSON.stringify(entry), { mode: 0o600 });
    await rename(partial, path);
  }
}

/**
 * Identifies a call's arguments for the cache. The target path is left out (it
 * differs between routes, e.g. inside the container); no other arguments means
 * no variant, so plain calls keep their original file names.
 */
export function argsVariant(args: Record<string, unknown>): string {
  const rest = Object.entries(args)
    .filter(([k, v]) => k !== "path" && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  if (rest.length === 0) return "";
  return createHash("sha256")
    .update(canonical(Object.fromEntries(rest)))
    .digest("hex")
    .slice(0, 16);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

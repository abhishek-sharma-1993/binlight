import { randomUUID } from "node:crypto";
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

export const defaultEvidenceRoot = (): string => join(homedir(), ".binlight", "cache", "evidence");

/**
 * Successful REA results on disk, keyed by SHA-256 + REA version + provider,
 * one file per tool:
 *   <root>/<sha256>/rea-<version>/<provider>/<tool>.json
 * Results are re-checked against Binlight's schemas when read, so a corrupt or
 * outdated entry is a miss (with the reason), never a wrong answer.
 */
export class EvidenceCache {
  constructor(readonly root: string = defaultEvidenceRoot()) {}

  pathFor(key: CacheKey, tool: string): string {
    if (!SHA256.test(key.sha256)) throw new Error(`Bad cache key sha256: ${key.sha256}`);
    if (!VERSION.test(key.reaVersion)) throw new Error(`Bad cache key version: ${key.reaVersion}`);
    if (!NAME.test(key.provider)) throw new Error(`Bad cache key provider: ${key.provider}`);
    if (!NAME.test(tool)) throw new Error(`Bad cache tool name: ${tool}`);
    return join(this.root, key.sha256, `rea-${key.reaVersion}`, key.provider, `${tool}.json`);
  }

  async get(key: CacheKey, tool: string): Promise<CacheRead> {
    const path = this.pathFor(key, tool);
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

  async put(key: CacheKey, tool: string, result: unknown, jobId: string): Promise<void> {
    const path = this.pathFor(key, tool);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    const entry: CacheEntry = { result, cachedAt: new Date().toISOString(), jobId };
    const partial = `${path}.${randomUUID()}.partial`;
    await writeFile(partial, JSON.stringify(entry), { mode: 0o600 });
    await rename(partial, path);
  }
}

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { goodResults } from "../jobs/fakes.js";
import { EvidenceCache, type CacheKey } from "./evidence.js";

const key: CacheKey = { sha256: "c".repeat(64), reaVersion: "6.7.0", provider: "ghidra" };

describe("EvidenceCache", () => {
  const root = mkdtempSync(join(tmpdir(), "binlight-evidence-"));
  const cache = new EvidenceCache(root);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("stores results by sha256 / REA version / provider / tool", async () => {
    await cache.put(key, "binary_overview", goodResults["binary_overview"], "job-1");
    expect(cache.pathFor(key, "binary_overview")).toBe(
      join(root, "c".repeat(64), "rea-6.7.0", "ghidra", "binary_overview.json"),
    );
    const read = await cache.get(key, "binary_overview");
    expect(read).toMatchObject({ hit: true, entry: { jobId: "job-1" } });
    expect(read.hit && read.entry.result).toEqual(goodResults["binary_overview"]);
  });

  it("misses on any other REA version or provider", async () => {
    expect((await cache.get({ ...key, reaVersion: "6.8.0" }, "binary_overview")).hit).toBe(false);
    expect((await cache.get({ ...key, provider: "hopper" }, "binary_overview")).hit).toBe(false);
  });

  it("discards an entry that no longer passes the schema, with the reason", async () => {
    await cache.put(key, "list_strings", { not: "evidence" }, "job-2");
    const read = await cache.get(key, "list_strings");
    expect(read.hit).toBe(false);
    expect(!read.hit && read.reason).toMatch(/discarded invalid entry/);
    expect((await cache.get(key, "list_strings")).hit).toBe(false);
  });

  it("discards a corrupt file", async () => {
    await cache.put(key, "list_procedures", goodResults["list_procedures"], "job-3");
    writeFileSync(cache.pathFor(key, "list_procedures"), "{ truncated");
    const read = await cache.get(key, "list_procedures");
    expect(read.hit).toBe(false);
    expect(() => readFileSync(cache.pathFor(key, "list_procedures"))).toThrow();
  });

  it("refuses keys that could escape the cache folder", () => {
    expect(() => cache.pathFor({ ...key, provider: "../../etc" }, "x")).toThrow(/provider/);
    expect(() => cache.pathFor({ ...key, sha256: "abc" }, "x")).toThrow(/sha256/);
    expect(() => cache.pathFor(key, "../list")).toThrow(/tool/);
  });
});

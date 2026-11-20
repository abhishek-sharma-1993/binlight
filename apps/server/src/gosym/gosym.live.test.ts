import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildGoFixture } from "../contracts/run.js";
import { GoFuncTable } from "./gosym.js";

// Live: Binlight's reader against Go's own debug/gosym (test/oracles/gosym) on
// the fixture, kubectl and Ollama. Needs Go. Run with `npm run test:contract`.

const oracleSource = fileURLToPath(new URL("../../test/oracles/gosym", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "binlight-gosym-"));
const oracle = join(dir, "gosym");
execFileSync("go", ["build", "-o", oracle, "."], { cwd: oracleSource, stdio: "pipe" });
const fixture = buildGoFixture();

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(dirname(fixture), { recursive: true, force: true });
});

const run = (args: string[]) =>
  execFileSync(oracle, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    .trimEnd()
    .split("\n");

const targets = [
  ["the Go fixture", fixture],
  ["kubectl", realpathSync("/opt/homebrew/bin/kubectl")],
  ["Ollama", realpathSync("/opt/homebrew/bin/ollama")],
] as const;

describe.each(targets)("Go function table: %s", (_name, path) => {
  const table = GoFuncTable.fromFile(path);

  it("lists the same functions as Go's debug/gosym", () => {
    expect(table).toBeDefined();
    const ours = [...(table?.funcs() ?? [])].map((f) => `${f.entry.toString(16)}\t${f.name}`);
    expect(ours).toEqual(run(["all", path]));
  });

  it("resolves addresses to the same function, file and line", () => {
    const funcs = [...(table?.funcs() ?? [])];
    // Every 97th function, at its entry and part-way in.
    // Linker markers (runtime.text, go:buildid) have no meaningful lines.
    const pcs = funcs
      .filter((f, i) => i % 97 === 0 && f.name !== "runtime.text" && f.name !== "go:buildid")
      .flatMap((f) => [f.entry, f.entry + Math.floor((f.end - f.entry) / 2)]);
    const expected = run(["at", path, ...pcs.map((p) => `0x${p.toString(16)}`)]);
    const ours = pcs.map((pc) => {
      const f = table?.at(pc);
      return f
        ? `${pc.toString(16)}\t${f.entry.toString(16)}\t${f.name}\t${f.file ?? ""}\t${f.line ?? 0}`
        : `${pc.toString(16)}\t\t\t\t`;
    });
    expect(ours).toEqual(expected);
  });
});

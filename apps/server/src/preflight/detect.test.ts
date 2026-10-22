import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectBytes, detectTarget } from "./detect.js";
import { preferredSlice, thinUniversal } from "./thin.js";

const be32 = (...words: number[]) => {
  const b = Buffer.alloc(words.length * 4);
  words.forEach((w, i) => b.writeUInt32BE(w >>> 0, i * 4));
  return b;
};
const le32 = (...words: number[]) => {
  const b = Buffer.alloc(words.length * 4);
  words.forEach((w, i) => b.writeUInt32LE(w >>> 0, i * 4));
  return b;
};

describe("detectBytes", () => {
  it("reads a thin little-endian Mach-O, telling arm64e from arm64", () => {
    expect(detectBytes(le32(0xfeedfacf, 0x0100000c, 0), "x")).toMatchObject({
      format: "mach-o",
      architectures: ["arm64"],
    });
    expect(detectBytes(le32(0xfeedfacf, 0x0100000c, 0x80000002), "x").architectures).toEqual([
      "arm64e",
    ]);
  });

  it("reads every slice of a universal Mach-O", () => {
    const head = be32(
      0xcafebabe, 2,
      0x01000007, 3, 0x4000, 0x1000, 14,
      0x0100000c, 0x80000002, 0x8000, 0x2000, 14,
    ); // prettier-ignore
    expect(detectBytes(head, "x")).toEqual({
      format: "mach-o-universal",
      architectures: ["x86_64", "arm64e"],
      slices: [
        { architecture: "x86_64", offset: 0x4000, size: 0x1000 },
        { architecture: "arm64e", offset: 0x8000, size: 0x2000 },
      ],
    });
  });

  it("does not mistake a Java class file (same magic) for a universal binary", () => {
    expect(detectBytes(be32(0xcafebabe, 0x00000041), "A.class").format).toBe("unknown");
  });

  it("reads ELF and PE machine types", () => {
    const elf = Buffer.alloc(20);
    elf.writeUInt32BE(0x7f454c46, 0);
    elf[5] = 1;
    elf.writeUInt16LE(62, 18);
    expect(detectBytes(elf, "x")).toMatchObject({ format: "elf", architectures: ["x86_64"] });

    const pe = Buffer.alloc(0x90);
    pe.write("MZ", 0, "latin1");
    pe.writeUInt32LE(0x80, 0x3c);
    pe.writeUInt32BE(0x50450000, 0x80);
    pe.writeUInt16LE(0xaa64, 0x84);
    expect(detectBytes(pe, "x")).toMatchObject({ format: "pe", architectures: ["arm64"] });
  });

  it("names zip-based formats by extension, and gives up honestly otherwise", () => {
    expect(detectBytes(be32(0x504b0304), "app.apk").format).toBe("apk");
    expect(detectBytes(be32(0x504b0304), "a.zip").format).toBe("zip");
    expect(detectBytes(Buffer.from("hello"), "notes.txt").format).toBe("unknown");
  });
});

describe("preferredSlice", () => {
  const slices = [
    { architecture: "x86_64", offset: 0, size: 1 },
    { architecture: "arm64e", offset: 1, size: 1 },
  ];
  it("prefers the slice the host runs", () => {
    expect(preferredSlice(slices, "arm64")?.architecture).toBe("arm64e");
    expect(preferredSlice(slices, "x64")?.architecture).toBe("x86_64");
  });
});

describe.runIf(process.platform === "darwin")("on this Mac", () => {
  const cache = mkdtempSync(join(tmpdir(), "binlight-thin-"));
  afterAll(() => rmSync(cache, { recursive: true, force: true }));

  it("detects /bin/ls as universal and thins it exactly like lipo", async () => {
    const ls = await detectTarget("/bin/ls");
    expect(ls.format).toBe("mach-o-universal");
    const slice = ls.slices?.find((s) => s.architecture === "arm64e");
    expect(slice, "expected an arm64e slice in /bin/ls").toBeDefined();
    if (!slice || !ls.sha256) return;

    const ours = await thinUniversal("/bin/ls", ls.sha256, slice, cache);
    const lipo = join(cache, "lipo-arm64e");
    execFileSync("lipo", ["/bin/ls", "-thin", "arm64e", "-output", lipo]);
    expect(readFileSync(ours).equals(readFileSync(lipo))).toBe(true);
    expect((await detectTarget(ours)).architectures).toEqual(["arm64e"]);
  });

  it("finds an .app bundle's main executable", async () => {
    const app = await detectTarget("/System/Applications/Calculator.app");
    expect(app.format).toBe("app-bundle");
    expect(app.executable?.path).toBe(
      "/System/Applications/Calculator.app/Contents/MacOS/Calculator",
    );
  });
});

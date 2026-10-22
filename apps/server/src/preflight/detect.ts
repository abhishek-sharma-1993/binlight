import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DetectedTarget, MachOSlice } from "@binlight/shared";

/** Bytes read from the start of a file; enough for every header parsed here. */
const HEAD_BYTES = 4096;

const MACHO_CPU: Record<number, string> = {
  7: "i386",
  0x01000007: "x86_64",
  12: "arm",
  0x0100000c: "arm64",
  0x0200000c: "arm64_32",
  18: "ppc",
  0x01000012: "ppc64",
};
const CPU_SUBTYPE_ARM64E = 2;
const CPU_SUBTYPE_MASK = 0x00ffffff;

const ELF_MACHINE: Record<number, string> = {
  3: "i386",
  40: "arm",
  62: "x86_64",
  183: "arm64",
  243: "riscv",
};

const PE_MACHINE: Record<number, string> = {
  0x14c: "i386",
  0x8664: "x86_64",
  0xaa64: "arm64",
  0x1c4: "arm",
};

export function machOArchitecture(cputype: number, cpusubtype: number): string {
  const base = MACHO_CPU[cputype] ?? `cpu-0x${cputype.toString(16)}`;
  if (base === "arm64" && (cpusubtype & CPU_SUBTYPE_MASK) === CPU_SUBTYPE_ARM64E) return "arm64e";
  return base;
}

/** Identifies a single file from its leading bytes (plus extension for zip-based formats). */
export function detectBytes(
  head: Buffer,
  name: string,
): Pick<DetectedTarget, "format" | "architectures" | "slices"> {
  const u32be = (o: number) => (head.length >= o + 4 ? head.readUInt32BE(o) : -1);
  const magic = u32be(0);

  // Universal (fat) Mach-O. Java class files share 0xcafebabe; their next word
  // (version) is large, while a fat header's slice count is small.
  if ((magic === 0xcafebabe || magic === 0xcafebabf) && u32be(4) > 0 && u32be(4) < 32) {
    const is64 = magic === 0xcafebabf;
    const count = u32be(4);
    const entry = is64 ? 32 : 20;
    const slices: MachOSlice[] = [];
    for (let i = 0; i < count; i++) {
      const o = 8 + i * entry;
      if (head.length < o + entry) break;
      const cputype = head.readUInt32BE(o);
      const cpusubtype = head.readUInt32BE(o + 4);
      const offset = is64 ? Number(head.readBigUInt64BE(o + 8)) : head.readUInt32BE(o + 8);
      const size = is64 ? Number(head.readBigUInt64BE(o + 16)) : head.readUInt32BE(o + 12);
      slices.push({ architecture: machOArchitecture(cputype, cpusubtype), offset, size });
    }
    return {
      format: "mach-o-universal",
      architectures: slices.map((s) => s.architecture),
      slices,
    };
  }

  // Thin Mach-O, either byte order, 32 or 64 bit.
  if (magic === 0xfeedface || magic === 0xfeedfacf) {
    return { format: "mach-o", architectures: [machOArchitecture(u32be(4), u32be(8))] };
  }
  if (magic === 0xcefaedfe || magic === 0xcffaedfe) {
    return {
      format: "mach-o",
      architectures: [machOArchitecture(head.readUInt32LE(4), head.readUInt32LE(8))],
    };
  }

  if (magic === 0x7f454c46 && head.length >= 20) {
    const littleEndian = head[5] === 1;
    const machine = littleEndian ? head.readUInt16LE(18) : head.readUInt16BE(18);
    return { format: "elf", architectures: [ELF_MACHINE[machine] ?? `elf-machine-${machine}`] };
  }

  if (head.length >= 0x40 && head[0] === 0x4d && head[1] === 0x5a) {
    const peOffset = head.readUInt32LE(0x3c);
    if (head.length >= peOffset + 6 && head.readUInt32BE(peOffset) === 0x50450000) {
      const machine = head.readUInt16LE(peOffset + 4);
      return {
        format: "pe",
        architectures: [PE_MACHINE[machine] ?? `pe-machine-0x${machine.toString(16)}`],
      };
    }
  }

  const ext = extname(name).toLowerCase();
  if (magic === 0x504b0304) {
    return { format: ext === ".apk" ? "apk" : "zip", architectures: [] };
  }
  if (ext === ".asar") return { format: "asar", architectures: [] };
  return { format: "unknown", architectures: [] };
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function readHead(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Reads an .app bundle's main executable name from Contents/Info.plist. */
async function bundleExecutable(appPath: string): Promise<string | undefined> {
  const plistPath = join(appPath, "Contents", "Info.plist");
  try {
    const plist = await readFile(plistPath);
    if (plist.subarray(0, 6).toString("latin1") === "bplist" && process.platform === "darwin") {
      const { stdout } = await promisify(execFile)("plutil", [
        "-extract",
        "CFBundleExecutable",
        "raw",
        plistPath,
      ]);
      return stdout.trim() || undefined;
    }
    const match = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(
      plist.toString("utf8"),
    );
    return match?.[1];
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Detects what a path is. Throws the filesystem error (ENOENT, EACCES) as-is so
 * the caller can report the real reason.
 */
export async function detectTarget(path: string): Promise<DetectedTarget> {
  const info = await stat(path);

  if (info.isDirectory()) {
    if (extname(path) !== ".app") {
      return { path, format: "unknown", architectures: [] };
    }
    const electron = await exists(
      join(path, "Contents", "Frameworks", "Electron Framework.framework"),
    );
    const name = (await bundleExecutable(path)) ?? basename(path, ".app");
    const execPath = join(path, "Contents", "MacOS", name);
    const executable = (await exists(execPath)) ? await detectTarget(execPath) : undefined;
    return {
      path,
      format: "app-bundle",
      architectures: executable?.architectures ?? [],
      electron,
      ...(executable && { executable }),
    };
  }

  const head = await readHead(path);
  const detected = detectBytes(head, path);
  return {
    path,
    ...detected,
    bytes: info.size,
    sha256: await sha256Of(path),
    ...(detected.format === "asar" && { electron: true }),
  };
}

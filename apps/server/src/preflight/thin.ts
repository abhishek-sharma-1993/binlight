import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { MachOSlice } from "@binlight/shared";

/**
 * Slice preference when a universal binary has several. On Apple Silicon,
 * system binaries run their arm64e slice; prefer what the host actually runs.
 */
export function preferredSlice(
  slices: MachOSlice[],
  hostArch: string = process.arch,
): MachOSlice | undefined {
  const order =
    hostArch === "arm64" ? ["arm64e", "arm64", "x86_64"] : ["x86_64", "arm64", "arm64e"];
  for (const arch of order) {
    const slice = slices.find((s) => s.architecture === arch);
    if (slice) return slice;
  }
  return slices[0];
}

/**
 * Extracts one slice of a universal Mach-O (what `lipo -thin` does: the slice
 * is a complete Mach-O stored at `offset`). Ghidra cannot import universal
 * binaries. Results are cached by the source's SHA-256 and architecture.
 */
export async function thinUniversal(
  source: string,
  sha256: string,
  slice: MachOSlice,
  cacheDir: string,
): Promise<string> {
  const dir = join(cacheDir, "thin");
  const out = join(dir, `${sha256}-${slice.architecture}`);
  const cached = await stat(out).catch(() => undefined);
  if (cached?.size === slice.size) return out;

  await mkdir(dir, { recursive: true });
  const partial = `${out}.partial-${process.pid}`;
  await pipeline(
    createReadStream(source, { start: slice.offset, end: slice.offset + slice.size - 1 }),
    createWriteStream(partial, { mode: 0o600 }),
  );
  const written = await stat(partial);
  if (written.size !== slice.size) {
    throw new Error(
      `Thinning ${source} (${slice.architecture}) wrote ${written.size} of ${slice.size} bytes`,
    );
  }
  await rename(partial, out);
  return out;
}

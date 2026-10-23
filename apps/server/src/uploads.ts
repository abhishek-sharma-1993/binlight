import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const defaultUploadRoot = (): string => join(homedir(), ".binlight", "uploads");
/** Large enough for Electron apps and big Go binaries (kubectl is 57 MB). */
export const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 ** 3;

export interface SavedUpload {
  path: string;
  name: string;
  sha256: string;
  bytes: number;
}

export class UploadTooLarge extends Error {}

/** A safe file name from the client's: no folders, no control or shell-awkward characters. */
export function safeUploadName(raw: string | undefined): string {
  let name = raw ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep the raw value
  }
  name = basename(name.replaceAll("\\", "/"))
    .replace(/[^A-Za-z0-9._ +-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 128)
    .trim();
  return name || "upload";
}

/**
 * Streams a request body to `<root>/<sha256>/<name>`, hashing as it goes.
 * Identical content is stored once. Over `maxBytes`, the upload is aborted and
 * nothing is kept.
 */
export async function saveUpload(
  req: IncomingMessage,
  rawName: string | undefined,
  root = defaultUploadRoot(),
  maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
): Promise<SavedUpload> {
  const declared = Number(req.headers["content-length"] ?? NaN);
  if (declared > maxBytes) throw new UploadTooLarge(`Upload is larger than ${maxBytes} bytes.`);

  await mkdir(root, { recursive: true, mode: 0o700 });
  const partial = join(root, `.partial-${randomUUID()}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      if (bytes > maxBytes)
        return done(new UploadTooLarge(`Upload is larger than ${maxBytes} bytes.`));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(req, meter, createWriteStream(partial, { mode: 0o600 }));
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }

  const sha256 = hash.digest("hex");
  const name = safeUploadName(rawName);
  const dir = join(root, sha256);
  const path = join(dir, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (
    await stat(path).then(
      (s) => s.isFile(),
      () => false,
    )
  ) {
    await rm(partial, { force: true });
  } else {
    await rename(partial, path);
  }
  return { path, name, sha256, bytes };
}

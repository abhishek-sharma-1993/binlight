import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { deps, fakeSession } from "./jobs/fakes.js";
import { JobManager } from "./jobs/manager.js";
import { safeUploadName } from "./uploads.js";

describe("safeUploadName", () => {
  it("keeps a plain name and strips folders and odd characters", () => {
    expect(safeUploadName("kubectl")).toBe("kubectl");
    expect(safeUploadName("../../etc/passwd")).toBe("passwd");
    expect(safeUploadName("C:\\\\tools\\\\app.exe")).toBe("app.exe");
    expect(safeUploadName(encodeURIComponent("my app$(rm).bin"))).toBe("my app__rm_.bin");
    expect(safeUploadName(".hidden")).toBe("hidden");
    expect(safeUploadName("")).toBe("upload");
  });
});

describe("POST /api/uploads", () => {
  const root = mkdtempSync(join(tmpdir(), "binlight-uploads-"));
  const app = createApp({
    jobs: new JobManager(deps(fakeSession(undefined))),
    uploadRoot: root,
    maxUploadBytes: 1024,
  });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => {
    app.closeAllConnections();
    app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const upload = (body: Buffer, headers: Record<string, string>) =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, method: "POST", path: "/api/uploads", headers },
        (res) => {
          let text = "";
          res.on("data", (c: Buffer) => (text += c.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });

  it("stores the file under its SHA-256 with a safe name", async () => {
    const bytes = Buffer.from("\xcf\xfa\xed\xfe fake mach-o", "latin1");
    const reply = await upload(bytes, {
      "content-type": "application/octet-stream",
      "x-binlight-filename": encodeURIComponent("../tool"),
    });
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(reply.status).toBe(201);
    expect(reply.body).toEqual({
      path: join(root, sha, "tool"),
      name: "tool",
      sha256: sha,
      bytes: bytes.length,
    });
    expect(readFileSync(join(root, sha, "tool")).equals(bytes)).toBe(true);
  });

  it("refuses other content types (cross-site safety)", async () => {
    const reply = await upload(Buffer.from("x"), { "content-type": "text/plain" });
    expect(reply.status).toBe(415);
  });

  it("refuses an upload over the size cap and keeps nothing", async () => {
    const before = readdirSync(root).length;
    const reply = await upload(Buffer.alloc(2048), { "content-type": "application/octet-stream" });
    expect(reply.status).toBe(413);
    expect(readdirSync(root).length).toBe(before);
  });
});

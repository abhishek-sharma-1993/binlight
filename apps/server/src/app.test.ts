import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("server", () => {
  const app = createApp();
  let base = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));

  it("answers the health check", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 404 for unknown routes", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

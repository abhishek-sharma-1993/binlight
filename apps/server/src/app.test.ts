import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job, JobEvent } from "@binlight/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { AiService, MemoryKeyStore, SettingsFile } from "./settings/index.js";
import { deps, fakeSession, untilAborted } from "./jobs/fakes.js";
import { JobManager } from "./jobs/manager.js";

interface Reply {
  status: number;
  body: unknown;
}

describe("server", () => {
  const fast = new JobManager(deps(fakeSession({ route: "docker-ghidra", providerId: "ghidra" })));
  const app = createApp({ jobs: fast });
  let port = 0;

  beforeAll(async () => {
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => {
    app.closeAllConnections();
    return new Promise<void>((resolve) => app.close(() => resolve()));
  });

  function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method,
          path,
          headers: {
            ...(body !== undefined && { "content-type": "application/json" }),
            ...headers,
          },
        },
        (res) => {
          let text = "";
          res.on("data", (c: Buffer) => (text += c.toString()));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }),
          );
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  /** Reads SSE events until `until` says stop. */
  function events(path: string, until: (e: JobEvent) => boolean): Promise<JobEvent[]> {
    return new Promise((resolve, reject) => {
      const seen: JobEvent[] = [];
      const req = request({ host: "127.0.0.1", port, path }, (res) => {
        expect(res.headers["content-type"]).toBe("text/event-stream");
        let buffer = "";
        res.on("data", (c: Buffer) => {
          buffer += c.toString();
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block.split("\n").find((l) => l.startsWith("data: "));
            if (!data) continue;
            const event = JSON.parse(data.slice(6)) as JobEvent;
            seen.push(event);
            if (until(event)) {
              req.destroy();
              resolve(seen);
            }
          }
        });
      });
      req.on("error", (e) => (seen.length ? undefined : reject(e)));
      req.end();
    });
  }

  it("answers the health check", async () => {
    expect(await call("GET", "/api/health")).toEqual({ status: 200, body: { ok: true } });
  });

  it("lists the recipes the page can offer", async () => {
    const reply = await call("GET", "/api/recipes");
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual([
      expect.objectContaining({
        id: "raw-analysis",
        targets: 1,
        needsDeep: true,
        steps: expect.arrayContaining([
          expect.objectContaining({ id: "go", tool: "inspect_go_binary", deep: false }),
        ]),
      }),
    ]);
  });

  it("starts a job from a recipe and targets, and explains bad requests", async () => {
    const created = await call("POST", "/api/jobs", {
      recipe: "raw-analysis",
      targets: ["/apps/tool"],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      recipe: { id: "raw-analysis" },
      targets: ["/apps/tool"],
    });

    const unknown = await call("POST", "/api/jobs", { recipe: "nope", targets: ["/a"] });
    expect(unknown).toEqual({ status: 400, body: { error: 'No recipe "nope".' } });
    const tooMany = await call("POST", "/api/jobs", { targets: ["/a", "/b"] });
    expect(tooMany.status).toBe(400);
    expect((tooMany.body as { error: string }).error).toMatch(/needs 1 target/);
    expect((await call("POST", "/api/jobs", { targets: [1] })).status).toBe(400);
  });

  it("refuses non-local Host names (DNS rebinding)", async () => {
    const reply = await call("GET", "/api/health", undefined, { host: "evil.example:8787" });
    expect(reply.status).toBe(403);
  });

  it("only accepts JSON to start a job", async () => {
    const reply = await new Promise<number>((resolve) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/jobs",
          headers: { "content-type": "text/plain" },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.end('{"path":"/bin/ls"}');
    });
    expect(reply).toBe(415);
    expect((await call("POST", "/api/jobs", { nope: 1 })).status).toBe(400);
  });

  it("creates a job, streams it to the end, and serves step results", async () => {
    const created = await call("POST", "/api/jobs", { path: "/apps/tool" });
    expect(created.status).toBe(201);
    const job = created.body as Job;
    expect(job.status).toBe("queued");

    const seen = await events(
      `/api/jobs/${job.id}/events`,
      // A fast job may already be done by the time the stream opens.
      (e) =>
        (e.type === "job" && e.status === "done") ||
        (e.type === "snapshot" && e.job.status === "done"),
    );
    expect(seen[0]?.type).toBe("snapshot");
    const finished = (await call("GET", `/api/jobs/${job.id}`)).body as Job;
    expect(finished.status).toBe("done");
    expect(((await call("GET", "/api/jobs")).body as Job[]).map((j) => j.id)).toContain(job.id);
    const result = await call("GET", `/api/jobs/${job.id}/steps/overview/result`);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ normalized_result: { string_count: 97076 } });
    expect((await call("GET", `/api/jobs/${job.id}/steps/nope/result`)).status).toBe(404);

    // A page reload: a new connection gets the finished job as its snapshot.
    const again = await events(`/api/jobs/${job.id}/events`, () => true);
    expect(again[0]).toMatchObject({ type: "snapshot", job: { id: job.id, status: "done" } });

    expect((await call("POST", `/api/jobs/${job.id}/cancel`)).status).toBe(409);

    // A finished job downloads as one HTML file.
    const exported = await fetch(`http://127.0.0.1:${port}/api/jobs/${job.id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(exported.headers.get("content-disposition")).toMatch(
      /^attachment; filename="binlight-tool-raw-analysis-\d{4}-\d{2}-\d{2}\.html"$/,
    );
    expect(await exported.text()).toMatch(/^<!doctype html>/);
    expect((await call("GET", "/api/jobs/does-not-exist")).status).toBe(404);
  });
});

describe("server cancel", () => {
  const jobs = new JobManager(
    deps(
      fakeSession(
        { route: "docker-ghidra", providerId: "ghidra" },
        { binary_overview: untilAborted },
      ),
    ),
  );
  const app = createApp({ jobs });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => {
    app.closeAllConnections();
    return new Promise<void>((resolve) => app.close(() => resolve()));
  });

  it("cancels a running job over HTTP", async () => {
    const base = `http://127.0.0.1:${port}`;
    const job = (await (
      await fetch(`${base}/api/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/apps/tool" }),
      })
    ).json()) as Job;
    // The snapshot may already show the overview running.
    await new Promise<void>((resolve) =>
      jobs.subscribe(job.id, (e) => {
        const steps = e.type === "snapshot" ? e.job.steps : e.type === "step" ? [e.step] : [];
        if (steps.some((st) => st.id === "overview" && st.status === "running")) resolve();
      }),
    );
    const cancel = await fetch(`${base}/api/jobs/${job.id}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(202);
    expect((await jobs.settled(job.id))?.status).toBe("cancelled");
  });
});

describe("AI settings API", () => {
  const KEY = `sk-ant-api03-${"q".repeat(40)}abcd`;
  const dir = mkdtempSync(join(tmpdir(), "binlight-api-ai-"));
  const ai = new AiService(
    new SettingsFile(join(dir, "settings.json")),
    new MemoryKeyStore(),
    {},
    () => ({ models: { retrieve: async () => ({}) } }) as never,
  );
  const app = createApp({ jobs: new JobManager(deps(fakeSession(undefined))), ai });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    app.closeAllConnections();
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (method: string, path: string, body?: unknown) =>
    fetch(base + path, {
      method,
      ...(body !== undefined && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });

  it("saves a key, reports only its hint, switches AI on, and removes it", async () => {
    expect((await (await call("GET", "/api/settings/ai")).json()) as object).toMatchObject({
      mode: "local-only",
    });
    const on = await call("PUT", "/api/settings/ai", { mode: "claude" });
    expect(on.status).toBe(400);
    const saved = await call("PUT", "/api/settings/ai/key", { key: KEY });
    const text = await saved.text();
    expect(saved.status).toBe(200);
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toMatchObject({ key: { source: "keychain", hint: "sk-ant-…abcd" } });
    expect(
      (
        (await (await call("PUT", "/api/settings/ai", { mode: "claude" })).json()) as {
          mode: string;
        }
      ).mode,
    ).toBe("claude");
    expect(
      ((await (await call("DELETE", "/api/settings/ai/key")).json()) as { mode: string }).mode,
    ).toBe("local-only");
  });

  it("explains bad requests", async () => {
    expect((await call("PUT", "/api/settings/ai", { mode: "always" })).status).toBe(400);
    expect((await call("PUT", "/api/settings/ai/key", { key: 'x" y' })).status).toBe(400);
    expect((await call("POST", "/api/ask", { question: "Does it phone home?" })).status).toBe(400);
  });
});

import { request } from "node:http";
import type { AddressInfo } from "node:net";
import type { Job, JobEvent } from "@binlight/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
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

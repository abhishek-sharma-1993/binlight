import type { Job, JobEvent, StepId } from "@binlight/shared";

/** An API failure with the server's own message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(
      res.status,
      `Server sent non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  if (!res.ok) {
    const error = (body as { error?: string } | undefined)?.error;
    throw new ApiError(res.status, error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export async function createJob(path: string, fresh: boolean): Promise<Job> {
  return json(
    await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, fresh }),
    }),
  );
}

export async function listJobs(): Promise<Job[]> {
  return json(await fetch("/api/jobs"));
}

export async function cancelJob(id: string): Promise<void> {
  await json(await fetch(`/api/jobs/${id}/cancel`, { method: "POST" }));
}

export async function uploadFile(
  file: File,
): Promise<{ path: string; sha256: string; bytes: number }> {
  return json(
    await fetch("/api/uploads", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-binlight-filename": encodeURIComponent(file.name),
      },
      body: file,
    }),
  );
}

export async function stepResult(id: string, step: StepId): Promise<unknown> {
  return json(await fetch(`/api/jobs/${id}/steps/${step}/result`));
}

/** Subscribes to a job's live events. Returns a function that closes the stream. */
export function watchJob(
  id: string,
  onEvent: (event: JobEvent) => void,
  onConnection: (connected: boolean) => void,
): () => void {
  const source = new EventSource(`/api/jobs/${id}/events`);
  const types: JobEvent["type"][] = ["snapshot", "job", "step", "heartbeat", "log"];
  for (const type of types) {
    source.addEventListener(type, (e) =>
      onEvent(JSON.parse((e as MessageEvent<string>).data) as JobEvent),
    );
  }
  source.onopen = () => onConnection(true);
  // EventSource reconnects by itself; every reconnect starts with a fresh snapshot.
  source.onerror = () => onConnection(false);
  return () => source.close();
}

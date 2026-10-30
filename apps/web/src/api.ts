import type {
  AiSettings,
  Job,
  JobEvent,
  RecipeInfo,
  RecipeSuggestion,
  StepId,
} from "@binlight/shared";

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

export async function listRecipes(): Promise<RecipeInfo[]> {
  return json(await fetch("/api/recipes"));
}

export async function createJob(recipe: string, targets: string[], fresh: boolean): Promise<Job> {
  return json(
    await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipe, targets, fresh }),
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
  return json(await fetch(`/api/jobs/${id}/steps/${encodeURIComponent(step)}/result`));
}

/**
 * Every server event type. A new type missing here would never reach a live
 * page (findings and verdicts once didn't); the check below fails to compile then.
 */
export const JOB_EVENT_TYPES = [
  "snapshot",
  "job",
  "step",
  "findings",
  "verdict",
  "heartbeat",
  "log",
] as const satisfies readonly JobEvent["type"][];
type Unsubscribed = Exclude<JobEvent["type"], (typeof JOB_EVENT_TYPES)[number]>;
const everyEventSubscribed: [Unsubscribed] extends [never] ? true : Unsubscribed = true;
void everyEventSubscribed;

/** Subscribes to a job's live events. Returns a function that closes the stream. */
export function watchJob(
  id: string,
  onEvent: (event: JobEvent) => void,
  onConnection: (connected: boolean) => void,
): () => void {
  const source = new EventSource(`/api/jobs/${id}/events`);
  for (const type of JOB_EVENT_TYPES) {
    source.addEventListener(type, (e) =>
      onEvent(JSON.parse((e as MessageEvent<string>).data) as JobEvent),
    );
  }
  source.onopen = () => onConnection(true);
  // EventSource reconnects by itself; every reconnect starts with a fresh snapshot.
  source.onerror = () => onConnection(false);
  return () => source.close();
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body !== undefined && {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }),
});

export async function getAiSettings(): Promise<AiSettings> {
  return json(await fetch("/api/settings/ai"));
}

export async function updateAiSettings(
  change: Partial<Pick<AiSettings, "mode" | "askBeforeSending" | "model">>,
): Promise<AiSettings> {
  return json(await fetch("/api/settings/ai", jsonInit("PUT", change)));
}

/** Sends the key once; the server checks it with Claude and keeps it in the Keychain. */
export async function saveAiKey(key: string): Promise<AiSettings> {
  return json(await fetch("/api/settings/ai/key", jsonInit("PUT", { key })));
}

export async function removeAiKey(): Promise<AiSettings> {
  return json(await fetch("/api/settings/ai/key", jsonInit("DELETE")));
}

export async function answerConsent(id: string, send: boolean): Promise<void> {
  await json(await fetch(`/api/jobs/${id}/ai-consent`, jsonInit("POST", { send })));
}

export async function askForRecipe(question: string): Promise<RecipeSuggestion> {
  return json(await fetch("/api/ask", jsonInit("POST", { question })));
}

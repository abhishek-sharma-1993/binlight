import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { JobEvent } from "@binlight/shared";
import { JobRequestError, type JobManager } from "./jobs/manager.js";
import { recipeInfo, RECIPES, type Recipe } from "./recipes/index.js";
import { saveUpload, UploadTooLarge } from "./uploads.js";

export interface AppDeps {
  jobs: JobManager;
  /** Recipes listed by /api/recipes. Default: the server's recipe list. */
  recipes?: Recipe[];
  /** Where uploaded binaries are stored. */
  uploadRoot?: string;
  maxUploadBytes?: number;
}

const MAX_BODY_BYTES = 64 * 1024;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  // Requiring JSON means a cross-site page cannot post here without a CORS
  // preflight, which this server never grants.
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    throw new HttpError(415, "Send the request body as application/json.");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

/** Blocks DNS rebinding: this server analyses local files, so only local Host names may call it. */
function isLocalHost(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOCAL_HOSTS.has(name ?? "");
}

function streamEvents(req: IncomingMessage, res: ServerResponse, jobs: JobManager, id: string) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const write = (event: JobEvent) =>
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const unsubscribe = jobs.subscribe(id, write);
  // Comment lines keep idle connections (finished jobs) from timing out.
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe?.();
  });
}

export function createApp(deps: AppDeps): Server {
  const { jobs } = deps;

  return createServer((req, res) => {
    void (async () => {
      if (!isLocalHost(req)) throw new HttpError(403, "Binlight only answers on localhost.");
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true });

      if (method === "GET" && url.pathname === "/api/recipes") {
        return send(res, 200, (deps.recipes ?? RECIPES).map(recipeInfo));
      }

      if (method === "POST" && url.pathname === "/api/uploads") {
        // octet-stream is not a CORS-safelisted type: a cross-site page can't send it.
        if (req.headers["content-type"] !== "application/octet-stream") {
          throw new HttpError(415, "Upload the file as application/octet-stream.");
        }
        const name = req.headers["x-binlight-filename"];
        try {
          const saved = await saveUpload(
            req,
            typeof name === "string" ? name : undefined,
            deps.uploadRoot,
            deps.maxUploadBytes,
          );
          return send(res, 201, saved);
        } catch (err) {
          if (err instanceof UploadTooLarge) throw new HttpError(413, err.message);
          throw err;
        }
      }

      if (parts[0] === "api" && parts[1] === "jobs") {
        const id = parts[2];
        if (!id) {
          if (method === "GET") return send(res, 200, jobs.list());
          if (method === "POST") {
            const body = (await readJson(req)) as {
              recipe?: unknown;
              targets?: unknown;
              path?: unknown;
              fresh?: unknown;
            };
            // {path} is the phase 0 form: one target, the default recipe.
            const targets = body.targets ?? (body.path === undefined ? undefined : [body.path]);
            if (!Array.isArray(targets) || !targets.every((t) => typeof t === "string")) {
              throw new HttpError(
                400,
                'Give the targets as {"recipe": "<id>", "targets": ["/absolute/path"]}.',
              );
            }
            if (body.recipe !== undefined && typeof body.recipe !== "string") {
              throw new HttpError(400, "recipe must be a recipe id string.");
            }
            try {
              return send(
                res,
                201,
                jobs.create({
                  ...(body.recipe !== undefined && { recipe: body.recipe }),
                  targets,
                  fresh: body.fresh === true,
                }),
              );
            } catch (err) {
              if (err instanceof JobRequestError) throw new HttpError(400, err.message);
              throw err;
            }
          }
        } else {
          const job = jobs.get(id);
          if (!job) throw new HttpError(404, `No job ${id}.`);
          const action = parts[3];
          if (!action && method === "GET") return send(res, 200, job);
          if (action === "events" && method === "GET") return streamEvents(req, res, jobs, id);
          if (action === "cancel" && method === "POST") {
            const cancelled = await jobs.cancel(id);
            return cancelled
              ? send(res, 202, { cancelled: true })
              : send(res, 409, { error: `Job is already ${job.status}.` });
          }
          if (action === "steps" && parts[5] === "result" && method === "GET") {
            const step = decodeURIComponent(parts[4] ?? "");
            if (!job.steps.some((s) => s.id === step)) throw new HttpError(404, `No step ${step}.`);
            const result = await jobs.result(id, step);
            if (result === undefined) throw new HttpError(404, `Step ${step} has no result.`);
            return send(res, 200, result);
          }
        }
      }
      throw new HttpError(404, "Not found.");
    })().catch((err: unknown) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
}

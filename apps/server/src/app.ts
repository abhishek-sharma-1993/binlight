import { createServer, type Server } from "node:http";

/** Phase 0 HTTP surface. Routes grow with the job runner (task 6). */
export function createApp(): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

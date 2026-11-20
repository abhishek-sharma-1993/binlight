import type { Health } from "@binlight/shared";
import { useEffect, useState } from "react";
import { getHealth } from "./api.js";

type Status = { kind: "checking" } | { kind: "down" } | { kind: "up"; health: Health };

/**
 * Says plainly when the server isn't running, and while REA does its one-time
 * build after install. Polls until both are settled, then stays quiet.
 */
export function ServerStatus() {
  const [status, setStatus] = useState<Status>({ kind: "checking" });

  useEffect(() => {
    let stopped = false;
    let wasDown = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let next: Status;
      try {
        next = { kind: "up", health: await getHealth() };
      } catch {
        next = { kind: "down" };
      }
      if (stopped) return;
      // The other panels loaded (and failed) while the server was down: start over.
      if (wasDown && next.kind === "up") return window.location.reload();
      wasDown = next.kind === "down";
      setStatus(next);
      const settled = next.kind === "up" && next.health.rea?.state !== "warming";
      if (!settled) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  if (status.kind === "down") {
    return (
      <div className="error notice" role="alert">
        <p>
          Binlight's server isn't answering. Start it in a second terminal with{" "}
          <code>npm run dev:server</code>; this page reconnects by itself.
        </p>
      </div>
    );
  }
  const rea = status.kind === "up" ? status.health.rea : undefined;
  if (rea?.state === "warming") {
    return (
      <p className="notice warming" role="status">
        Getting REA ready. The first start after install builds its helpers once (about 30 s); a job
        started now waits for it.
      </p>
    );
  }
  if (rea?.state === "failed") {
    return (
      <div className="error notice" role="alert">
        <p>REA could not start: {rea.error}</p>
      </div>
    );
  }
  return null;
}

import { useEffect, useState } from "react";
import { describeHealth, type Health } from "./health.js";

export function App() {
  const [health, setHealth] = useState<Health>({ state: "checking" });

  useEffect(() => {
    fetch("/api/health")
      .then((res) =>
        res.ok
          ? setHealth({ state: "up" })
          : setHealth({ state: "down", reason: `HTTP ${res.status}` }),
      )
      .catch((err: unknown) => setHealth({ state: "down", reason: String(err) }));
  }, []);

  return (
    <main>
      <h1>Binlight</h1>
      <p>{describeHealth(health)}</p>
    </main>
  );
}

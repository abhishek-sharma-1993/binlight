import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["@binlight/source"] },
  ssr: { resolve: { conditions: ["@binlight/source"] } },
  test: { name: "server", environment: "node" },
});

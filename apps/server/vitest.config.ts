import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["@binlight/source"] },
  ssr: { resolve: { conditions: ["@binlight/source"] } },
  test: {
    name: "server",
    environment: "node",
    // Live contract tests drive real analysis; run them with `npm run test:contract`.
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
  },
});

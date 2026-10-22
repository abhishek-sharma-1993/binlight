import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["@binlight/source"] },
  ssr: { resolve: { conditions: ["@binlight/source"] } },
  test: {
    name: "contract",
    environment: "node",
    include: ["src/**/*.live.test.ts"],
    testTimeout: 60_000,
  },
});

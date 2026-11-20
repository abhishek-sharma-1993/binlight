import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["@binlight/source"] },
  ssr: { resolve: { conditions: ["@binlight/source"] } },
  test: {
    name: "contract",
    environment: "node",
    include: ["src/**/*.live.test.ts"],
    testTimeout: 60_000,
    // Each file starts REA (some with Ghidra in Docker): run them one at a time
    // so they don't compete for memory, Docker or Hopper (one flaky run, 20 Nov).
    fileParallelism: false,
  },
});

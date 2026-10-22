# Phase 0: Foundations

**Gate:** Binlight analyses `kubectl` and `ollama` end to end (overview, strings,
procedures, Go libraries) through one MCP session each, with progress shown and
results cached, on the owner's Apple Silicon Mac.

No UI polish in this phase. A minimal page that shows job progress and raw
results is enough to prove the gate.

## Tasks

- [x] **1. Repo scaffold.** npm workspaces, TypeScript strict:
      `apps/server` (Node), `apps/web` (React + Vite), `packages/shared` (types).
      Lint, format and a test runner. A README with how to run it.
- [x] **2. REA MCP client.** Spawn `rea --mcp` over stdio with an explicit env
      (`GHIDRA_INSTALL_DIR`, `REA_GHIDRA_STARTUP_TIMEOUT_MS`). Initialise, list
      tools, call tools, handle REA's structured errors. Pin the REA version.
- [x] **3. Contract tests.** For each tool Binlight calls, record the real
      response shape from REA and assert it in tests, so a REA upgrade that
      changes a shape fails loudly.
- [x] **4. Preflight ("zero-setup").** Before analysis: - detect file type and architectures; thin universal Mach-O (handle
      `arm64e`); - run `rea doctor --format json` and choose a working provider; - on Apple Silicon with no native decompiler, route deep analysis to the
      `linux/amd64` Docker runner; - detect Hopper demo mode and avoid it; - report anything that can't be analysed before starting.
- [ ] **5. Docker runner.** An image with REA + Ghidra 12.1.4 (checksum-verified) + JDK 21 for `linux/amd64`. The server talks MCP to `rea --mcp` inside it.
      Run it with `--network none`, non-root, the target mounted read-only.
- [ ] **6. Job runner.** One job per investigation: open the binary once, run
      steps, stream progress events (step, status, elapsed) to the browser. Jobs
      survive a page reload; cancel works.
- [ ] **7. Evidence cache.** Key results by the binary's SHA-256 + REA version +
      provider. A repeat run of the same binary returns instantly.
- [ ] **8. Minimal web page.** Upload or choose a path, start a job, watch live
      progress, see raw results and real error messages (never silent zeros).
- [ ] **9. Gate run.** kubectl and Ollama end to end. Record timings and compare
      counts with `docs/lessons-learned.md` → reference results.

## Out of scope for phase 0

Recipes, verdicts, Claude API calls, the code map, HTML export. Those are phase 1+.

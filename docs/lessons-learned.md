# Lessons learned (verified in real runs, Oct 2026)

Each item was observed directly while building the BinDossier prototype. Treat
them as requirements for Binlight's runtime.

## REA

- Package: `rea-agents` on npm (MIT). Versions used: 6.5.0 and 6.7.0. Binary: `rea`.
- `rea --mcp` starts the MCP stdio server. `rea mcp add|doctor` registers or checks it.
- REA's own MCP client package is `@modelcontextprotocol/client` (in its
  package.json). Check the current MCP TypeScript SDK packaging before picking one.
- `rea doctor --provider <id> --format json` reports per-provider health. The
  top-level `healthy: false` is normal when optional providers (IDA, JADX, Kuna)
  are missing; read the specific provider's checks instead.
- Errors arrive as structured JSON with `code`, `message` and `remediation`.
  Show those to the user; they are good.
- **Each one-shot CLI call re-runs the provider's full analysis.** `--snapshot`
  did not avoid it: 18s with a snapshot vs 20s without on a small binary. The
  snapshot holds REA's 17 KB summary, not Ghidra's database. An MCP session
  (`open_binary` once, many tool calls) is the way to reuse analysis.

## Ghidra (provider)

- REA 6.x expects Ghidra **12.1.x**; 12.1.4 used. Release zip:
  `ghidra_12.1.4_PUBLIC_20260921.zip`, SHA-256
  `ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db`. Needs JDK 21.
- `GHIDRA_INSTALL_DIR` must point at the extracted root, the folder that contains
  `Ghidra/application.properties`.
- **The release ships its native decompiler only for `linux_x86_64` and
  `win_x86_64`.** On Apple Silicon, REA reports `native_decompiler:
executable_missing`. Building it from the release's Makefile fails: its
  dependency scan needs `bfd.h` even for the `ghidra_opt` target, and it ignores
  `CPPFLAGS`. The supported build is Gradle from the full source repo.
- **The working path on Apple Silicon** is a Docker image with
  `--platform linux/amd64` (prebuilt x86_64 decompiler under emulation). It's slow
  but reliable.
- Ghidra cannot import universal (fat) Mach-O binaries. Thin first with
  `lipo <bin> -thin <arch> -output <out>`. The arch name matters: macOS system
  binaries can be `arm64e`, not `arm64` (`lipo -archs` tells you).
- Large binaries need a long startup budget: set `REA_GHIDRA_STARTUP_TIMEOUT_MS`
  (initial analysis counts toward it).
- Timings: Ollama (25 MB Go binary) took 21 min with native Ghidra on Linux x86_64.
  kubectl (57 MB) and Ollama took hours under Docker emulation on an M2.
- Environment variables set in a user's terminal are **not** seen by an MCP
  server launched by a desktop app. Binlight must pass `GHIDRA_INSTALL_DIR` and
  the timeouts explicitly when it spawns `rea --mcp`.

## Hopper (provider)

- In demo mode, Hopper shows a license/demo dialog on launch that blocks REA's
  bridge. REA times out after 120s waiting for "bridge readiness" and leaves a
  `/tmp/rea-*` runtime dir and an open document. Detect demo mode and steer users
  to Ghidra.

## Provider selection on Apple Silicon (REA 6.7.0, Oct 22 2026)

- With no native decompiler, REA **rejects the Ghidra provider outright** for
  `open_binary` (`provider_unavailable`, rejection `executable_missing`), not just
  decompilation. `details.rejections[]` lists each candidate and why.
- `open_binary` with no `provider_id` picked **Hopper** on the owner's Mac, and it
  worked unattended on a 2.7 MB Go binary (open 1 s, `binary_overview` 12 s).
  But that Hopper is the **demo build** (`CFBundleShortVersionString` =
  `6.6.0-demo`), so preflight avoids it as the plan requires. REA's doctor does
  not report licence state; read the app's `Info.plist`.
- `rea doctor --format json` exits 1 whenever anything is unhealthy (IDA, client
  registrations), so ignore the exit code. Read `providerInspections[]` for
  Ghidra (`available` + failing `checks`). Hopper is **not** in
  `providerInspections`; use the `hopper` entry in `scope_checks` and `hopperPath`.
- Extracting a universal slice by its fat-header offset and size gives a file
  byte-identical to `lipo -thin` (checked on `/bin/ls` arm64e), so thinning
  needs no `lipo` and works on Linux.
- REA **leaves Hopper running** after `close_binary` and after `rea --mcp` exits.
  The runner must account for this (task 4/6).
- Hopper's `list_strings` sees only typed string objects: **15 strings** for the Go
  fixture, missing its URL literal, which is in the file. Do not base the
  phone-home recipe on Hopper's `list_strings` for Go binaries.
- `list_strings` and `list_procedures` take no paging arguments; kubectl-sized
  binaries return everything in one response.
- `inspect_go_binary` needs no deep provider (13 ms) and reports Go version,
  main module and dependencies (Ollama: go1.27.2, 51 dependencies, matches below).
- Homebrew's kubectl here is 1.37.1, not the `/usr/local/bin` copy in the
  reference table; expect different counts at the gate run.

## Reading findings from strings

- **Go packs string literals end to end with no separators.** URLs are glued to
  preceding text (`...NUMBER_IDhttps://docs.openclaw.ai`). A regex with `\b`
  before `http` misses them all. Split on each `https?://` and report the
  **hostname** only; paths swallow the next literal (`/Claude.appcowork`).
- Hard-coded URLs undercount real network destinations: Ollama mentions
  `ollama.com` 10 times without a scheme, and builds its registry address at
  runtime. Never word a verdict as "talks to only N servers".
- Matches inside huge Go string blobs must be shown as short snippets
  (±36 chars), not the whole blob.
- Separate **credential values** (strict patterns: AWS `AKIA…`, `sk-…`,
  `ghp_…`, `xox…-`, `AIza…`, private-key blocks, JWTs) from **credential-related
  names** (`APIKey`, `POOLSIDE_API_KEY=ollama`, TLS secret labels). Names alone
  are not findings. Never print a full credential; truncate.
- Known false alarms: kubectl's help text includes the sample
  `--password=uXFGweU9l35qcif`; `sk-ecdsa-sha2-nistp256@openssh.com` is an SSH
  algorithm name, not an email address.
- An inventory alone is boring. Users found the BinDossier reports "nothing
  that makes me curious". Lead every report with a verdict: what matters and why.

## Reference results (for regression checks)

| Target                                             | Format / arch | Segments | Procedures | Strings | Go       | Libraries |
| -------------------------------------------------- | ------------- | -------- | ---------- | ------- | -------- | --------- |
| Ollama v0.40.6+dirty (Homebrew)                    | Mach-O arm64  | 32       | 27,735     | 51,781  | go1.27.2 | 51        |
| kubectl (/usr/local/bin copy, version unconfirmed) | Mach-O arm64  | 19       | 37,246     | 97,076  | go1.22.5 | 84        |
| GitHub `gh` CLI v2.89.0                            | ELF amd64     | —        | —          | —       | —        | 168       |

# Binlight

A visual, question-led workspace on top of [REA](https://github.com/morluto/rea).
Drop in an app, ask a plain question, watch the investigation, get a verdict
backed by REA evidence. Independent project; not affiliated with REA, Ghidra or
Anthropic.

Status: phase 0 (foundations). See `docs/phase-0-plan.md`.

## Layout

| Path              | What                                            |
| ----------------- | ----------------------------------------------- |
| `apps/server`     | Node server. Talks to REA over MCP (stdio).     |
| `apps/web`        | React + Vite web app. Talks only to the server. |
| `packages/shared` | Types shared by server and web.                 |
| `docs/`           | Brief, current phase plan, lessons learned.     |
| `reference/`      | Earlier Python prototype (logic to reuse).      |

## Prerequisites

- Node.js 22+ (developed on 26)
- REA is installed by `npm install`: `rea-agents` is pinned exactly in
  `apps/server/package.json`, and Binlight refuses to run any other version.
- Ghidra 12.1.x + JDK 21 for deep analysis (see `docs/lessons-learned.md`)

## Run

```bash
npm install
npm run dev:server   # http://127.0.0.1:8787
npm run dev:web      # http://127.0.0.1:5173 (proxies /api to the server)
```

Open http://127.0.0.1:5173, upload a binary or type a path (paths are the only
way to analyse an `.app` bundle), and watch the job: each step's status and
time, its summary and evidence ID, or the real error and fix; skipped steps
say why; cached steps are labelled. The job is in the URL, so a reload
reconnects. Raw REA results open per step. Uploads are stored under
`~/.binlight/uploads/<sha256>/` (2 GiB limit).

## REA

The server spawns the pinned `rea --mcp` itself with an explicit environment.
Set these in the server's environment:

| Variable                        | Purpose                                                              |
| ------------------------------- | -------------------------------------------------------------------- |
| `GHIDRA_INSTALL_DIR`            | Ghidra 12.1.x root (the folder with `Ghidra/application.properties`) |
| `JAVA_HOME`                     | JDK 21                                                               |
| `REA_GHIDRA_STARTUP_TIMEOUT_MS` | Initial-analysis budget; default 45 min                              |

List REA's tools through Binlight's MCP client:

```bash
npm run rea:tools              # summary
npm run rea:tools -- --json    # full list
```

## Preflight

Before any analysis the server checks the target and this machine: file type and
architectures, `.app` bundle executables, universal Mach-O thinning (cached in
`~/.binlight/cache/thin`), and which deep-analysis route works (native Ghidra,
licensed Hopper, or the Docker Ghidra runner). Every problem comes back with
its real reason.

```bash
npm run preflight -- /path/to/binary [--json]
```

## Jobs API

One job per investigation, running a **recipe**: a fixed list of REA steps
(`apps/server/src/recipes/`). Per target: preflight, start REA (local REA when
no step needs a disassembler), open the binary once, then the recipe's steps
reuse that analysis. Recipes may take two targets (comparisons); each target
gets its own REA session. Phase 0's analysis is the `raw-analysis` recipe. One deep job
runs at a time; others queue. Jobs live in the server's memory, so a page
reload reconnects to them (a server restart keeps cached results, not the job
list).

### Evidence cache

Every successful analysis step's REA result is saved under
`~/.binlight/cache/evidence/<sha256>/rea-<version>/<provider>/<tool>.json`,
keyed by the SHA-256 of the exact bytes analysed (the thinned slice for a
universal binary), the REA version and the deep provider (`none` for Go build
info). A repeat run of the same binary reuses every cached step, keeps the
original evidence IDs, and does not start REA or Docker at all: about 2 s,
mostly preflight's `rea doctor`. Only missing steps run after a partial run.
Failed, skipped and cancelled steps are never cached; entries that fail the
schema check are discarded. Send `{"path": ..., "fresh": true}` to re-analyse.
Nothing is evicted yet; delete the folder to reclaim space.

| Method | Path                               |                                                                        |
| ------ | ---------------------------------- | ---------------------------------------------------------------------- |
| `POST` | `/api/jobs`                        | `{"path": "/abs/path"}` (JSON only) → the new job                      |
| `GET`  | `/api/jobs`, `/api/jobs/:id`       | jobs with each step's status, timing, summary or real error            |
| `GET`  | `/api/jobs/:id/events`             | Server-Sent Events: a snapshot, then `step`, `job`, `heartbeat`, `log` |
| `POST` | `/api/jobs/:id/cancel`             | aborts the running REA call and stops its process/container            |
| `GET`  | `/api/jobs/:id/steps/:step/result` | the step's full REA result                                             |

The server listens on 127.0.0.1 only and rejects non-local `Host` headers.

## Expected durations

Each live step's duration is appended to `~/.binlight/history.jsonl`, keyed by
the analysed bytes' SHA-256 and size, the tool, the route, and whether that call
carried the disassembler's analysis. A running step then shows what to expect:
how long **the same binary** took last time, or, for a new binary's analysis,
an **estimate by size** from earlier analyses on this machine (labelled as
one). With no history it shows no number. Cached steps say when the reused
result was produced.

## Findings and verdict

After a job's last step, the recipe's **rules** turn REA's results into
findings, each citing REA evidence IDs (`apps/server/src/rules/`). A rule that
lacked an input says "not run" with the reason. The **verdict** is then built
from the findings: a short answer, claims that each cite findings, a confidence
set by what actually ran, and the gaps.

AI is **off by default** (local-only): the verdict comes from the rules alone
and nothing leaves the machine. To have Claude rewrite verdicts in plain
English, open the **AI** card in the page, paste your own Claude API key (it is
checked with Claude, then stored in the macOS Keychain; the page only ever sees
`sk-ant-…` plus the last 4 characters), and switch Claude on. A key in
`ANTHROPIC_API_KEY` on the server works too. Settings that aren't secret live
in `~/.binlight/settings.json` (`BINLIGHT_SETTINGS_PATH` to override).

By default each job **asks first**: the verdict shows exactly what would be
sent (model, instructions, and the findings' statements and caveats, never
snippets, strings or binaries) with "Send to Claude" and "Keep the rule-based
verdict". Claude's version is shown only if it passes Binlight's validator:
every claim cites findings of the job, states no number they don't contain, and
avoids "only N servers", "talks to" and safety judgements. Otherwise the page
shows the rule-based verdict with the reason.

With Claude on, a question box maps a question in your own words to a recipe
(or says no recipe covers it); the question and the recipe list are sent.

## Sharing a report

**Download report** on a finished job (or `GET /api/jobs/:id/export`) gives
one self-contained HTML file to share: the verdict and where it came from,
confidence and what wasn't checked, findings with caveats, an excerpt of every
cited REA evidence record, and the identity of what was analysed (SHA-256, REA
version, provider, Binlight version). It has no scripts and loads nothing (its
own Content-Security-Policy is `default-src 'none'`), so it opens offline.
Text from the binary is escaped, string evidence appears only as short
snippets, credential-shaped values are truncated, and the file stays under
about 2 MB (anything left out is announced).

## Docker runner (deep analysis on Apple Silicon)

Ghidra ships no arm64 macOS decompiler, so on Apple Silicon deep analysis runs
in a `linux/amd64` image with REA, Ghidra 12.1.4 (checksum-verified) and JDK 21.
Build it once (needs Docker; uses `~/Applications/ghidra.zip` if present,
otherwise downloads the release):

```bash
npm run runner:build     # -> binlight-runner:rea-6.7.0
```

The target is first staged to `~/.binlight/cache/targets/<sha256>/` (an APFS
clone; Docker Desktop cannot mount folders such as `/opt/homebrew`). Each
analysis runs `rea --mcp` in its own container: `--network none`, a
non-root user, read-only root filesystem, no capabilities, the target mounted
read-only, and only a per-session Docker volume writable (removed afterwards). Ghidra's heap defaults to 4G (`GHIDRA_HEADLESS_MAXMEM`). Preflight
picks this route automatically when nothing faster works.

## REA contract tests

Binlight parses REA's responses with the schemas in `apps/server/src/rea/schemas.ts`
and keeps a recording of every response shape it relies on, per REA version and
deep provider, in `apps/server/test/contracts/`. The target is a tiny Go program
in `apps/server/test/fixtures/hello-go`, built on each run (needs Go).

```bash
npm run test:contract                        # live: local REA, plus Docker if built
npm run contracts:record                     # after a deliberate REA upgrade
npm run contracts:record -- --runner docker  # Ghidra in the runner image
```

`npm test` checks the recordings offline against the schemas.

## Check

```bash
npm run check        # typecheck + lint + format check + tests
```

Individual scripts: `typecheck`, `lint`, `format`, `format:check`, `test`, `build`.

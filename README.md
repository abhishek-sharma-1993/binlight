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

## Check

```bash
npm run check        # typecheck + lint + format check + tests
```

Individual scripts: `typecheck`, `lint`, `format`, `format:check`, `test`, `build`.

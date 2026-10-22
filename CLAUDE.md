# Binlight

Binlight is a web app that puts a visual, question-led workspace on top of
[REA](https://github.com/morluto/rea) (an MIT-licensed reverse-engineering MCP
server). A developer drops in an app, asks a plain question ("does this phone
home?"), watches the AI investigate live, and gets a verdict with every claim
linked to REA evidence, then shares the investigation as one HTML file.

Owner: Abhishek Sharma. Personal, independent project (not affiliated with REA,
Ghidra or Anthropic).

## Decisions already made (don't reopen without asking)

- **Audience:** working developers first; security researchers second.
- **Independent tool**, not an upstream contribution to REA. The name must never
  contain "REA".
- **Platform:** web app. Desktop wrapper only if users ask.
- **AI:** the user's own Claude API key only. No local model. Also offer a
  local-only mode with AI switched off.
- **Stack:** TypeScript end to end: Node server + React web app.
- **Scope model:** phases end at gates, not dates (ongoing project).

## Architecture

```
Browser UI ──HTTP + live events──► Binlight server ──MCP over stdio──► REA MCP server ──► Ghidra / Hopper / IDA / Go-Rust readers
                                     │    │
                                     │    └── Claude API (user's key): plans steps, explains findings
                                     └── Evidence cache: analyses reused, exported as one HTML file
```

- The browser never talks to REA directly.
- Start REA's MCP server with `rea --mcp` (verified: answers the MCP handshake
  over stdio). `rea mcp` is a different command that _registers_ REA with clients.
- Use one MCP session per binary: `open_binary` once, then `binary_overview`,
  `list_strings`, `list_procedures`, etc. reuse that analysis. Each one-shot
  `rea <command>` CLI call re-runs Ghidra's whole analysis (see lessons).

## Phases

| Phase         | Builds                                                 | Gate                                   |
| ------------- | ------------------------------------------------------ | -------------------------------------- |
| 0 Foundations | zero-setup runtime, REA MCP client, job runner + cache | analyses kubectl and Ollama end to end |
| 1 v1 MVP      | 3 recipes, live step feed, verdict + HTML export       | 5 developers finish a recipe unaided   |
| 2 Explore     | code map by library, call graph, function explainer    | public launch with demo video          |
| 3 Grow        | Electron recipe, community recipes, desktop app        | first community recipe merged          |

**Current phase: 0.** Plan: `docs/phase-0-plan.md`.

## Read before working

- `docs/brief.md`: product brief (gaps, users, v1 flow, recipes, risks).
- `docs/phase-0-plan.md`: the tasks for the current phase.
- `docs/lessons-learned.md`: verified facts about REA, Ghidra and macOS from
  real runs. Read it before touching analysis code; it will save hours.
- `reference/bindossier.py`: the earlier prototype. Reuse its tested logic for
  endpoint detection, credential patterns and snippets.

## Working agreements

- Communicate crisply: short, direct, bullet summaries.
- Never claim a finding the evidence doesn't show. Every claim in a verdict
  cites a REA evidence ID.
- Surface failures in the UI with the real reason. Never show zeros or blanks
  for a step that failed (an earlier prototype did, and it misled users).
- Only analyse software the user owns, open-source software, or software they
  are authorised to inspect. No DRM, licence-check or anti-cheat bypass features.
- Test on real binaries before calling something done: `kubectl` and `ollama`
  are the reference targets.

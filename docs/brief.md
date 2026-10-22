# Binlight — product brief (summary)

The full brief with diagrams lives in a private Claude doc:
https://claude.ai/artifact/QZuGXBvGL7jj4Hg8BhWdsf (Binlight — Product Brief & Roadmap).
This file is the working copy for the codebase.

## The gap

REA is powerful but built for agents and terminals. Every gap below was hit in
real use:

| Gap                  | What happened                                                                                                           | What Binlight does                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Nothing to look at   | Output is JSON evidence and text views                                                                                  | Visual map, click-through code, live feed of each AI step |
| Fragile setup        | Hopper demo dialog blocks automation; Ghidra ships no Apple Silicon decompiler; universal binaries need manual thinning | Zero-setup runtime that detects and fixes these first     |
| Long, silent runs    | 21 min natively for Ollama, hours under emulation, no progress, no reuse                                                | Per-step progress, background jobs, cached analyses       |
| Raw findings mislead | A sample password in kubectl's help text and jq's base64 errors looked alarming                                         | Plain-English verdict with evidence for every finding     |
| Too many tools       | 207 MCP tools, 153 CLI commands                                                                                         | Start from a question; a recipe picks the tools           |
| Results stay local   | No way to share an investigation                                                                                        | One self-contained HTML export                            |

## Users and jobs

Working developers, not RE specialists. Jobs: understand a feature, audit a
dependency, check privacy claims, review a release, explain findings to others.

## v1 flow

1. Drop an app (binary, `.app`, `.apk`, Electron bundle). Detect type, thin
   universal binaries, pick a working provider, say what can't be analysed.
2. Pick a recipe or type a question.
3. Watch it work: live feed per REA step, progress, elapsed time, cache reuse.
4. Read the verdict: short answer, confidence, every claim linked to evidence.
5. Explore: code grouped by library, function → decompiled code + explanation,
   callers/callees, strings.
6. Share: export one self-contained HTML file.

Target: first useful answer within 10 minutes for a typical CLI tool; seconds
for recipes that skip the decompiler.

## Recipes

| Recipe              | Question                                              | REA tools                                                                        | Decompiler   | Phase |
| ------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- | ------------ | ----- |
| What's inside       | What is it built from, and is it current?             | `inspect_go_binary`, `inspect_rust_binary`, `binary_overview`                    | No (Go/Rust) | v1    |
| Does it phone home? | Which servers can it contact, from where in the code? | `search_strings`, `find_xrefs_to_name`, `xrefs`                                  | Yes          | v1    |
| What changed?       | What differs between two releases?                    | `compare_artifacts`, `compare_functions`, `find_changed_behavior`                | Yes          | v1    |
| How does X work?    | How does this feature work inside?                    | `search_procedures`, `trace_feature`, `build_call_path`, `procedure_pseudo_code` | Yes          | v2    |
| Electron hardening  | Are its security switches set safely?                 | `analyze_javascript_application`, `inspect_electron_fuses`                       | No           | v2    |

Tool names were taken from REA 6.x's MCP catalogue; confirm them with
`tools/list` before relying on their argument shapes.

## Risks

| Risk                                         | Mitigation                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A name containing "REA" reads as official    | Decided: independent tool named Binlight                                                         |
| Decompiled code sent to an AI API            | Local-only mode (no AI); clear notice before any upload                                          |
| REA changes fast (6.5.0 → 6.7.0 within days) | Pin REA's version; contract tests on the tools Binlight calls                                    |
| Slow deep analysis                           | Background jobs, progress, caching; decompiler-free recipes first                                |
| Apple Silicon support                        | Default to the linux/amd64 container for the deep pass, or build Ghidra's arm64 decompiler in CI |
| Misuse                                       | Transparency-focused recipes only; no DRM/licence bypass; keep a disclaimer                      |

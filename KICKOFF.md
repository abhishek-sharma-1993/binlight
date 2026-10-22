# Kickoff prompt for Claude Code

Open a terminal in this folder, run `claude`, and paste:

---

Read CLAUDE.md and everything in docs/ first. We are starting phase 0 of
Binlight (docs/phase-0-plan.md). Work through the tasks in order. Before each
task, tell me in two or three bullets what you're about to do; after it, show
what you verified. Start with task 1 (repo scaffold) and task 2 (REA MCP client),
then stop and show me a working `tools/list` call against `rea --mcp`.
Initialise git and commit after each task.

---

Prerequisites on this Mac (already installed during the earlier work):

- Node.js and the `rea` CLI (`npm install -g rea-agents`)
- Ghidra 12.1.4 at ~/Applications/ghidra_12.1.4_PUBLIC (JDK 21: Temurin)
- Docker Desktop (needed for deep analysis on Apple Silicon)

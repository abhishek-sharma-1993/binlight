# Phase 1: v1 MVP

**Gate:** 5 working developers each finish a recipe unaided: from installing
Binlight to reading a verdict they can explain back, on software of their
choosing that they are authorised to inspect, with no help from the owner
beyond the written instructions.

**Draft, 24 Oct 2026.** Decisions marked ❓ need the owner (see the end).

## Where phase 0 leaves us

- Jobs run one REA session per binary, with live events, cancel and an
  evidence cache (repeat runs in 2–4 s).
- Deep analysis works on Apple Silicon through the Docker Ghidra runner:
  Ollama 8.8 min, kubectl 18 min first time (`docs/gate-run-phase-0.md`).
- The page shows raw results only. There are no recipes, findings, verdicts or
  export yet, and no Claude API calls.

## How phase 1 is built

- **One vertical slice first.** "What's inside" goes all the way to a verdict
  and an HTML export before the other recipes start, and 1–2 developers try it
  early. It needs no decompiler, so it answers in seconds.
- **Findings come from rules; the verdict only explains them.** Recipes run a
  fixed list of REA tools; deterministic rules turn REA evidence into findings,
  each citing evidence IDs. Claude (the user's key) writes the plain-English
  verdict _from the findings_, and a validator rejects any claim that doesn't
  cite one. Local-only mode shows the rule-based verdict with AI switched off.
- **Honest wording is a requirement**, not polish: never "talks to only N
  servers"; say what static analysis can't see; known false alarms are
  suppressed with a note, not silently.
- **Ask REA for what a recipe needs.** kubectl's full strings list is ~19 MB and
  takes 79 s; recipes should search or filter where REA allows it.
- Real binaries before "done": kubectl and Ollama, plus a fixture per feature.

## Tasks

### A. Recipe foundations

- [ ] **1. Recipe engine.** A recipe declares its question, its steps (REA tool,
      arguments, whether it needs a deep route, a plain-language label and why
      it runs) and its rules. The job runner runs recipe steps instead of phase
      0's fixed list; per-step caching is unchanged. Jobs can take two targets
      (for "What changed?"). The page gets a recipe picker and a question box:
      with AI on, Claude maps a question to a recipe or says honestly that no
      recipe covers it; in local-only mode the picker alone.
- [ ] **2. Findings model.** `Finding {id, kind, statement, evidence[],
confidence (observed | inferred), caveats}`. Each evidence reference is an
      REA evidence ID plus a locator (address, file offset or ±36-char snippet).
      Rules are pure functions with a test each, including the known false
      alarms from lessons-learned.
- [ ] **3. Verdict.** Always a rule-based verdict: a short answer, confidence
      and the findings that support it. With AI on, Claude rewrites it in plain
      English using structured output where every claim lists the finding IDs
      it rests on. The validator rejects unknown IDs and numbers that aren't in
      the findings; on rejection or API failure the page shows the rule-based
      verdict and the real reason. Model configurable, chosen from the current
      Claude API docs when this task starts.
- [ ] **4. AI settings and privacy.** Enter the user's Claude API key ❓(where it
      is stored), local-only switch ❓(default), and before the first AI call in
      a job, a preview of exactly what will be sent: findings and short
      snippets, never binaries or whole string lists. The key never reaches the
      browser after entry, logs or exports.
- [ ] **5. HTML export.** One self-contained file: no external requests, a
      strict CSP, and it opens offline. It holds the verdict, the findings, an
      excerpt of every cited evidence record, the binary's identity (SHA-256,
      REA version, provider, Binlight version), what wasn't analysed and why,
      and the authorised-use note. Size budget ~2 MB. Tests: every cited
      evidence ID is present in the file; no network access when opened.
- [ ] **6. Step feed.** Plain-language step labels and "why this step", the
      expected duration from this machine's history ("kubectl's analysis took
      16 min last time"), cache reuse called out, and failures shown with
      REA's code, message and fix (already true; keep it).

### B. Recipe 1: What's inside? (no decompiler)

- [ ] **7. Recipe.** Question: "What is it built from, and is it current?"
      Steps: preflight, `inspect_go_binary`, `inspect_rust_binary`, plus format
      and signing (`inspect_macho`, `inspect_signature`; confirm the shapes
      first). Findings: - language and toolchain (Go version), main module and version, `+dirty`
      or VCS revision and time when embedded; - every dependency with its version, plus replaced modules; - build settings that matter (CGO, `-trimpath`, build mode); - who signed it, or that it is unsigned; - "is it current": the Go toolchain's support status from a bundled Go
      release table (offline), and ❓ an opt-in online check of dependency
      versions and known vulnerabilities; - for binaries with no embedded dependency metadata, say so plainly
      rather than show an empty list.
      Acceptance: kubectl and Ollama answer in under 10 s with no Ghidra; the
      dependency list matches `go version -m` for both (a test oracle); every
      claim cites evidence.
- [ ] **8. Contract tests** for `inspect_rust_binary`, `inspect_macho` and
      `inspect_signature`, and a Rust fixture built with `cargo auditable`
      ❓(needs a Rust toolchain on this Mac).
- [ ] **9. Early user check.** 1–2 developers run "What's inside" from a clean
      install, watched but unaided. Fix what confuses them before B → C.

### C. Recipe 2: Does it phone home? (decompiler)

- [ ] **10. Spike: from a URL to the code that uses it.** Neither Ghidra nor
      Hopper lists URLs packed inside Go string data, and `search_strings`
      only searches the provider's string objects. So: scan the file's bytes
      for URL candidates (port `find_endpoints` and `snippets` from
      `reference/bindossier.py`), map each file offset to an address (segment
      tables, or REA's `address_to_file_offset`), then `xrefs` and
      `resolve_containing_procedure` for the function that references it.
      Measure on kubectl and Ollama what share of candidates reach a function.
      This decides whether v1 can say "from where in the code" or only
      "mentions".
- [ ] **11. Recipe.** Findings: - hard-coded destinations by **hostname** (paths swallow the next glued
      literal), each with snippet, offset and, where the spike allows, the
      referencing function; - network capability from procedure names (Go `net/http`, `net.Dial`,
      `crypto/tls`; Rust equivalents), via `search_procedures`; - credential **values** only by strict patterns, always truncated;
      credential-related names are not findings; - known false alarms suppressed with a visible note (kubectl's sample
      `--password=uXFGweU9l35qcif`, `sk-ecdsa-sha2-nistp256@openssh.com`).
      The verdict always states the limits: addresses built at runtime (Ollama's
      registry) and scheme-less mentions (`ollama.com` ×10) can't be seen as
      hard-coded URLs. Acceptance: hand-checked expected findings for kubectl
      and Ollama kept as golden files.

### D. Recipe 3: What changed? (decompiler)

- [ ] **12. Two-target jobs.** Both binaries preflighted and analysed (the cache
      makes repeats cheap) with the same provider; if they differ, say so.
- [ ] **13. Recipe.** Findings, cheapest and most reliable first: - dependency changes: added, removed, upgraded or downgraded modules and
      the Go toolchain change (no decompiler); - new and removed hard-coded destinations (recipe 2's scanner); - procedure-set changes, normalised to drop compiler noise (Go `func1`
      closures, `type..eq`), grouped by package; - new credential-like values; size and segment changes.
      `compare_functions` for a capped set of changed functions is a stretch.
      Acceptance: two real releases of Ollama or kubectl ❓(downloading an older
      release), findings hand-checked.

### E. The gate

- [ ] **14. Zero-setup install for testers.** One command to start; detect and
      explain missing Docker; ❓ pull the runner image from a registry instead
      of a 6-minute local build plus a 570 MB Ghidra download; a first-run page
      that checks everything and says what to fix.
- [ ] **15. Contract and regression tests.** Recorded shapes for every new REA
      tool; golden findings for kubectl and Ollama per recipe.
- [ ] **16. Gate study.** ❓5 working developers. Script: install, pick a recipe,
      run it on software they're authorised to inspect, explain the verdict
      back. Record: finished unaided (yes/no), time to first answer, any claim
      they misread, where they got stuck. Report in `docs/gate-run-phase-1.md`.

## Out of scope for phase 1

Explore (code map by library, call graph, function explainer), "How does X
work?", the Electron recipe, community recipes, a desktop app, hosted or
multi-user use. Those are phases 2–3.

## Risks

| Risk                                                                   | Mitigation                                                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| URL → function mapping fails for Go literals (task 10)                 | v1 reports "mentions" with offsets and snippets; "from where in the code" ships only where xrefs resolve |
| AI verdict overstates findings                                         | Structured claims citing finding IDs, a validator, rule-based fallback                                   |
| Users send code or strings to an AI API unknowingly                    | Local-only mode; preview of exactly what is sent; no binaries or whole lists                             |
| Testers can't install (Docker, image build)                            | Task 14 before the study; first-run checks with fixes                                                    |
| Bigger binaries exhaust Ghidra's 4 GB heap (kubectl peaked at 3.7 GiB) | Surface REA's heap error; `BINLIGHT_GHIDRA_MAXMEM`; document the Docker memory setting                   |
| REA changes (6.x moves fast)                                           | REA stays pinned; contract tests on every tool used                                                      |

## Decisions needed (❓)

1. **Where the Claude API key lives.** Options: server environment variable only,
   or entered in the page and stored in the macOS Keychain. Recommended: the
   Keychain, so testers don't edit shell files.
2. **AI default on first run.** Recommended: local-only until a key is added.
3. **"Is it current?" online check.** Recommended: offline by default; opt-in
   check against the Go module proxy and OSV that sends only module paths and
   versions, with a notice.
4. **Runner image distribution.** Publish `binlight-runner` to a registry
   (Ghidra is Apache 2.0, REA MIT), or keep the local build.
5. **Rust toolchain** on this Mac to build the Rust fixture (`rustup`,
   `cargo-auditable`).
6. **An older Ollama or kubectl release** downloaded as the "What changed?"
   reference pair.
7. **The 5 developers**: who, and when task 16 runs.

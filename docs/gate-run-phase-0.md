# Phase 0 gate run

**Gate:** Binlight analyses `kubectl` and `ollama` end to end (overview, strings,
procedures, Go libraries) through one MCP session each, with progress shown and
results cached, on the owner's Apple Silicon Mac.

**Result: passed on 23 Oct 2026**, after one fix (below).

## Setup

|                           |                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| Machine                   | Apple M2, 16 GB, macOS 26.5.1                                                               |
| Route chosen by preflight | `docker-ghidra` (native Ghidra has no arm64 decompiler; Hopper is the demo build)           |
| Runner                    | `binlight-runner:rea-6.7.0`: REA 6.7.0, Ghidra 12.1.4, JDK 21, linux/amd64 under emulation  |
| Docker                    | Desktop 29.8.1, 8 CPUs, 8 GB VM; Ghidra heap 4G                                             |
| How                       | Both jobs queued through the HTTP API, one deep job at a time, watched live in the web page |

## Fresh runs (cache ignored, one REA session each)

| Step                           | Ollama 0.40.6                                                              | kubectl 1.37.1                                                |
| ------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Preflight                      | 5.9 s                                                                      | 4.4 s                                                         |
| Start REA (container)          | 2.4 s                                                                      | 2.2 s                                                         |
| Open binary                    | 0.7 s                                                                      | 0.8 s                                                         |
| Go build info                  | 0.2 s: go1.27.2, `github.com/ollama/ollama v0.40.6+dirty`, 51 dependencies | 0.3 s: go1.26.8, `k8s.io/kubernetes v1.37.1`, 88 dependencies |
| Overview (the Ghidra analysis) | **8.5 min**: 32 segments, 27,735 procedures, 51,784 strings                | **16.3 min**: 27 segments, 88,901 procedures, 237,578 strings |
| List strings                   | 5.5 s (51,784)                                                             | 79 s (237,578)                                                |
| List procedures                | 1.8 s (27,735)                                                             | 12.5 s (88,901)                                               |
| Close                          | 0.7 s                                                                      | 1.7 s                                                         |
| **Job total**                  | **8.8 min**                                                                | **18.0 min**                                                  |

Every count comes from a step that succeeded and cites a REA evidence ID
(e.g. Ollama overview `ev_401e74a9b22…`, kubectl strings `ev_17d8430128b…`).
Peak sampled container memory was 3.68 GiB.

## Repeat runs (evidence cache)

|                      | Ollama                            | kubectl                           |
| -------------------- | --------------------------------- | --------------------------------- |
| Job total            | **3.9 s**                         | **2.0 s**                         |
| REA / Docker started | no                                | no                                |
| Cached steps         | Go, overview, strings, procedures | Go, overview, strings, procedures |
| Cache size           | 5.2 MB                            | 23 MB                             |

kubectl's 19 MB strings result is served from disk in 0.1 s and previewed in the
page in 0.25 s (first 200 KB, with a link to the full JSON). The repeat time is
mostly preflight: hashing the binary and running `rea doctor`.

## Against the reference results

|                                            | Segments | Procedures | Strings    | Go       | Libraries |
| ------------------------------------------ | -------- | ---------- | ---------- | -------- | --------- |
| Ollama, reference (lessons-learned)        | 32       | 27,735     | 51,781     | go1.27.2 | 51        |
| Ollama, gate run                           | 32       | 27,735     | **51,784** | go1.27.2 | 51        |
| kubectl, reference (`/usr/local/bin` copy) | 19       | 37,246     | 97,076     | go1.22.5 | 84        |
| kubectl, gate run (Homebrew 1.37.1)        | 27       | 88,901     | 237,578    | go1.26.8 | 88        |

- **Ollama matches** on segments, procedures, Go version and libraries. Strings
  differ by 3 (51,784 vs 51,781). The reference was produced with REA 6.5/6.7
  in a different setup; the difference is not investigated yet.
- **kubectl is a different binary** (Homebrew 1.37.1, go1.26.8, 64 MB) from the
  reference copy (go1.22.5, 57 MB), so its counts are not comparable. These
  numbers are the new reference for this Mac.

## What failed first, and the fix

The first run (11:10–11:36 UTC) analysed both binaries but failed
`list_strings` and `list_procedures` on both with REA's `resource_constraint`:
the complete responses exceed REA's stdio response budget, **10 MiB by default**
(it matches the MCP SDK's default stdio buffer). The jobs showed REA's error
and remediation and no counts, as designed.

Fix (`49a08a5`): set `REA_MCP_MAX_RESPONSE_BYTES` and the client's
`maxBufferSize` to 256 MiB, and give every deep step the 12 h analysis timeout
(REA analyses on whichever deep step runs first). The fresh runs above use it.

## Findings for phase 1

- Deep analysis of the reference targets takes **minutes, not hours**, on an M2
  under emulation. A "does it phone home?" answer for kubectl can be ready in
  under 20 minutes first time and seconds after.
- Peak memory (3.68 GiB of a 4 GB heap) leaves little room for bigger binaries.
  Watch for heap exhaustion; `BINLIGHT_GHIDRA_MAXMEM` raises it.
- kubectl's strings response is ~19 MB and takes 79 s end to end. Recipes should
  ask REA for what they need (`search_strings`, filters) rather than whole lists.
- Neither Ghidra nor Hopper lists URLs glued inside Go's packed string data (see
  lessons-learned); the phone-home recipe needs its own splitting.

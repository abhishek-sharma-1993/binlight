# Spike: from a hard-coded URL to the code that uses it (phase 1 task 10)

**Run 20 Nov 2026** on kubectl 1.37.1 and Ollama 0.40.6 (Homebrew, arm64),
REA 6.7.0, Ghidra 12.1.4 in the Docker runner. Code:
`apps/server/src/spikes/phone-home.ts`; Go name check:
`apps/server/test/oracles/gosym/`.

## Answer

**v1 can say "from where in the code" for some hosts, and must say "mentioned"
for the rest.** For Ollama, 9 of 43 hosts are used by a function Binlight can
point to with evidence. For kubectl it is 3 of 36. The rest are text: help
messages, API docs, licences.

Two things make it work, and one doesn't:

| Method                                                  | Result                                                                                  | Use in v1                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------ |
| REA `search_bytes` for `https://` / `http://`           | Finds **every** occurrence the raw byte scan finds (kubectl 1,029/1,029, Ollama 99/99)  | Yes: replaces the strings list |
| `xrefs` to the URL, then `resolve_containing_procedure` | Observed link to a function (Ollama 28 of 95 occurrences, kubectl 3 of 992)             | Yes: "used in …"               |
| Walk back up to 96 bytes to the nearest referenced byte | Reaches many more (Ollama 44, kubectl 151) but sometimes picks the **previous** message | No (see below)                 |

## Measurements

|                                                           | kubectl                     | Ollama           |
| --------------------------------------------------------- | --------------------------- | ---------------- |
| Byte scan: `http(s)://` occurrences / with a host / hosts | 1,029 / 992 / 36            | 99 / 95 / 43     |
| `search_bytes` matches (missed hosts)                     | 1,029 (none)                | 99 (none)        |
| Occurrences with a direct reference, or via one data hop  | 2 + 1                       | 24 + 4           |
| Hosts with an observed function                           | **3 of 36**                 | **9 of 43**      |
| Hosts reached only by walking back (inferred)             | 11                          | 25               |
| Hosts not reached at all                                  | 22                          | 9                |
| Ghidra analysis (`binary_overview`)                       | 17.6 min                    | 8.3 min          |
| Everything after analysis, observed path only             | about 5 s                   | about 2 s        |
| Walk-back cost on top                                     | 92,529 `xrefs` calls, 148 s | 2,604 calls, 4 s |

Hosts with an observed function. Ghidra calls these functions `FUN_…`; the Go
names below come from Go's own function table (see "Function names"):

- **Ollama**
  - `ollama.com`: `server.signinURL`, `anthropic.WebSearch`, `cmd.PushHandler`,
    `server.(*modelRecommendationsCache).refresh`, …
  - `api.openai.com`: `internal/proxy.NewCodexDesktop`
  - `127.0.0.1`: `llm.(*llamaServerRunner).Chat` and other local-runner calls
  - `registry.npmjs.org`: `cmd/launch.npmLatestPackageVersion`
  - also `chatgpt.com`, `opencode.ai`, `protobuf.dev` and `www.w3.org`
    (`encoding/xml`)
- **kubectl**
  - `index.docker.io`: `create.NewSecretDockerRegistryOptions`
  - also `protobuf.dev` and `www.w3.org`

## What we learned

1. **Search the bytes through REA, not the string list.** `search_bytes` is
   complete for these binaries and every match carries an address and an
   evidence ID. The string list misses most Go URLs (lessons, 30 Oct).
2. **Most URLs in Go binaries are text, not destinations.** 266 kubectl
   occurrences of `kubernetes.io` are "More info:" links in API docs. Go code
   references a literal's _start_, and these URLs sit in the middle of long
   messages, so they have no reference of their own. That's correct: no code
   uses them as an address.
3. **Walking back is guesswork.** The nearest referenced byte is often the
   start of the message ("see ", "install from ", "More info: "): 40 of 44
   Ollama cases look like that. But some land on the previous literal.
   `code.claude.com` came back as part of `function name %q is not a valid
identifier`, and `developers.openai.com` as part of `option %q must be of an
array of strings`. A wrong "used in" would break the evidence rule, so v1
   leaves it out. Telling the cases apart needs the instruction that loads the
   literal and its length, which a later phase can try.
4. **Ghidra names almost none of the functions in release Go binaries.**
   99.5% of kubectl's 88,901 and 96% of Ollama's 27,735 functions are
   `FUN_<address>`: the symbol table is stripped and Ghidra 12.1.4 does not read
   Go 1.26/1.27's function table. Go's table (`__gopclntab`) still has every
   name with its source file and line. Read with Go's `debug/gosym`, it agrees
   with Ghidra on every function entry: Ollama 50/50, kubectl 39/39. Without
   names, "used in FUN_100495070" tells a developer nothing.
5. **Hostnames need trimming.** Glued hosts appear in real results:
   `ollama.compulling`, `registry.npmjs.orghttps`, `issues.k8s` and
   `htmlpreview.github`. Task 11 needs a suffix-aware cut (public-suffix list,
   or known TLDs plus a dictionary check), with the raw text kept as evidence.
6. **The cost is the analysis, not the tracing.** The observed path adds
   seconds after Ghidra's analysis (17.6 / 8.3 min, cached after the first
   run).

## Proposal for task 11

- Destinations from `search_bytes` + `read_bytes` (REA evidence), hostnames
  trimmed.
- For each occurrence: `xrefs` and one data hop. Only those reaching a
  function become "used in <function>", confidence observed. The rest are
  "mentioned in text", stated as such.
- Verdict wording: "N hosts are used by code (named below); M more are only
  mentioned in text, such as help messages and docs." It never claims the app
  talks to only N servers (addresses built at runtime are invisible).
- ❓ **Function names (owner's decision).** Options:
  - **(a) Recommended.** Binlight reads Go's function table itself: a port of
    `debug/gosym`, about 300 lines. The address and the reference come from REA
    evidence; the name is a lookup in the file, labelled as such, and checked
    against Ghidra's function entry.
  - **(b)** Ask REA upstream to expose Go function names.
  - **(c)** Show `FUN_…` addresses only.

## Reproduce

```bash
cd apps/server
npx tsx --conditions=@binlight/source src/spikes/phone-home.ts /opt/homebrew/bin/ollama /tmp/out
cd test/oracles/gosym && go build -o /tmp/gosym . && /tmp/gosym at "$(readlink -f /opt/homebrew/bin/ollama)" 0x1004950fc
```

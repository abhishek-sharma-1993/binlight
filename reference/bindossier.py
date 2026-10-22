#!/usr/bin/env python3
"""
BinDossier — automated binary transparency report built on REA.

Drives the REA CLI against a binary you own or are authorised to analyse, then
assembles an evidence-backed HTML report: format/architecture, embedded
dependencies (Go/Rust), notable strings (URLs, crypto, secrets-ish), and the
function/string inventory. Every section cites REA evidence IDs.

Usage:
    python3 bindossier.py /path/to/binary [--provider ghidra] [--out report.html]

Requires: `rea` on PATH (npm i -g rea-agents). For decompile/strings/functions,
a native provider (Ghidra/Hopper/IDA) must be configured; static inspectors
(Go/Rust/managed) need no provider.
"""
import argparse, json, subprocess, sys, html, re, shutil, os
from datetime import datetime, timezone

CRYPTO = re.compile(r"\b(aes|rsa|sha-?\d|md5|hmac|tls|x509|pbkdf2|chacha|ecdsa|curve25519|base64)\b", re.I)
# Names/labels that relate to credentials (NOT values): env var names, struct fields, error text.
SECRET_NAMES = re.compile(r"(api[_-]?key|secret|token|password|passwd|bearer|authorization)", re.I)
# Strict patterns for actual credential VALUES. A hit here is worth a human look.
SECRET_VALUES = [
    ("AWS access key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("OpenAI/Anthropic-style key", re.compile(r"sk-(?:ant-)?[A-Za-z0-9_-]{24,}")),
    ("GitHub token", re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}")),
    ("Slack token", re.compile(r"xox[abprs]-[A-Za-z0-9-]{10,}")),
    ("Google API key", re.compile(r"AIza[0-9A-Za-z_-]{35}")),
    ("Private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("JWT", re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
]
# Compilers (Go especially) pack string literals end to end with no separator, so a URL is
# often glued to the text before it ("...NUMBER_IDhttps://..."). Split on every scheme instead
# of requiring a word boundary, then take the hostname.
URL_START = re.compile(r"https?://", re.I)
HOST = re.compile(r"https?://([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(/[A-Za-z0-9._~/%-]{0,40})?", re.I)


def find_endpoints(vals, cap=60):
    """Return 'host/path' endpoints found in strings, deduplicated by host+path."""
    found = {}
    for v in vals:
        starts = [m.start() for m in URL_START.finditer(v)]
        for i, s in enumerate(starts):
            seg = v[s: starts[i + 1] if i + 1 < len(starts) else len(v)]
            m = HOST.match(seg)
            if m:
                ep = m.group(1).lower() + (m.group(2) or "")
                found.setdefault(m.group(1).lower(), set()).add(ep)
    # Hostnames only: the path part often swallows the next glued string literal
    # ("/Claude.appcowork"), which would mislead a reader. Hosts are reliable.
    return sorted(found)[:cap]


def snippets(vals, rx, width=36, per_token=3, cap=40):
    """Short context around each match instead of the whole (often multi-KB) string blob."""
    seen, per, out = set(), {}, []
    for v in vals:
        for m in rx.finditer(v):
            tok = m.group(0).lower()
            if per.get(tok, 0) >= per_token:
                continue
            a, b = max(0, m.start() - width), min(len(v), m.end() + width)
            snip = ("…" if a else "") + v[a:b].replace("\n", " ") + ("…" if b < len(v) else "")
            if snip in seen:
                continue
            seen.add(snip); per[tok] = per.get(tok, 0) + 1; out.append(snip)
            if len(out) >= cap:
                return out
    return out


def secret_values(vals):
    hits = []
    for v in vals:
        for label, rx in SECRET_VALUES:
            for m in rx.finditer(v):
                hits.append(f"{label}: {m.group(0)[:12]}…")   # never print a full credential
    return sorted(set(hits))


TIMEOUT = 7200   # seconds per REA call; big binaries under Docker emulation need a long leash


def rea(args, timeout=None):
    """Run a rea CLI command, return parsed JSON normalized_result (or raw)."""
    timeout = timeout or TIMEOUT
    cmd = ["rea", *args, "--format", "json"]
    env = dict(os.environ)
    # Ghidra's initial analysis counts toward REA's provider startup deadline; give it the same budget.
    env.setdefault("REA_GHIDRA_STARTUP_TIMEOUT_MS", str(timeout * 1000))
    env.setdefault("REA_HOPPER_STARTUP_TIMEOUT_MS", str(timeout * 1000))
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"`rea {args[0]}` exceeded {timeout}s (raise with --timeout)")
    if p.returncode != 0:
        msg = (p.stderr.strip() or p.stdout.strip())
        m = re.search(r'message:\s*"?([^\n"]+)', msg)
        raise RuntimeError(f"`rea {args[0]}` failed: {(m.group(1) if m else msg)[:400]}")
    data = json.loads(p.stdout)
    if isinstance(data, dict) and "normalized_result" in data:
        return data["normalized_result"], data.get("evidence_id", "")
    return data, ""


def try_rea(args, **kw):
    try:
        return rea(args, **kw)
    except Exception as e:
        return {"__error__": str(e)}, ""


def collect(path, provider, deep=True):
    report = {"target": path, "generated": datetime.now(timezone.utc).isoformat(), "sections": [],
              "arch": None, "format": None}

    # 1. Language-specific dependency provenance (no provider needed; fast even on huge binaries).
    #    Only surface a card when REAL build metadata is present — a generic format/arch echo
    #    does NOT mean the binary is Go/Rust, so we must not label a C binary as such.
    go, gev = try_rea(["inspect-go-binary", path])
    if "__error__" not in go:
        report["arch"] = report["arch"] or go.get("architecture")
        report["format"] = report["format"] or go.get("format")
        bi = go.get("build_info") or {}
        if bi.get("go_version"):   # real Go build info
            report["sections"].append({"title": "Go build provenance", "ev": gev, "data": go})
    rust, rev = try_rea(["inspect-rust-binary", path])
    if "__error__" not in rust:
        report["arch"] = report["arch"] or rust.get("architecture")
        report["format"] = report["format"] or rust.get("format")
        crates = (rust.get("dependencies") or rust.get("crates") or [])
        if crates:   # real cargo-auditable data
            report["sections"].append({"title": "Rust dependency provenance", "ev": rev, "data": rust})

    report["deep"] = deep
    report["errors"] = []
    if not deep:
        return report

    d = deep_pass(path, provider)
    report["errors"] = d["errors"]
    ov = d["overview"]
    report["overview"], report["overview_ev"] = ov, d["overview_ev"]
    if isinstance(ov, dict):
        report["arch"] = ov.get("architecture") or report["arch"]

    report["strings_ev"] = d["strings_ev"]
    vals = d["strings"]
    report["strings_total"] = len(vals) if d["strings_ok"] else "—"
    report["urls"] = find_endpoints(vals)
    report["crypto"] = snippets(vals, CRYPTO)
    report["secret_values"] = secret_values(vals)
    report["secret_names"] = snippets(vals, SECRET_NAMES)

    report["procs_ev"] = d["overview_ev"]
    report["procs_total"] = ov.get("procedure_count", "—") if isinstance(ov, dict) and ov else "—"
    return report


def deep_pass(path, provider, need_proc_names=False, need_overview=True):
    """Run the native-provider steps. Each REA CLI call re-runs Ghidra's analysis, so we run
    only the steps the report actually needs: overview (counts) + strings for a single report,
    strings + procedure names for a diff."""
    out = {"errors": [], "overview": {}, "overview_ev": "", "strings": [], "strings_ev": "",
           "strings_ok": False, "procs": [], "procs_ev": "", "procs_ok": False}
    common = ["--provider", provider]
    if need_overview:
        print("[*] Deep pass 1: overview (slow step on large binaries)…", file=sys.stderr)
        ov, ev = try_rea(["analyze", path, *common])
        if "__error__" in ov:
            out["errors"].append(ov["__error__"])
            return out          # later steps would fail the same way; don't burn hours retrying
        out["overview"], out["overview_ev"] = ov, ev

    print("[*] Deep pass: strings…", file=sys.stderr)
    strings, ev = try_rea(["search", path, "--mode", "regex", "--pattern", ".", *common])
    if isinstance(strings, list):
        out["strings"], out["strings_ev"], out["strings_ok"] = [x.get("value", "") for x in strings], ev, True
    else:
        out["errors"].append(strings.get("__error__", "strings step returned no list"))
        return out

    if need_proc_names:
        print("[*] Deep pass: procedure names…", file=sys.stderr)
        procs, ev = try_rea(["search", path, "--kind", "procedures", "--mode", "regex", "--pattern", ".", *common])
        if isinstance(procs, list):
            out["procs"], out["procs_ev"], out["procs_ok"] = [x.get("value", "") for x in procs], ev, True
        else:
            out["errors"].append(procs.get("__error__", "procedures step returned no list"))
    return out


def collect_sets(path, provider):
    """Gather string + procedure-name sets for diffing (deep pass)."""
    s = {"path": path, "arch": None, "format": None, "strings": set(), "procs": set(),
         "go_version": None, "segments": None}
    go, _ = try_rea(["inspect-go-binary", path])
    if "__error__" not in go:
        s["arch"], s["format"] = go.get("architecture"), go.get("format")
        s["go_version"] = (go.get("build_info") or {}).get("go_version")
    d = deep_pass(path, provider, need_proc_names=True, need_overview=False)
    s["errors"] = d["errors"]
    ov = d["overview"]
    if isinstance(ov, dict):
        s["arch"] = ov.get("architecture") or s["arch"]
        s["segments"] = ov.get("segment_count")
    s["strings"] = set(d["strings"])
    s["procs"] = {v for v in d["procs"] if not v.startswith("<EXTERNAL>")}
    return s


def diff(old_path, new_path, provider):
    a, b = collect_sets(old_path, provider), collect_sets(new_path, provider)
    added_s, removed_s = sorted(b["strings"] - a["strings"]), sorted(a["strings"] - b["strings"])
    return {
        "old": a, "new": b,
        "generated": datetime.now(timezone.utc).isoformat(),
        "added_strings": added_s, "removed_strings": removed_s,
        "added_urls": find_endpoints(added_s),
        "removed_urls": find_endpoints(removed_s),
        "added_crypto": snippets(added_s, CRYPTO),
        "removed_crypto": snippets(removed_s, CRYPTO),
        "added_procs": sorted(b["procs"] - a["procs"]),
        "removed_procs": sorted(a["procs"] - b["procs"]),
    }


def render_diff(d):
    a, b = d["old"], d["new"]

    def delta(x, y):
        if x is None or y is None:
            return ""
        try:
            n = int(y) - int(x)
            return f" <span class={'up' if n>0 else 'down' if n<0 else 'muted'}>({'+' if n>0 else ''}{n})</span>"
        except Exception:
            return ""

    def listcard(title, items, cls="", empty="No change."):
        if not items:
            return f"<section class=card><h2>{h(title)}</h2><p class=muted>{h(empty)}</p></section>"
        lis = "".join(f"<li class='{cls}'>{h(x)}</li>" for x in items)
        return f"<section class=card><h2>{h(title)} <span class=count>{len(items)}</span></h2><ul class=mono>{lis}</ul></section>"

    kpis = f"""<div class=kpis>
<div class=kpi><b>{len(a['procs'])} → {len(b['procs'])}</b><span>procedures{delta(len(a['procs']),len(b['procs']))}</span></div>
<div class=kpi><b>{len(a['strings'])} → {len(b['strings'])}</b><span>strings{delta(len(a['strings']),len(b['strings']))}</span></div>
</div>"""
    return f"""<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>BinDossier Diff</title><style>
:root{{--bg:#0f1115;--card:#181b22;--line:#282d38;--ink:#e9ecf2;--mut:#99a0b2;--acc:#7bdcc0;--add:#7bdc9a;--del:#e8836b}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}}
.wrap{{max-width:900px;margin:0 auto;padding:32px 20px 60px}}
h1{{font-size:24px;margin:0 0 2px}}.sub{{color:var(--mut);font-size:13px;margin:0 0 20px;word-break:break-all}}
.kpis{{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:22px}}
.kpi{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;min-width:150px}}
.kpi b{{display:block;font-size:19px;color:var(--acc)}}.kpi span{{color:var(--mut);font-size:12px}}
.up{{color:var(--add)}}.down{{color:var(--del)}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:14px}}
.card h2{{margin:0 0 10px;font-size:17px}}.count{{color:var(--mut);font-size:13px;font-weight:400}}
ul{{margin:6px 0 0;padding-left:22px}}.mono li{{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;word-break:break-all}}
li.add::marker{{content:"+ "}}li.add{{color:var(--add)}}li.del::marker{{content:"− "}}li.del{{color:var(--del)}}
.muted{{color:var(--mut)}}.logo{{color:var(--acc);font-weight:700}}
.foot{{color:var(--mut);font-size:12px;margin-top:26px;border-top:1px solid var(--line);padding-top:14px}}
</style></head><body><div class=wrap>
<h1><span class=logo>◉ BinDossier — Diff</span></h1>
<p class=sub>old: {h(a['path'])}<br>new: {h(b['path'])}<br>generated {h(d['generated'])}</p>
{kpis}
{listcard("New procedures", d['added_procs'], 'add', 'No new procedures detected.')}
{listcard("Removed procedures", d['removed_procs'], 'del', 'No procedures removed.')}
{listcard("Added strings", d['added_strings'], 'add')}
{listcard("Removed strings", d['removed_strings'], 'del')}
{listcard("New network endpoints", d['added_urls'], 'add', 'No new URLs.')}
{listcard("New crypto indicators", d['added_crypto'], 'add', 'No new crypto tokens.')}
<p class=foot>BinDossier diff on REA evidence. String/procedure deltas are static observations, not proof of behavioural change. Analyse only software you are authorised to inspect.</p>
</div></body></html>"""


def h(s):
    return html.escape(str(s))


def render(r):
    ov = r.get("overview", {}) or {}
    seg = ov.get("segment_count", "—")
    arch = r.get("arch") or "—"
    fmt = r.get("format") or "—"
    rows = []
    for sec in r["sections"]:
        d = sec["data"]
        body = ""
        bi = d.get("build_info") or d
        if isinstance(bi, dict):
            picks = {k: bi[k] for k in ("go_version", "format", "architecture", "bits") if k in bi}
            if picks:
                body += "<ul>" + "".join(f"<li><b>{h(k)}</b>: {h(v)}</li>" for k, v in picks.items()) + "</ul>"
            mods = bi.get("module") if isinstance(bi.get("module"), dict) else {}
            main = mods.get("main") or {}
            if main.get("path"):
                body += f"<p>Main module: <code>{h(main['path'])}</code> {h(main.get('version') or '')}</p>"
            # REA reports Go deps under "dependencies"; Rust reports may use "dependencies"/"crates".
            deps = mods.get("dependencies") or d.get("dependencies") or d.get("crates") or []
            if isinstance(deps, list) and deps:
                shown = deps[:40]
                more = f" (showing {len(shown)})" if len(deps) > len(shown) else ""
                body += (f"<p><b>{len(deps)} libraries compiled in</b>{more}:</p><ul class=mono>" + "".join(
                    f"<li>{h(m.get('path') or m.get('name',''))} {h(m.get('version',''))}"
                    + (f" → {h((m.get('replacement') or {}).get('path',''))}" if m.get('replacement') else "")
                    + "</li>" for m in shown) + "</ul>")
        rows.append(f"<section class=card><h2>{h(sec['title'])}</h2>{body}"
                    f"<p class=ev>evidence: {h(sec['ev'])[:40]}</p></section>")

    def listcard(title, items, ev, empty):
        if not items:
            return f"<section class=card><h2>{h(title)}</h2><p class=muted>{h(empty)}</p></section>"
        lis = "".join(f"<li>{h(x)}</li>" for x in items)
        return f"<section class=card><h2>{h(title)} <span class=count>{len(items)}</span></h2><ul class=mono>{lis}</ul><p class=ev>evidence: {h(ev)[:40]}</p></section>"

    errs = r.get("errors") or []
    err_card = ("<section class=card style='border-color:#6b3a2e'><h2 style='color:#e8836b'>Deep analysis incomplete</h2>"
                "<ul class=mono>" + "".join(f"<li>{h(e)}</li>" for e in errs) + "</ul>"
                "<p class=muted>Counts marked “—” were not measured. Zero findings below this card are not evidence of absence.</p></section>"
                ) if errs else ""
    if r.get("deep"):
        tail = err_card + (listcard("Network endpoints (hosts)", r.get("urls", []), r.get("strings_ev", ""),
                         "No http(s) URLs in static strings.")
                + listcard("Hard-coded credentials (strict patterns)", r.get("secret_values", []), r.get("strings_ev", ""),
                           "None matched: AWS, OpenAI/Anthropic, GitHub, Slack, Google keys, private-key blocks, JWTs. "
                           "(Pattern check — absence is not proof.)")
                + listcard("Crypto / security indicators (snippets)", r.get("crypto", []), r.get("strings_ev", ""),
                           "No common crypto tokens found.")
                + listcard("Credential-related names (labels, not values)", r.get("secret_names", []), r.get("strings_ev", ""),
                           "None found."))
    else:
        tail = ("<section class=card><h2>Deep analysis skipped</h2><p class=muted>Run without "
                "<code>--no-deep</code> for strings, procedures, URLs and crypto indicators "
                "(requires a native provider).</p></section>")
    return f"""<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>BinDossier — {h(r['target'])}</title><style>
:root{{--bg:#0f1115;--card:#181b22;--line:#282d38;--ink:#e9ecf2;--mut:#99a0b2;--acc:#7bdcc0;--warn:#e8b36b}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}}
.wrap{{max-width:900px;margin:0 auto;padding:32px 20px 60px}}
h1{{font-size:24px;margin:0 0 2px}}.sub{{color:var(--mut);font-size:13px;margin:0 0 24px}}
.kpis{{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:22px}}
.kpi{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;min-width:130px}}
.kpi b{{display:block;font-size:22px;color:var(--acc)}}.kpi span{{color:var(--mut);font-size:12px}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:14px}}
.card h2{{margin:0 0 10px;font-size:17px}}.count{{color:var(--mut);font-size:13px;font-weight:400}}
ul{{margin:6px 0 0;padding-left:20px}}.mono li{{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;word-break:break-all}}
.muted{{color:var(--mut)}}.ev{{color:var(--mut);font-size:11px;margin:10px 0 0;font-family:ui-monospace,monospace}}
.warn{{color:var(--warn)}}.foot{{color:var(--mut);font-size:12px;margin-top:26px;border-top:1px solid var(--line);padding-top:14px}}
.logo{{color:var(--acc);font-weight:700;letter-spacing:.02em}}
</style></head><body><div class=wrap>
<h1><span class=logo>◉ BinDossier</span></h1>
<p class=sub>{h(r['target'])} · generated {h(r['generated'])} · engine: REA + Ghidra</p>
<div class=kpis>
<div class=kpi><b>{h(fmt)}</b><span>format</span></div>
<div class=kpi><b>{h(arch)}</b><span>architecture</span></div>
<div class=kpi><b>{h(seg)}</b><span>segments</span></div>
<div class=kpi><b>{h(r.get('procs_total','—'))}</b><span>procedures</span></div>
<div class=kpi><b>{h(r.get('strings_total','—'))}</b><span>strings</span></div>
</div>
{''.join(rows)}
{tail}
<p class=foot>Generated by BinDossier on REA evidence. Static strings are observed bytes, not proof of runtime behaviour.
Analyse only software you own or are authorised to inspect.</p>
</div></body></html>"""


def main():
    ap = argparse.ArgumentParser(description="BinDossier — binary transparency reports on REA.")
    ap.add_argument("path", nargs="?", help="binary to analyse (single-report mode)")
    ap.add_argument("--diff", nargs=2, metavar=("OLD", "NEW"),
                    help="compare two binaries and report what changed")
    ap.add_argument("--provider", default="ghidra")
    ap.add_argument("--out", default="bindossier-report.html")
    ap.add_argument("--no-deep", action="store_true",
                    help="skip the native-provider pass (fast; provenance only, good for huge binaries)")
    ap.add_argument("--timeout", type=int, default=TIMEOUT,
                    help=f"seconds allowed per REA step (default {TIMEOUT}); large binaries under Docker emulation need hours")
    a = ap.parse_args()
    globals()["TIMEOUT"] = a.timeout
    if not shutil.which("rea"):
        sys.exit("error: `rea` not on PATH. Install with: npm i -g rea-agents")

    if a.diff:
        old, new = a.diff
        for p in (old, new):
            if not os.path.isfile(p):
                sys.exit(f"error: no such file: {p!r} (tip: use an absolute path; `which NAME` prints 'not found' when a tool is missing)")
        print(f"[*] Diffing {old}  ⇄  {new} …", file=sys.stderr)
        d = diff(old, new, a.provider)
        out = a.out if a.out != "bindossier-report.html" else "bindossier-diff.html"
        with open(out, "w") as f:
            f.write(render_diff(d))
        print(f"[+] Wrote {out}", file=sys.stderr)
        print(json.dumps({"added_procs": d["added_procs"], "removed_procs": d["removed_procs"],
                          "added_strings": d["added_strings"][:20], "removed_strings": d["removed_strings"][:20]},
                         default=str)[:600])
        return

    if not a.path:
        ap.error("provide a binary path, or use --diff OLD NEW")
    if not os.path.isfile(a.path):
        sys.exit(f"error: no such file: {a.path!r} (tip: use an absolute path; `which NAME` prints 'not found' when a tool is missing)")
    print(f"[*] Analysing {a.path} …", file=sys.stderr)
    r = collect(a.path, a.provider, deep=not a.no_deep)
    with open(a.out, "w") as f:
        f.write(render(r))
    print(f"[+] Wrote {a.out}", file=sys.stderr)
    print(json.dumps({k: v for k, v in r.items() if k != "sections"}, default=str)[:400])


if __name__ == "__main__":
    main()

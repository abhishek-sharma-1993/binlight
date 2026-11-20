/**
 * Cleaning hostnames found in raw bytes. Go packs string literals end to end,
 * so a hostname read from the bytes can swallow the next literal:
 * "ollama.compulling", "opencode.ainemotron-3-nano". The last label is cut back
 * to a known top-level domain; the raw text stays in the evidence.
 */

// Generic TLDs seen in software, plus every ISO 3166 country code in use.
const GENERIC = `com net org edu gov mil int info biz name pro aero coop museum mobi
  app dev page blog cloud online site tech store xyz io ai sh run zone link live news
  email digital network systems software tools team space codes host website wiki
  google amazon microsoft apple goog aws azure`;
const COUNTRY = `ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj
  bm bn bo br bs bt bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz
  de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl
  gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm
  jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me
  mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr
  nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se
  sg sh si sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr
  tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw`;
// Reserved for local, test and documentation use (RFC 2606, RFC 6761).
const RESERVED = "localhost local internal invalid test example onion";

export const TLDS = new Set(`${GENERIC} ${COUNTRY} ${RESERVED}`.split(/\s+/).filter(Boolean));
const BY_LENGTH = [...TLDS].sort((a, b) => b.length - a.length);

export type HostKind =
  "public" | "loopback" | "local-network" | "identifier" | "placeholder" | "ip" | "unrecognised";

export interface CleanHost {
  host: string;
  kind: HostKind;
  /** Text cut from the end of the last label ("pulling" in ollama.compulling). */
  glued?: string;
}

/**
 * Hosts whose URLs are names, not places: XML and schema namespaces. Code uses
 * them to label data; they are not normally fetched.
 */
const IDENTIFIERS = new Set([
  "www.w3.org",
  "schemas.microsoft.com",
  "schemas.openxmlformats.org",
  "ns.adobe.com",
  "www.opengis.net",
  "purl.org",
  "json-schema.org",
  "xmlns.com",
]);

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Cuts a hostname read from raw bytes back to a plausible host, and classifies it. */
export function cleanHost(raw: string): CleanHost {
  const host = raw.toLowerCase();
  const ip = IPV4.exec(host);
  if (ip) {
    if (ip.slice(1).some((p) => Number(p) > 255)) return { host, kind: "unrecognised" };
    return { host, kind: host.startsWith("127.") ? "loopback" : "ip" };
  }
  const labels = host.split(".");
  const last = labels[labels.length - 1] ?? "";
  let tld = TLDS.has(last) ? last : undefined;
  let glued: string | undefined;
  if (!tld) {
    tld = BY_LENGTH.find((t) => last.startsWith(t) && last.length > t.length);
    if (tld) glued = last.slice(tld.length);
  }
  if (!tld) return { host, kind: "unrecognised" };
  const clean = [...labels.slice(0, -1), tld].join(".");
  return { host: clean, kind: kindOf(clean, tld), ...(glued && { glued }) };
}

function kindOf(host: string, tld: string): HostKind {
  if (IDENTIFIERS.has(host)) return "identifier";
  if (tld === "localhost" || host === "localhost") return "loopback";
  if (tld === "local" || tld === "internal") return "local-network";
  if (tld === "invalid" || tld === "test" || tld === "example") return "placeholder";
  if (/^(?:.*\.)?example\.(?:com|net|org)$/.test(host)) return "placeholder";
  return "public";
}

/**
 * Cleans every hostname read from one binary. A host cut short where its text
 * ends ("issues.k8s", "htmlpreview.github") is the longer host that starts
 * with it, when the binary has one; only otherwise is the last label cut back.
 */
export function cleanHosts(raws: Iterable<string>): Map<string, CleanHost> {
  const all = [...new Set([...raws].map((r) => r.toLowerCase()))];
  const out = new Map<string, CleanHost>();
  for (const raw of all) {
    const longer = all
      .filter((o) => o.startsWith(`${raw}.`))
      .sort((a, b) => a.length - b.length)[0];
    out.set(raw, longer ? cleanHost(longer) : cleanHost(raw));
  }
  return out;
}

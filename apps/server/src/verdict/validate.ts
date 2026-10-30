import type { Finding, VerdictBody } from "@binlight/shared";

export type Validation = { ok: true } | { ok: false; reasons: string[] };

const MAX_ANSWER = 600;
const MAX_CLAIMS = 20;

/** Numbers as written ("88,901" → "88901", "v1.37.1" → "1.37.1"). */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0].replace(/,(?=\d{3}\b)/g, ""));
}

/**
 * The text a finding vouches for: its statement, caveats and top-level scalar
 * data. Not nested data: a dependency list is full of incidental digits
 * ("v1.9.1", "m14") that would make almost any number look supported.
 */
function findingText(f: Finding): string {
  const scalars = Object.values(f.data ?? {}).filter(
    (v) => typeof v === "number" || typeof v === "string",
  );
  return [f.statement, ...f.caveats, ...scalars.map(String)].join(" ");
}

/** Wording Binlight never lets a verdict use (lessons-learned, working agreements). */
const BANNED: { pattern: RegExp; why: string; allowNegated?: boolean }[] = [
  {
    pattern: /\bonly\b[^.]{0,40}\b(servers?|hosts?|hostnames?|endpoints?|domains?)\b/i,
    why: 'says "only N servers": hard-coded URLs undercount real destinations',
  },
  {
    pattern:
      /\b(talks to|connects to|communicates with|contacts|phones home|sends data to|calls home|reaches out to)\b/i,
    why: "claims network behaviour; findings only show what is embedded",
    // "This is not the list of servers it talks to" is an honest caveat.
    allowNegated: true,
  },
  {
    pattern: /\b(is|are|looks|seems) (safe|malicious|secure|harmless|clean|trustworthy)\b/i,
    why: "gives a safety judgement the findings cannot support",
  },
];

/**
 * Checks a verdict against the job's findings. Every claim must cite known
 * finding ids, every number must appear in what it cites (the answer: in any
 * finding), and banned wording is refused. Applied to anything Claude writes.
 */
export function validateVerdict(body: VerdictBody, findings: Finding[]): Validation {
  const reasons: string[] = [];
  const byId = new Map(findings.map((f) => [f.id, f]));
  const allNumbers = new Set(findings.flatMap((f) => numbersIn(findingText(f))));

  if (!body.answer.trim()) reasons.push("The answer is empty.");
  if (body.answer.length > MAX_ANSWER)
    reasons.push(`The answer is longer than ${MAX_ANSWER} characters.`);
  for (const n of numbersIn(body.answer)) {
    if (!allNumbers.has(n)) reasons.push(`The answer states "${n}", which no finding contains.`);
  }
  if (body.claims.length === 0) reasons.push("There are no claims.");
  if (body.claims.length > MAX_CLAIMS) reasons.push(`There are more than ${MAX_CLAIMS} claims.`);

  body.claims.forEach((claim, i) => {
    const label = `Claim ${i + 1}`;
    if (claim.findings.length === 0) reasons.push(`${label} cites no finding.`);
    const cited = claim.findings.map((id) => byId.get(id));
    claim.findings.forEach((id, k) => {
      if (!cited[k]) reasons.push(`${label} cites "${id}", which is not a finding of this job.`);
    });
    const citedNumbers = new Set(cited.flatMap((f) => (f ? numbersIn(findingText(f)) : [])));
    for (const n of numbersIn(claim.text)) {
      if (!citedNumbers.has(n))
        reasons.push(`${label} states "${n}", which its findings do not contain.`);
    }
  });

  for (const text of [body.answer, ...body.claims.map((c) => c.text)]) {
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      const negated = /\b(not|no|never|cannot)\b|n't\b/i.test(sentence);
      for (const { pattern, why, allowNegated } of BANNED) {
        if (pattern.test(sentence) && !(allowNegated && negated)) {
          reasons.push(`"${sentence.slice(0, 80)}" ${why}.`);
        }
      }
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons: [...new Set(reasons)] };
}

import type { Finding, Job, Locator } from "@binlight/shared";

/** The part of one REA evidence record a report needs to back its findings. */
export interface EvidenceExcerpt {
  evidenceId: string;
  step: string;
  operation?: string;
  subject?: { name?: string; sha256?: string; format?: string; architecture?: string | null };
  provider?: { id?: string; name?: string; version?: string | null };
  confidence?: string;
  limitations: string[];
  /** Cited places in the record: an address with its snippet, or a field with its value. */
  cited: { address?: string; snippet?: string; field?: string; value?: string }[];
  /** e.g. "237,578 items in normalized_result". */
  size?: string;
  /** Set when the record could not be read back (the excerpt then says so). */
  missing?: string;
}

const MAX_VALUE = 2_000;

/** Every evidence id the findings cite, with the step that produced it and the cited locators. */
export function citedEvidence(
  findings: Finding[],
): Map<string, { step: string; locators: Locator[] }> {
  const cited = new Map<string, { step: string; locators: Locator[] }>();
  for (const f of findings) {
    for (const e of f.evidence) {
      const entry = cited.get(e.evidenceId) ?? { step: e.step, locators: [] };
      if (e.locator) entry.locators.push(e.locator);
      cited.set(e.evidenceId, entry);
    }
  }
  return cited;
}

function at(record: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (v, key) => (v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined),
      record,
    );
}

/** A field's value for the report: lists become compact lines, everything is bounded. */
function render(value: unknown): string {
  if (Array.isArray(value)) {
    const lines = value.map((v) =>
      v && typeof v === "object" && "path" in v
        ? `${String((v as { path: unknown }).path)} ${String((v as { version?: unknown }).version ?? "")}`.trim()
        : typeof v === "object"
          ? JSON.stringify(v)
          : String(v),
    );
    return bound(`${value.length} items\n${lines.join("\n")}`);
  }
  return bound(typeof value === "object" ? JSON.stringify(value, null, 1) : String(value));
}

function bound(text: string): string {
  return text.length > MAX_VALUE
    ? `${text.slice(0, MAX_VALUE)}\n… (cut at ${MAX_VALUE} characters)`
    : text;
}

/**
 * Excerpts of the cited evidence records. String values are never copied
 * whole (Go packs literals into multi-KB blobs, and they can hold secrets):
 * an address is shown with its finding's ±36-character snippet only.
 */
export async function buildExcerpts(
  job: Job,
  result: (step: string) => Promise<unknown>,
): Promise<EvidenceExcerpt[]> {
  const excerpts: EvidenceExcerpt[] = [];
  for (const [evidenceId, { step, locators }] of citedEvidence(job.findings ?? [])) {
    const record = (await result(step)) as Record<string, unknown> | undefined;
    if (!record || record["evidence_id"] !== evidenceId) {
      excerpts.push({
        evidenceId,
        step,
        limitations: [],
        cited: [],
        missing:
          "The evidence record could not be read back from the cache when the report was made.",
      });
      continue;
    }
    const subject = record["subject"] as Record<string, unknown> | undefined;
    const provider = record["provider"] as EvidenceExcerpt["provider"];
    const normalized = record["normalized_result"];
    const seen = new Set<string>();
    const cited: EvidenceExcerpt["cited"] = [];
    for (const l of locators) {
      const key = JSON.stringify(l);
      if (seen.has(key)) continue;
      seen.add(key);
      if (l.address !== undefined) {
        cited.push({ address: l.address, ...(l.snippet !== undefined && { snippet: l.snippet }) });
      } else if (l.field) {
        cited.push({
          field: l.field,
          value:
            l.field === "normalized_result"
              ? "(the whole result; see size)"
              : render(at(record, l.field)),
        });
      }
    }
    excerpts.push({
      evidenceId,
      step,
      ...(typeof record["operation"] === "string" && { operation: record["operation"] }),
      ...(subject && {
        subject: {
          ...(typeof subject["name"] === "string" && { name: subject["name"] }),
          ...(typeof (subject["digest"] as Record<string, unknown> | undefined)?.["sha256"] ===
            "string" && {
            sha256: (subject["digest"] as { sha256: string }).sha256,
          }),
          ...(typeof subject["format"] === "string" && { format: subject["format"] }),
          architecture: (subject["architecture"] as string | null | undefined) ?? null,
        },
      }),
      ...(provider && { provider }),
      ...(typeof record["confidence"] === "string" && { confidence: record["confidence"] }),
      limitations: Array.isArray(record["limitations"]) ? (record["limitations"] as string[]) : [],
      cited,
      ...(Array.isArray(normalized) && {
        size: `${normalized.length.toLocaleString("en-US")} items in normalized_result`,
      }),
    });
  }
  return excerpts;
}

import { createHash } from "node:crypto";

export const SNIPPET_WIDTH = 36;

/** About ±36 characters around [start, end), with … where it was cut. Newlines flattened. */
export function snippet(value: string, start: number, end: number, width = SNIPPET_WIDTH): string {
  const a = Math.max(0, start - width);
  const b = Math.min(value.length, end + width);
  return (
    (a > 0 ? "…" : "") + value.slice(a, b).replace(/\s+/g, " ") + (b < value.length ? "…" : "")
  );
}

/** Never show a whole credential: the first 12 characters, then "…". */
export function truncateSecret(value: string): string {
  return value.length <= 12 ? `${value.slice(0, 4)}…` : `${value.slice(0, 12)}…`;
}

/** Short stable id fragment for a value. */
export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

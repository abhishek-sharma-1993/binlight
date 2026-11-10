/**
 * Go's major releases, bundled so "is it current?" works offline. Go fixes
 * security issues in its two newest major releases; an older one is
 * unsupported once two newer majors exist. Releases come every February and
 * August. Update this table with each Go release.
 */
export const GO_RELEASES = {
  asOf: "2026-11-10",
  /** Major version → month it was released. */
  releases: [
    { major: "1.27", released: "2026-08" },
    { major: "1.26", released: "2026-02" },
    { major: "1.25", released: "2025-08" },
    { major: "1.24", released: "2025-02" },
    { major: "1.23", released: "2024-08" },
    { major: "1.22", released: "2024-02" },
    { major: "1.21", released: "2023-08" },
    { major: "1.20", released: "2023-02" },
  ],
} as const;

export type GoSupport =
  | { status: "supported"; major: string; supported: [string, string] }
  | { status: "unsupported"; major: string; endedBy: string; endedOn: string }
  | { status: "newer-than-table"; major: string }
  | { status: "unknown"; reason: string };

/** Where a Go version stands against the table (major version only). */
export function goSupport(goVersion: string, table = GO_RELEASES): GoSupport {
  const m = /^go(\d+)\.(\d+)/.exec(goVersion.trim());
  if (!m) return { status: "unknown", reason: `"${goVersion}" is not a release version.` };
  const major = `${m[1]}.${m[2]}`;
  const index = table.releases.findIndex((r) => r.major === major);
  const newest = table.releases[0];
  const second = table.releases[1];
  if (!newest || !second) return { status: "unknown", reason: "The release table is empty." };
  if (index === -1) {
    const [a, b] = major.split(".").map(Number) as [number, number];
    const [na, nb] = newest.major.split(".").map(Number) as [number, number];
    return a > na || (a === na && b > nb)
      ? { status: "newer-than-table", major }
      : { status: "unknown", reason: `Go ${major} is older than Binlight's release table.` };
  }
  if (index <= 1) return { status: "supported", major, supported: [newest.major, second.major] };
  // Unsupported from the release of the second newer major.
  const ender = table.releases[index - 2] as { major: string; released: string };
  return { status: "unsupported", major, endedBy: ender.major, endedOn: ender.released };
}

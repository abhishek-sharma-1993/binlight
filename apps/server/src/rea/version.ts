import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * The REA version Binlight is built and tested against. `rea-agents` is an
 * exact dependency of this package; a test keeps the two in step.
 * Upgrading REA means bumping both and re-running the contract tests.
 */
export const PINNED_REA_VERSION = "6.7.0";

interface ReaPackageJson {
  version: string;
  bin: Record<string, string>;
}

/** The `rea-agents` package installed with Binlight (not whatever `rea` is on PATH). */
export function installedRea(): { version: string; entry: string } {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("rea-agents/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as ReaPackageJson;
  const bin = pkg.bin["rea"];
  if (!bin) throw new Error(`rea-agents at ${pkgPath} declares no "rea" bin`);
  return { version: pkg.version, entry: join(dirname(pkgPath), bin) };
}

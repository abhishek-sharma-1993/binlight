import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DetectedTarget, PreflightIssue, PreflightReport } from "@binlight/shared";
import { reaEnvOptionsFromProcess, type ReaEnvOptions } from "../rea/env.js";
import { detectTarget, sha256Of } from "./detect.js";
import { gatherHealth, type DeepHealth } from "./health.js";
import { decideRoutes } from "./routes.js";
import { preferredSlice, thinUniversal } from "./thin.js";

export interface PreflightOptions {
  /** Where thinned slices are cached. */
  cacheDir?: string;
  env?: ReaEnvOptions;
  /** Injected in tests; otherwise gathered from rea doctor and Docker. */
  health?: DeepHealth;
  hostArch?: string;
}

export const defaultCacheDir = (): string => join(homedir(), ".binlight", "cache");

const NATIVE = new Set(["mach-o", "mach-o-universal", "elf", "pe"]);

/**
 * Everything Binlight checks before analysis: what the target is, the file to
 * give REA (thinned if universal), and which deep-analysis route works here.
 * Never throws for a bad target; every problem becomes an issue with its reason.
 */
export async function preflight(
  inputPath: string,
  options: PreflightOptions = {},
): Promise<PreflightReport> {
  const path = resolve(inputPath);
  const issues: PreflightIssue[] = [];

  let target: DetectedTarget;
  try {
    target = await detectTarget(path);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      target: { path, format: "unknown", architectures: [] },
      routes: [],
      issues: [
        {
          severity: "blocker",
          code: e.code === "ENOENT" ? "target_missing" : "target_unreadable",
          message: `Cannot read ${path}: ${e.message}`,
          remediation: "Check the path exists and Binlight's server can read it.",
        },
      ],
      canAnalyse: false,
    };
  }

  let native: DetectedTarget | undefined = target;
  if (target.format === "app-bundle") {
    native = target.executable;
    if (!native) {
      issues.push({
        severity: "blocker",
        code: "bundle_without_executable",
        message: `${path} has no main executable in Contents/MacOS.`,
      });
    }
    if (target.electron) {
      issues.push({
        severity: "note",
        code: "electron_app",
        message:
          "This is an Electron app. Its main executable can be analysed; its JavaScript needs the Electron recipe (later phase).",
      });
    }
  }

  if (native && !NATIVE.has(native.format)) {
    const what =
      native.format === "unknown" ? "not a recognised executable" : `a ${native.format} file`;
    issues.push({
      severity: "blocker",
      code: "unsupported_format",
      message: `${native.path} is ${what}. Phase 0 analyses native executables (Mach-O, ELF, PE).`,
    });
    native = undefined;
  }

  // Provider health doesn't depend on the target: start it now, alongside thinning.
  const healthPromise = native
    ? options.health
      ? Promise.resolve(options.health)
      : gatherHealth(options.env ?? reaEnvOptionsFromProcess())
    : undefined;

  let analysisPath: string | undefined;
  let analysisArchitecture: string | undefined;
  let analysisSha256: string | undefined;
  if (native?.format === "mach-o-universal") {
    const slice = preferredSlice(native.slices ?? [], options.hostArch);
    if (!slice || !native.sha256) {
      issues.push({
        severity: "blocker",
        code: "universal_unreadable",
        message: `${native.path} is a universal binary, but its slices could not be read.`,
      });
    } else {
      try {
        analysisPath = await thinUniversal(
          native.path,
          native.sha256,
          slice,
          options.cacheDir ?? defaultCacheDir(),
        );
        analysisArchitecture = slice.architecture;
        analysisSha256 = await sha256Of(analysisPath);
        issues.push({
          severity: "note",
          code: "thinned_universal",
          message: `Universal binary (${native.architectures.join(", ")}); analysing the ${slice.architecture} slice.`,
        });
      } catch (err) {
        issues.push({
          severity: "blocker",
          code: "thinning_failed",
          message: `Could not extract the ${slice.architecture} slice: ${String(err)}`,
        });
      }
    }
  } else if (native) {
    analysisPath = native.path;
    analysisArchitecture = native.architectures[0];
    analysisSha256 = native.sha256;
  }

  // Provider health only matters once there is something to analyse.
  const health = analysisPath ? await healthPromise : undefined;
  const routes = health ? decideRoutes(health, native?.format ?? "unknown") : [];
  const deep = routes.find((r) => r.available);
  if (health && !deep) {
    const fixes = routes.filter((r) => r.remediation).map((r) => `${r.route}: ${r.remediation}`);
    issues.push({
      severity: "limits",
      code: "no_deep_route",
      message:
        "No deep-analysis provider works on this machine, so overview, strings and procedures " +
        "cannot run. Checks that need no disassembler (such as Go build info) still can.",
      ...(fixes.length > 0 && { remediation: fixes.join(" ") }),
    });
  }

  return {
    target,
    ...(analysisPath !== undefined && { analysisPath }),
    ...(analysisArchitecture !== undefined && { analysisArchitecture }),
    ...(analysisSha256 !== undefined && { analysisSha256 }),
    ...(deep && { deep }),
    routes,
    issues,
    canAnalyse: analysisPath !== undefined && !issues.some((i) => i.severity === "blocker"),
  };
}

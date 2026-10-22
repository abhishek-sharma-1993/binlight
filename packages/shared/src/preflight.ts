/** What the server finds out about a target before any analysis starts. */

export type TargetFormat =
  "mach-o" | "mach-o-universal" | "elf" | "pe" | "app-bundle" | "apk" | "zip" | "asar" | "unknown";

export interface MachOSlice {
  architecture: string;
  offset: number;
  size: number;
}

export interface DetectedTarget {
  /** Path the user gave. */
  path: string;
  format: TargetFormat;
  /** CPU architectures in the file; several for a universal binary. */
  architectures: string[];
  /** For an .app bundle: the main executable inside it, detected in turn. */
  executable?: DetectedTarget;
  /** Universal Mach-O slices. */
  slices?: MachOSlice[];
  sha256?: string;
  bytes?: number;
  /** An Electron app (bundle with Electron Framework, or an .asar). */
  electron?: boolean;
}

/** Ways Binlight can run deep (disassembler/decompiler) analysis. */
export type DeepRoute = "native-ghidra" | "hopper" | "docker-ghidra";

export interface PreflightIssue {
  /** "blocker": nothing can run. "limits": deep analysis can't run. "note": informational. */
  severity: "blocker" | "limits" | "note";
  code: string;
  message: string;
  remediation?: string;
}

export interface RouteDecision {
  route: DeepRoute;
  /** The `provider_id` to pass to `open_binary`. */
  providerId: string;
  available: boolean;
  reason?: string;
  remediation?: string;
}

export interface PreflightReport {
  target: DetectedTarget;
  /** The file to hand to REA: the original, the bundle's executable, or a thinned slice. */
  analysisPath?: string;
  /** Architecture of `analysisPath`, when it is a native binary. */
  analysisArchitecture?: string;
  /** Chosen deep-analysis route, or undefined when none works. */
  deep?: RouteDecision;
  /** Every route considered, in preference order, with why it was or wasn't chosen. */
  routes: RouteDecision[];
  issues: PreflightIssue[];
  /** False when a blocker means nothing can be analysed. */
  canAnalyse: boolean;
}

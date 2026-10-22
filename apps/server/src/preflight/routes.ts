import type { RouteDecision, TargetFormat } from "@binlight/shared";
import { RUNNER_IMAGE, type DeepHealth } from "./health.js";

const HOPPER_FORMATS: TargetFormat[] = ["mach-o", "elf", "pe"];

/**
 * Every deep-analysis route in preference order, each marked available or not
 * with the real reason. Order: native Ghidra (fast, no emulation), licensed
 * Hopper, then Ghidra in the linux/amd64 Docker runner (slow under emulation).
 */
export function decideRoutes(health: DeepHealth, format: TargetFormat): RouteDecision[] {
  return [nativeGhidra(health), hopper(health, format), dockerGhidra(health)];
}

function nativeGhidra(health: DeepHealth): RouteDecision {
  const base = { route: "native-ghidra", providerId: "ghidra" } as const;
  const g = health.ghidra;
  if ("error" in g) return { ...base, available: false, reason: g.error };
  if (g.available) return { ...base, available: true };
  const failed = g.failed[0];
  return {
    ...base,
    available: false,
    reason: failed
      ? `Ghidra check "${failed.name}" failed: ${failed.detail ?? failed.code ?? "no detail"}`
      : "REA reports the Ghidra provider unavailable.",
    ...(failed?.remediation && { remediation: failed.remediation }),
  };
}

function hopper(health: DeepHealth, format: TargetFormat): RouteDecision {
  const base = { route: "hopper", providerId: "hopper" } as const;
  const h = health.hopper;
  if (!h.installed) return { ...base, available: false, reason: h.reason };
  if (h.demo) {
    return {
      ...base,
      available: false,
      reason: `Hopper ${h.version ?? ""} is the demo build; its demo dialog can block automated analysis.`,
      remediation: "Use a licensed Hopper, or the Docker Ghidra runner.",
    };
  }
  if (!HOPPER_FORMATS.includes(format)) {
    return { ...base, available: false, reason: `Hopper does not analyse ${format} targets.` };
  }
  return { ...base, available: true };
}

function dockerGhidra(health: DeepHealth): RouteDecision {
  const base = { route: "docker-ghidra", providerId: "ghidra" } as const;
  const d = health.docker;
  if (!d.daemon) {
    return {
      ...base,
      available: false,
      reason: d.reason,
      remediation: "Install or start Docker Desktop.",
    };
  }
  if (!d.image) {
    return {
      ...base,
      available: false,
      reason: `The analysis image ${RUNNER_IMAGE} is not built yet.`,
      remediation: "Build the Docker runner image (phase 0 task 5).",
    };
  }
  if (d.image.architecture !== "amd64") {
    return {
      ...base,
      available: false,
      reason: `${RUNNER_IMAGE} is ${d.image.architecture}; it must be amd64 (Ghidra ships no arm64 Linux decompiler).`,
      remediation: "Rebuild the runner image with --platform linux/amd64.",
    };
  }
  return { ...base, available: true };
}

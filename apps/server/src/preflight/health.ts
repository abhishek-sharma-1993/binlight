import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { buildReaEnv, type ReaEnvOptions } from "../rea/env.js";
import { installedRea, PINNED_REA_VERSION } from "../rea/version.js";

const run = promisify(execFile);

/** Image built by the Docker runner (task 5): REA + Ghidra for linux/amd64. */
export const RUNNER_IMAGE = `binlight-runner:rea-${PINNED_REA_VERSION}`;

export interface FailedCheck {
  name: string;
  code?: string | undefined;
  detail?: string | undefined;
  remediation?: string | undefined;
}

/** Everything route selection needs to know about this machine. */
export interface DeepHealth {
  ghidra: { available: boolean; failed: FailedCheck[] } | { error: string };
  hopper:
    | { installed: false; reason: string }
    | { installed: true; appPath: string; version: string | undefined; demo: boolean };
  docker:
    | { daemon: false; reason: string }
    | { daemon: true; image: { name: string; architecture: string } | undefined };
}

const nullish = z
  .string()
  .nullish()
  .transform((v) => v ?? undefined);

const doctorSchema = z.object({
  hopperPath: z.string().nullish(),
  scope_checks: z.array(
    z.object({ name: z.string(), ok: z.boolean(), detail: nullish, remediation: nullish }),
  ),
  providerInspections: z.array(
    z.object({
      id: z.string(),
      available: z.boolean(),
      checks: z.array(
        z.object({
          name: z.string(),
          ok: z.boolean(),
          code: nullish,
          detail: nullish,
          remediation: nullish,
        }),
      ),
    }),
  ),
});
export type DoctorReport = z.infer<typeof doctorSchema>;

/**
 * Runs the pinned `rea doctor` for the providers Binlight can use. It exits 1
 * whenever anything at all is unhealthy (IDA, client registrations...), so the
 * exit code is ignored and the per-provider checks are read instead.
 */
export async function runDoctor(env: ReaEnvOptions): Promise<DoctorReport> {
  const args = [installedRea().entry, "doctor", "--provider", "ghidra", "--provider", "hopper"];
  const { stdout, stderr } = await run(process.execPath, [...args, "--format", "json"], {
    env: buildReaEnv(env),
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  }).catch((err: { stdout?: string; stderr?: string; message: string }) => {
    if (err.stdout) return { stdout: err.stdout, stderr: err.stderr ?? "" };
    throw new Error(`rea doctor failed: ${err.stderr || err.message}`, { cause: err });
  });
  try {
    return doctorSchema.parse(JSON.parse(stdout));
  } catch (err) {
    throw new Error(`rea doctor returned output Binlight cannot read: ${String(err)} ${stderr}`, {
      cause: err,
    });
  }
}

export function ghidraHealth(doctor: DoctorReport): DeepHealth["ghidra"] {
  const ghidra = doctor.providerInspections.find((p) => p.id === "ghidra");
  if (!ghidra) return { error: "rea doctor did not report the Ghidra provider" };
  return {
    available: ghidra.available,
    failed: ghidra.checks
      .filter((c) => !c.ok)
      .map((c) => ({ name: c.name, code: c.code, detail: c.detail, remediation: c.remediation })),
  };
}

/** Hopper's version string ends in "-demo" for the unlicensed build (e.g. "6.6.0-demo"). */
export function isHopperDemoVersion(version: string | undefined): boolean {
  return version !== undefined && /-demo$/i.test(version.trim());
}

async function hopperHealth(doctor: DoctorReport): Promise<DeepHealth["hopper"]> {
  const check = doctor.scope_checks.find((c) => c.name === "hopper");
  if (!check?.ok || !doctor.hopperPath) {
    return { installed: false, reason: check?.detail ?? "Hopper was not found by rea doctor" };
  }
  const appEnd = doctor.hopperPath.indexOf(".app/");
  const appPath = appEnd >= 0 ? doctor.hopperPath.slice(0, appEnd + 4) : dirname(doctor.hopperPath);
  let version: string | undefined;
  try {
    const { stdout } = await run("plutil", [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      `${appPath}/Contents/Info.plist`,
    ]);
    version = stdout.trim();
  } catch {
    version = undefined;
  }
  return {
    installed: true,
    appPath,
    version,
    demo: isHopperDemoVersion(version),
  };
}

async function dockerHealth(): Promise<DeepHealth["docker"]> {
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 15_000 });
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message: string };
    const reason =
      e.code === "ENOENT"
        ? "Docker is not installed (no docker command)."
        : `Docker is not running: ${(e.stderr || e.message).trim()}`;
    return { daemon: false, reason };
  }
  try {
    const { stdout } = await run(
      "docker",
      ["image", "inspect", "--format", "{{.Architecture}}", RUNNER_IMAGE],
      { timeout: 15_000 },
    );
    return { daemon: true, image: { name: RUNNER_IMAGE, architecture: stdout.trim() } };
  } catch {
    return { daemon: true, image: undefined };
  }
}

export async function gatherHealth(env: ReaEnvOptions): Promise<DeepHealth> {
  const [doctor, docker] = await Promise.all([
    runDoctor(env).then(
      (d) => ({ ok: true as const, d }),
      (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
    ),
    dockerHealth(),
  ]);
  if (!doctor.ok) {
    return {
      ghidra: { error: doctor.error },
      hopper: { installed: false, reason: doctor.error },
      docker,
    };
  }
  return { ghidra: ghidraHealth(doctor.d), hopper: await hopperHealth(doctor.d), docker };
}

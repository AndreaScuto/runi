import { exec, type ExecException } from "node:child_process";
import { promisify } from "node:util";
import type { Job, VerificationCommand, VerificationResult } from "./domain.js";
import { now } from "./domain.js";
import type { RuniStore } from "./storage.js";

const MAX_CAPTURED_OUTPUT = 32_000;
const execAsync = promisify(exec);
type ExecutionError = ExecException & { stdout?: string; stderr?: string };

export async function executeVerificationCommand(
  job: Job,
  phase: VerificationResult["phase"],
  definition: VerificationCommand,
  wallTimeRemainingMs?: number,
): Promise<VerificationResult> {
  const startedAt = now();
  const timeoutMs = Math.min(definition.timeoutMs ?? 10 * 60_000, wallTimeRemainingMs ?? Number.POSITIVE_INFINITY);
  if (timeoutMs <= 0) {
    return {
      jobId: job.id,
      phase,
      command: definition.command,
      label: definition.label ?? definition.command,
      exitCode: null,
      timedOut: true,
      output: "Runi wall-time budget was exhausted before this verification command could start.",
      startedAt,
      completedAt: now(),
    };
  }
  let exitCode: number | null = 0;
  let timedOut = false;
  let output = "";
  try {
    const result = await execAsync(definition.command, {
      cwd: job.definition.workingDirectory,
      timeout: timeoutMs,
      maxBuffer: 10_000_000,
      windowsHide: true,
      encoding: "utf8",
    });
    output = `${result.stdout}${result.stderr}`;
  } catch (error) {
    const failure = error as ExecutionError;
    exitCode = typeof failure.code === "number" ? failure.code : null;
    timedOut = failure.killed === true;
    output = `${failure.stdout ?? ""}${failure.stderr ?? ""}` || failure.message;
  }
  return {
    jobId: job.id,
    phase,
    command: definition.command,
    label: definition.label ?? definition.command,
    exitCode,
    timedOut,
    output: output.slice(0, MAX_CAPTURED_OUTPUT).trim(),
    startedAt,
    completedAt: now(),
  };
}

export async function runVerification(
  store: RuniStore,
  job: Job,
  phase: VerificationResult["phase"],
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  for (const command of job.definition.verification) {
    const wallTime = job.definition.budget.wallTimeMs;
    const elapsed = Date.now() - Date.parse(job.startedAt ?? job.createdAt);
    const remaining = wallTime === undefined ? undefined : Math.max(0, wallTime - elapsed);
    const result = await executeVerificationCommand(job, phase, command, remaining);
    results.push(store.saveVerification(result));
    if (result.timedOut && remaining !== undefined && remaining <= (command.timeoutMs ?? 10 * 60_000)) break;
  }
  return results;
}

export function verificationPassed(results: VerificationResult[]): boolean {
  return results.length > 0 && results.every((result) => result.exitCode === 0 && !result.timedOut);
}

export function describeVerificationFailure(results: VerificationResult[]): string {
  return results
    .filter((result) => result.exitCode !== 0 || result.timedOut)
    .map((result) => `${result.label}: ${result.timedOut ? "timed out" : `exit code ${result.exitCode}`}`)
    .join("; ");
}

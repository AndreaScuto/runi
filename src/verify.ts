import { spawn } from "node:child_process";
import type { Job, VerificationCommand, VerificationResult } from "./domain.js";
import { now } from "./domain.js";
import type { RuniStore } from "./storage.js";

const MAX_CAPTURED_OUTPUT = 32_000;

function capture(chunks: string[], chunk: Buffer): void {
  const joinedLength = chunks.reduce((length, current) => length + current.length, 0);
  if (joinedLength >= MAX_CAPTURED_OUTPUT) return;
  chunks.push(chunk.toString().slice(0, MAX_CAPTURED_OUTPUT - joinedLength));
}

export async function executeVerificationCommand(
  job: Job,
  phase: VerificationResult["phase"],
  definition: VerificationCommand,
): Promise<VerificationResult> {
  const startedAt = now();
  const output: string[] = [];
  const child = spawn(definition.command, {
    cwd: job.definition.workingDirectory,
    shell: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => capture(output, chunk));
  child.stderr?.on("data", (chunk: Buffer) => capture(output, chunk));
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, definition.timeoutMs ?? 10 * 60_000);

  const exitCode = await new Promise<number | null>((resolve) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };
    child.once("error", (error) => {
      output.push(error.message);
      finish(-1);
    });
    child.once("close", (code) => finish(code));
  });
  clearTimeout(timeout);
  return {
    jobId: job.id,
    phase,
    command: definition.command,
    label: definition.label ?? definition.command,
    exitCode,
    timedOut,
    output: output.join("").trim(),
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
    const result = await executeVerificationCommand(job, phase, command);
    results.push(store.saveVerification(result));
  }
  return results;
}

export function verificationPassed(results: VerificationResult[]): boolean {
  return results.every((result) => result.exitCode === 0 && !result.timedOut);
}

export function describeVerificationFailure(results: VerificationResult[]): string {
  return results
    .filter((result) => result.exitCode !== 0 || result.timedOut)
    .map((result) => `${result.label}: ${result.timedOut ? "timed out" : `exit code ${result.exitCode}`}`)
    .join("; ");
}

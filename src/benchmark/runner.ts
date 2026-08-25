import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCodeAdapter, needsWindowsShell, openCodeInvocation } from "../adapters/opencode.js";
import type { Job, JobEvent, VerificationCommand, VerificationResult } from "../domain.js";
import { now } from "../domain.js";
import { RuniStore } from "../storage.js";
import { Supervisor } from "../supervisor.js";
import { executeVerificationCommand } from "../verify.js";
import { writeBenchmarkArtifacts } from "./report.js";
import { BENCHMARK_SCENARIOS, createScenarioWorkspace, type BenchmarkScenario } from "./scenarios.js";
import type { BenchmarkCaseResult, BenchmarkConfiguration, BenchmarkResult, TokenUsage, VerificationEvidence } from "./types.js";
import { sumAttemptUsage, usageFromOpenCodeOutput } from "./usage.js";

const MAX_CAPTURED_OUTPUT = 1_000_000;

export interface RunBenchmarkOptions {
  outputDirectory: string;
  opencodeBinary: string;
  model?: string;
  scenarioCount?: number;
  maxAttempts?: number;
  wallTimeMs?: number;
}

interface ProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function cappedAppend(chunks: string[], value: string): void {
  const currentLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (currentLength < MAX_CAPTURED_OUTPUT) chunks.push(value.slice(0, MAX_CAPTURED_OUTPUT - currentLength));
}

async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  const output: string[] = [];
  return new Promise((resolveResult) => {
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(command, args, {
      cwd,
      shell: needsWindowsShell(command),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolveResult({ exitCode, timedOut, output: output.join("").trim() });
    };
    child.stdout?.on("data", (chunk: Buffer) => cappedAppend(output, chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => cappedAppend(output, chunk.toString()));
    child.once("error", (error) => {
      cappedAppend(output, `${error.message}\n`);
      finish(-1);
    });
    child.once("close", (exitCode) => finish(exitCode));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
  });
}

function taskPath(workspace: string): string {
  return join(workspace, "task.json");
}

function verifier(acceptancePath: string): VerificationCommand {
  return {
    label: "hidden acceptance tests",
    command: `${quote(process.execPath)} ${quote(acceptancePath)}`,
    timeoutMs: 60_000,
  };
}

function benchmarkJob(
  id: string,
  scenario: BenchmarkScenario,
  workspace: string,
  acceptancePath: string,
  configuration: BenchmarkConfiguration,
): Job {
  const timestamp = now();
  return {
    id,
    status: "created",
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    definition: {
      goal: scenario.goal,
      taskPath: taskPath(workspace),
      workingDirectory: workspace,
      executor: {
        kind: "opencode",
        binary: configuration.opencodeBinary,
        autoApprove: true,
        ...(configuration.model === undefined ? {} : { model: configuration.model }),
      },
      verification: [verifier(acceptancePath)],
      budget: { maxAttempts: configuration.maxAttempts, wallTimeMs: configuration.wallTimeMs },
    },
  };
}

function evidence(results: VerificationResult[]): VerificationEvidence[] {
  return results.map((result) => ({
    phase: result.phase,
    command: result.command,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    output: result.output,
  }));
}

async function prepareCase(
  outputDirectory: string,
  scenario: BenchmarkScenario,
  mode: "direct" | "runi",
): Promise<{ workspace: string; acceptancePath: string; logFile: string }> {
  const root = join(outputDirectory, "cases", scenario.id, mode);
  const workspace = join(root, "workspace");
  const acceptancePath = join(root, "hidden-acceptance.mjs");
  const logFile = join(root, "worker.log");
  await mkdir(root, { recursive: true });
  await createScenarioWorkspace(workspace, acceptancePath, scenario);
  await writeFile(taskPath(workspace), JSON.stringify({ goal: scenario.goal }, null, 2));
  return { workspace, acceptancePath, logFile };
}

async function directCase(
  outputDirectory: string,
  scenario: BenchmarkScenario,
  configuration: BenchmarkConfiguration,
): Promise<BenchmarkCaseResult> {
  const startedAt = now();
  const startMs = Date.now();
  const prepared = await prepareCase(outputDirectory, scenario, "direct");
  const job = benchmarkJob(`direct_${scenario.id}`, scenario, prepared.workspace, prepared.acceptancePath, configuration);
  const check = verifier(prepared.acceptancePath);
  const verification: VerificationResult[] = [];
  try {
    verification.push(await executeVerificationCommand(job, "baseline", check));
    const invocation = openCodeInvocation(job, "");
    const worker = await runProcess(invocation.binary, invocation.args, prepared.workspace, configuration.wallTimeMs);
    const remaining = Math.max(0, configuration.wallTimeMs - (Date.now() - startMs));
    const final = await executeVerificationCommand(job, "final", check, remaining);
    verification.push(final);
    await writeFile(prepared.logFile, worker.output);
    const usage = usageFromOpenCodeOutput(worker.output);
    const verified = worker.exitCode === 0 && !worker.timedOut && final.exitCode === 0 && !final.timedOut;
    return {
      scenarioId: scenario.id,
      title: scenario.title,
      mode: "direct",
      startedAt,
      completedAt: now(),
      durationMs: Date.now() - startMs,
      verified,
      workerExitCode: worker.exitCode,
      status: verified ? "complete" : worker.timedOut ? "timed_out" : "failed",
      attempts: 1,
      retries: 0,
      ...(usage === undefined ? {} : { usage }),
      verification: evidence(verification),
      logFile: prepared.logFile,
      workspace: prepared.workspace,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    await writeFile(prepared.logFile, detail);
    return {
      scenarioId: scenario.id,
      title: scenario.title,
      mode: "direct",
      startedAt,
      completedAt: now(),
      durationMs: Date.now() - startMs,
      verified: false,
      workerExitCode: -1,
      status: "error",
      attempts: 1,
      retries: 0,
      verification: evidence(verification),
      logFile: prepared.logFile,
      workspace: prepared.workspace,
    };
  }
}

function attemptUsage(events: JobEvent[]): TokenUsage | undefined {
  const attempts: string[] = [];
  let active: string[] | undefined;
  for (const event of events) {
    if (event.type === "ATTEMPT_STARTED") {
      active = [];
      attempts.push("");
      continue;
    }
    if ((event.type === "AGENT_STDOUT" || event.type === "AGENT_STDERR") && active !== undefined) {
      const message = event.payload.message;
      if (typeof message === "string") active.push(message);
      attempts[attempts.length - 1] = active.join("\n");
    }
  }
  const usages = attempts.map(usageFromOpenCodeOutput).filter((usage): usage is TokenUsage => usage !== undefined);
  return sumAttemptUsage(usages);
}

async function runiCase(
  outputDirectory: string,
  scenario: BenchmarkScenario,
  configuration: BenchmarkConfiguration,
): Promise<BenchmarkCaseResult> {
  const startedAt = now();
  const startMs = Date.now();
  const prepared = await prepareCase(outputDirectory, scenario, "runi");
  const id = `rn_bench_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const job = benchmarkJob(id, scenario, prepared.workspace, prepared.acceptancePath, configuration);
  let store: RuniStore | undefined;
  try {
    store = new RuniStore(join(prepared.workspace, ".runi", "runi.db"));
    store.createJob(job);
    const completed = await new Supervisor(store, new Map([["opencode", new OpenCodeAdapter()]])).run(id);
    const events = store.getEvents(id, 10_000);
    const output = events
      .filter((event) => event.type === "AGENT_STDOUT" || event.type === "AGENT_STDERR")
      .map((event) => typeof event.payload.message === "string" ? event.payload.message : "")
      .join("\n");
    await writeFile(prepared.logFile, output);
    const checks = store.getVerificationResults(id);
    const finalChecks = checks.filter((check) => check.phase === "final");
    const verified = completed.status === "complete" && finalChecks.length > 0 && finalChecks.every((check) => check.exitCode === 0 && !check.timedOut);
    const workers = events
      .filter((event) => event.type === "WORKER_FINISHED")
      .map((event) => event.payload.exitCode)
      .filter((exitCode): exitCode is number | null => typeof exitCode === "number" || exitCode === null);
    const usage = attemptUsage(events);
    return {
      scenarioId: scenario.id,
      title: scenario.title,
      mode: "runi",
      startedAt,
      completedAt: now(),
      durationMs: Date.now() - startMs,
      verified,
      workerExitCode: workers.at(-1) ?? null,
      status: completed.status,
      attempts: completed.attempts,
      retries: Math.max(0, completed.attempts - 1),
      jobId: completed.id,
      ...(usage === undefined ? {} : { usage }),
      verification: evidence(checks),
      logFile: prepared.logFile,
      workspace: prepared.workspace,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    await writeFile(prepared.logFile, detail);
    return {
      scenarioId: scenario.id,
      title: scenario.title,
      mode: "runi",
      startedAt,
      completedAt: now(),
      durationMs: Date.now() - startMs,
      verified: false,
      workerExitCode: -1,
      status: "error",
      attempts: 0,
      retries: 0,
      jobId: id,
      verification: [],
      logFile: prepared.logFile,
      workspace: prepared.workspace,
    };
  } finally {
    store?.close();
  }
}

function benchmarkId(): string {
  return `benchmark-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

/** Runs paired, disposable OpenCode and Runi operations and writes JSON, CSV, Markdown and logs. */
export async function runBenchmark(options: RunBenchmarkOptions): Promise<BenchmarkResult> {
  const scenarioCount = options.scenarioCount ?? BENCHMARK_SCENARIOS.length;
  const maxAttempts = options.maxAttempts ?? 3;
  const wallTimeMs = options.wallTimeMs ?? 10 * 60_000;
  if (!Number.isInteger(scenarioCount) || scenarioCount < 1 || scenarioCount > BENCHMARK_SCENARIOS.length) {
    throw new Error(`--count must be an integer from 1 to ${BENCHMARK_SCENARIOS.length}.`);
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("--max-attempts must be a positive integer.");
  if (!Number.isFinite(wallTimeMs) || wallTimeMs <= 0) throw new Error("--wall-time must be a positive duration.");
  const configuration: BenchmarkConfiguration = {
    opencodeBinary: options.opencodeBinary,
    ...(options.model === undefined ? {} : { model: options.model }),
    scenarioCount,
    maxAttempts,
    wallTimeMs,
  };
  const outputDirectory = resolve(options.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const startedAt = now();
  const cases: BenchmarkCaseResult[] = [];
  for (const scenario of BENCHMARK_SCENARIOS.slice(0, scenarioCount)) {
    cases.push(await directCase(outputDirectory, scenario, configuration));
    cases.push(await runiCase(outputDirectory, scenario, configuration));
  }
  const result: BenchmarkResult = {
    schemaVersion: 1,
    id: benchmarkId(),
    startedAt,
    completedAt: now(),
    configuration,
    cases,
  };
  await writeBenchmarkArtifacts(result, outputDirectory);
  return result;
}

export function defaultBenchmarkOutputDirectory(): string {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  return join(process.cwd(), "benchmarks", "runs", `${stamp}-${basename(fileURLToPath(import.meta.url)).replace(/\W/g, "")}`);
}

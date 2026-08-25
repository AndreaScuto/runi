import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkBudget } from "./budget.js";
import type { AgentAdapter, AgentEvent, Job, WorkerResult, WorkerSession } from "./domain.js";
import { isTerminal } from "./state-machine.js";
import type { RuniStore } from "./storage.js";
import { describeVerificationFailure, runVerification, verificationPassed } from "./verify.js";

const execFileAsync = promisify(execFile);

export class Supervisor {
  constructor(
    private readonly store: RuniStore,
    private readonly adapters: ReadonlyMap<string, AgentAdapter>,
  ) {}

  async run(jobId: string): Promise<Job> {
    let job = this.store.requireJob(jobId);
    if (isTerminal(job.status) || job.status === "paused") return job;

    if (job.definition.verification.length === 0) {
      this.fail(job, "Completion contract requires at least one verification command.");
      return this.store.requireJob(jobId);
    }

    if (job.status === "created") {
      job = this.store.transitionJob(job.id, "planning", "JOB_PLANNING_STARTED");
    }
    if (!job.baselineAt) {
      const baseline = await runVerification(this.store, job, "baseline");
      this.store.markBaseline(job.id);
      this.store.appendEvent(job.id, "BASELINE_COMPLETE", { passed: verificationPassed(baseline), checks: baseline.length });
      job = this.store.requireJob(job.id);
      const baselineBudget = checkBudget(job);
      if (baselineBudget.exceeded) {
        this.exhaust(job, baselineBudget.reason!);
        return this.store.requireJob(job.id);
      }
      if (job.status === "paused" || isTerminal(job.status)) return job;
    }
    if (job.status === "planning") job = this.store.transitionJob(job.id, "working", "JOB_WORK_STARTED");

    while (!isTerminal(job.status) && job.status !== "paused") {
      if (job.status === "working") {
        await this.runWorker(job);
      } else if (job.status === "verifying") {
        await this.verify(job);
      } else if (job.status === "repairing") {
        const budget = this.launchBudget(job);
        if (budget) this.exhaust(job, budget);
        else {
          await this.checkpoint(job, "before-repair");
          this.store.transitionJob(job.id, "working", "REPAIR_STARTED");
        }
      } else if (job.status === "reviewing") {
        this.store.transitionJob(job.id, "complete", "JOB_COMPLETED", { evidence: "verification commands passed" });
      } else if (job.status === "planning") {
        this.store.transitionJob(job.id, "working", "JOB_WORK_STARTED");
      }
      job = this.store.requireJob(job.id);
    }
    return job;
  }

  private async runWorker(job: Job): Promise<void> {
    const budgetReason = this.launchBudget(job);
    if (budgetReason) {
      this.exhaust(job, budgetReason);
      return;
    }
    await this.checkpoint(job, job.attempts > 0 ? "before-resume" : "before-worker");
    const attempted = this.store.incrementAttempts(job.id);
    const adapter = this.adapters.get(attempted.definition.executor.kind);
    if (!adapter) {
      this.fail(attempted, `No adapter registered for ${attempted.definition.executor.kind}.`);
      return;
    }
    const context = this.recoveryContext(attempted);
    let session: WorkerSession;
    try {
      session = attempted.attempts > 1
        ? await adapter.resume(attempted, context)
        : await adapter.start(attempted, context);
    } catch (error) {
      await this.handleWorkerFailure(attempted, { exitCode: -1, signal: null, output: this.errorMessage(error) });
      return;
    }
    const worker = this.store.createWorker({
      jobId: attempted.id,
      kind: adapter.kind,
      ...(session.pid === undefined ? {} : { pid: session.pid }),
      metadata: session.metadata,
    });
    const monitor = this.monitorWorker(attempted.id, session);
    try {
      for await (const entry of session.events()) this.recordAgentEvent(attempted.id, entry);
      const result = await session.result;
      clearInterval(monitor);
      const current = this.store.requireJob(attempted.id);
      const workerStatus = result.exitCode === 0 ? "completed" : current.status === "paused" || current.status === "cancelled" ? "stopped" : "failed";
      this.store.finishWorker(worker.id, workerStatus, result.exitCode);
      if (current.status === "paused" || current.status === "cancelled" || isTerminal(current.status)) return;
      const currentBudget = checkBudget(current);
      if (currentBudget.exceeded) {
        this.exhaust(current, currentBudget.reason!);
      } else if (result.exitCode === 0) {
        this.store.transitionJob(current.id, "verifying", "WORKER_SUCCEEDED", { attempt: current.attempts });
      } else {
        await this.handleWorkerFailure(current, result);
      }
    } finally {
      clearInterval(monitor);
    }
  }

  private async verify(job: Job): Promise<void> {
    const checks = await runVerification(this.store, job, "final");
    const current = this.store.requireJob(job.id);
    if (current.status === "paused" || current.status === "cancelled" || isTerminal(current.status)) return;
    const budget = checkBudget(current);
    if (budget.exceeded) {
      this.exhaust(current, budget.reason!);
      return;
    }
    if (verificationPassed(checks)) {
      this.store.transitionJob(current.id, "reviewing", "VERIFICATION_PASSED", { checks: checks.length });
      return;
    }
    const reason = describeVerificationFailure(checks);
    this.store.appendEvent(current.id, "VERIFICATION_FAILED", { reason });
    await this.recover(current, `Verification failed: ${reason}`, "verification");
  }

  private async handleWorkerFailure(job: Job, result: WorkerResult): Promise<void> {
    const detail = result.output.slice(-8_000) || `Worker exited with ${result.exitCode ?? result.signal ?? "unknown status"}.`;
    await this.recover(job, detail, "worker");
  }

  private async recover(job: Job, detail: string, source: "worker" | "verification"): Promise<void> {
    const fingerprint = createHash("sha256").update(`${source}:${detail.replace(/\d+/g, "#")}`).digest("hex").slice(0, 16);
    const failureType = this.classifyFailure(detail);
    this.store.appendEvent(job.id, "WORKER_FAILED", { source, failureType, fingerprint, detail: detail.slice(-8_000) });
    const current = this.store.requireJob(job.id);
    if (current.attempts >= current.definition.budget.maxAttempts) {
      this.exhaust(current, `Maximum attempts reached (${current.definition.budget.maxAttempts})`);
      return;
    }
    const repeated = this.store.countRecentFailureFingerprint(current.id, fingerprint);
    if (repeated >= 3) {
      this.fail(current, `Stagnation detected: the same ${source} failure occurred ${repeated} times.`);
      return;
    }
    this.store.transitionJob(current.id, "repairing", "RECOVERY_SCHEDULED", { source, failureType, fingerprint, repeated });
  }

  private launchBudget(job: Job): string | undefined {
    if (job.attempts >= job.definition.budget.maxAttempts) return `Maximum attempts reached (${job.definition.budget.maxAttempts})`;
    const result = checkBudget(job);
    return result.exceeded ? result.reason : undefined;
  }

  private exhaust(job: Job, reason: string): void {
    const current = this.store.requireJob(job.id);
    if (!isTerminal(current.status)) {
      this.store.transitionJob(current.id, "budget_exceeded", "BUDGET_EXCEEDED", { reason }, { exitReason: reason });
    }
  }

  private fail(job: Job, reason: string): void {
    const current = this.store.requireJob(job.id);
    if (!isTerminal(current.status)) {
      this.store.transitionJob(current.id, "failed", "JOB_FAILED", { reason }, { exitReason: reason });
    }
  }

  private monitorWorker(jobId: string, session: WorkerSession): NodeJS.Timeout {
    let stopping = false;
    return setInterval(() => {
      if (stopping) return;
      const job = this.store.requireJob(jobId);
      const budget = checkBudget(job);
      if (job.status === "paused" || job.status === "cancelled" || budget.exceeded) {
        stopping = true;
        if (budget.exceeded && !isTerminal(job.status)) this.exhaust(job, budget.reason!);
        void session.stop();
      }
    }, 500);
  }

  private async checkpoint(job: Job, reason: string): Promise<void> {
    const git = await this.gitSnapshot(job.definition.workingDirectory);
    this.store.createCheckpoint({
      jobId: job.id,
      reason,
      snapshot: {
        status: job.status,
        attempts: job.attempts,
        budget: job.definition.budget,
        taskPath: job.definition.taskPath,
      },
      ...(git.sha === undefined ? {} : { gitSha: git.sha }),
      ...(git.diff === undefined ? {} : { gitDiff: git.diff }),
    });
  }

  private async gitSnapshot(cwd: string): Promise<{ sha?: string; diff?: string }> {
    try {
      const [revision, diff] = await Promise.all([
        execFileAsync("git", ["rev-parse", "HEAD"], { cwd, windowsHide: true, maxBuffer: 8_000 }),
        execFileAsync("git", ["diff", "--binary", "--no-ext-diff"], { cwd, windowsHide: true, maxBuffer: 200_000 }),
      ]);
      const sha = revision.stdout.trim();
      return {
        ...(sha ? { sha } : {}),
        ...(diff.stdout ? { diff: diff.stdout.slice(0, 200_000) } : {}),
      };
    } catch {
      return {};
    }
  }

  private recoveryContext(job: Job): string {
    const events = this.store.getEvents(job.id, 12)
      .filter((entry) => entry.type === "WORKER_FAILED" || entry.type === "VERIFICATION_FAILED")
      .map((entry) => `${entry.type}: ${typeof entry.payload.reason === "string" ? entry.payload.reason : entry.payload.detail ?? "failure"}`);
    return events.join("\n").slice(-12_000);
  }

  private recordAgentEvent(jobId: string, entry: AgentEvent): void {
    this.store.appendEvent(jobId, `AGENT_${entry.type.toUpperCase()}`, {
      message: entry.message.slice(0, 12_000),
      ...(entry.data === undefined ? {} : { data: entry.data }),
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.stack ?? error.message : String(error);
  }

  private classifyFailure(detail: string): "transient" | "execution" | "policy" {
    const normalized = detail.toLowerCase();
    if (/\b(429|rate limit|timeout|timed out|econnreset|enetunreach|enotfound|network)\b/.test(normalized)) return "transient";
    if (/\b(permission denied|forbidden|budget exceeded)\b/.test(normalized)) return "policy";
    return "execution";
  }
}

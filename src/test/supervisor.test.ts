import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentAdapter, AgentEvent, Job, WorkerSession } from "../domain.js";
import { now } from "../domain.js";
import { RuniStore } from "../storage.js";
import { Supervisor } from "../supervisor.js";

class ScriptedAdapter implements AgentAdapter {
  readonly kind = "command" as const;
  starts = 0;
  resumes = 0;
  constructor(private readonly outcomes: Array<number | { exitCode: number; output: string }>) {}

  async start(): Promise<WorkerSession> {
    this.starts += 1;
    const outcome = this.outcomes.shift() ?? 0;
    return this.session(typeof outcome === "number" ? { exitCode: outcome, output: outcome === 0 ? "done" : "temporary failure" } : outcome);
  }

  async resume(): Promise<WorkerSession> {
    this.resumes += 1;
    return this.start();
  }

  private session(outcome: { exitCode: number; output: string }): WorkerSession {
    return {
      metadata: { test: true },
      async *events(): AsyncIterable<AgentEvent> {
        yield { type: "status", message: "scripted worker", createdAt: now() };
      },
      result: Promise.resolve({ exitCode: outcome.exitCode, signal: null, output: outcome.output }),
      async stop(): Promise<void> {},
    };
  }
}

async function fixture(): Promise<{ root: string; store: RuniStore; job: Job }> {
  const root = await mkdtemp(join(tmpdir(), "runi-test-"));
  await writeFile(join(root, "task.md"), "# Improve the sample\n");
  const timestamp = now();
  const job: Job = {
    id: "rn_test",
    status: "created",
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    definition: {
      goal: "Improve the sample",
      taskPath: join(root, "task.md"),
      workingDirectory: root,
      executor: { kind: "command", command: "unused" },
      verification: [{ command: `"${process.execPath}" -e "process.exit(0)"`, label: "passes" }],
      budget: { maxAttempts: 3, wallTimeMs: 60_000 },
    },
  };
  const store = new RuniStore(join(root, ".runi", "runi.db"));
  store.createJob(job);
  return { root, store, job };
}

test("supervisor completes only after persisted verification evidence", async (t) => {
  const { root, store, job } = await fixture();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const adapter = new ScriptedAdapter([0]);
  const result = await new Supervisor(store, new Map([["command", adapter]])).run(job.id);
  assert.equal(result.status, "complete");
  assert.equal(result.attempts, 1);
  assert.equal(store.getVerificationResults(job.id).filter((entry) => entry.phase === "final")[0]?.exitCode, 0);
  assert.ok(store.getEvents(job.id).some((entry) => entry.type === "JOB_COMPLETED"));
});

test("supervisor retries a failed worker and records recovery", async (t) => {
  const { root, store, job } = await fixture();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const adapter = new ScriptedAdapter([1, 0]);
  const result = await new Supervisor(store, new Map([["command", adapter]])).run(job.id);
  assert.equal(result.status, "complete");
  assert.equal(result.attempts, 2);
  assert.ok(store.getEvents(job.id).some((entry) => entry.type === "RECOVERY_SCHEDULED"));
});

test("supervisor identifies rate limits as transient failures before retrying", async (t) => {
  const { root, store, job } = await fixture();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const adapter = new ScriptedAdapter([{ exitCode: 1, output: "HTTP 429 rate limit" }, 0]);
  const result = await new Supervisor(store, new Map([["command", adapter]])).run(job.id);
  assert.equal(result.status, "complete");
  const failure = store.getEvents(job.id).find((entry) => entry.type === "WORKER_FAILED");
  assert.equal(failure?.payload.failureType, "transient");
});

test("supervisor stops an obvious repeated failure loop before exhausting attempts", async (t) => {
  const { root, store, job } = await fixture();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const timestamp = now();
  const loopJob: Job = { ...job, id: "rn_loop", createdAt: timestamp, updatedAt: timestamp, definition: { ...job.definition, budget: { maxAttempts: 5, wallTimeMs: 60_000 } } };
  store.createJob(loopJob);
  const adapter = new ScriptedAdapter([1, 1, 1, 1]);
  const result = await new Supervisor(store, new Map([["command", adapter]])).run(loopJob.id);
  assert.equal(result.status, "failed");
  assert.equal(result.attempts, 3);
  assert.match(result.exitReason ?? "", /Stagnation detected/);
});

test("supervisor refuses completion when a persisted job has no completion contract", async (t) => {
  const { root, store, job } = await fixture();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const timestamp = now();
  const unverified: Job = { ...job, id: "rn_unverified", createdAt: timestamp, updatedAt: timestamp, definition: { ...job.definition, verification: [] } };
  store.createJob(unverified);
  const result = await new Supervisor(store, new Map([["command", new ScriptedAdapter([0])]])).run(unverified.id);
  assert.equal(result.status, "failed");
  assert.match(result.exitReason ?? "", /Completion contract/);
});

test("a persisted working job survives database reopen and resumes with a new worker session", async (t) => {
  const { root, store, job } = await fixture();
  let restarted: RuniStore | undefined;
  t.after(async () => { restarted?.close(); await rm(root, { recursive: true, force: true }); });
  store.transitionJob(job.id, "planning", "TEST_PLANNING");
  store.transitionJob(job.id, "working", "TEST_WORKING");
  store.incrementAttempts(job.id);
  store.close();
  restarted = new RuniStore(join(root, ".runi", "runi.db"));
  assert.equal(restarted.requireJob(job.id).status, "working");
  assert.equal(restarted.requireJob(job.id).attempts, 1);
  const adapter = new ScriptedAdapter([0]);
  const result = await new Supervisor(restarted, new Map([["command", adapter]])).run(job.id);
  assert.equal(result.status, "complete");
  assert.equal(adapter.resumes, 1);
  assert.equal(result.attempts, 2);
});

test("pause and resume preserve the lifecycle state to continue", async (t) => {
  const { root, store, job } = await fixture();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.transitionJob(job.id, "planning", "TEST_PLANNING");
  store.transitionJob(job.id, "working", "TEST_WORKING");
  const paused = store.pauseJob(job.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.resumeStatus, "working");
  const resumed = store.resumeJob(job.id);
  assert.equal(resumed.status, "working");
  assert.equal(resumed.resumeStatus, undefined);
});

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
  constructor(private readonly exitCodes: number[]) {}

  async start(): Promise<WorkerSession> {
    this.starts += 1;
    return this.session(this.exitCodes.shift() ?? 0);
  }

  async resume(): Promise<WorkerSession> {
    this.resumes += 1;
    return this.start();
  }

  private session(exitCode: number): WorkerSession {
    return {
      metadata: { test: true },
      async *events(): AsyncIterable<AgentEvent> {
        yield { type: "status", message: "scripted worker", createdAt: now() };
      },
      result: Promise.resolve({ exitCode, signal: null, output: exitCode === 0 ? "done" : "temporary failure" }),
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

test("a persisted working job resumes with a new worker session", async (t) => {
  const { root, store, job } = await fixture();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.transitionJob(job.id, "planning", "TEST_PLANNING");
  store.transitionJob(job.id, "working", "TEST_WORKING");
  store.incrementAttempts(job.id);
  const adapter = new ScriptedAdapter([0]);
  const result = await new Supervisor(store, new Map([["command", adapter]])).run(job.id);
  assert.equal(result.status, "complete");
  assert.equal(adapter.resumes, 1);
  assert.equal(result.attempts, 2);
});

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Checkpoint,
  Job,
  JobEvent,
  JobStatus,
  VerificationResult,
  WorkerRecord,
} from "./domain.js";
import { now } from "./domain.js";
import { assertTransition, isTerminal } from "./state-machine.js";

type Row = Record<string, unknown>;

function parseJson<T>(value: unknown, label: string): T {
  if (typeof value !== "string") throw new Error(`Corrupt Runi database: ${label} is not JSON.`);
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Corrupt Runi database: cannot parse ${label}.`);
  }
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Corrupt Runi database: expected text value.");
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error("Corrupt Runi database: expected numeric value.");
}

export class RuniStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  createJob(job: Job): void {
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO jobs (
          id, status, definition_json, attempts, resume_status, created_at, updated_at,
          started_at, completed_at, baseline_at, exit_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.id,
        job.status,
        JSON.stringify(job.definition),
        job.attempts,
        job.resumeStatus ?? null,
        job.createdAt,
        job.updatedAt,
        job.startedAt ?? null,
        job.completedAt ?? null,
        job.baselineAt ?? null,
        job.exitReason ?? null,
      );
      this.insertEvent(job.id, "JOB_CREATED", { goal: job.definition.goal, status: job.status });
    });
  }

  getJob(id: string): Job | undefined {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : this.toJob(row);
  }

  requireJob(id: string): Job {
    const job = this.getJob(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return job;
  }

  listJobs(limit = 50): Job[] {
    return (this.database.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map((row) => this.toJob(row));
  }

  transitionJob(
    id: string,
    nextStatus: JobStatus,
    eventType: string,
    payload: Record<string, unknown> = {},
    options: { resumeStatus?: JobStatus; exitReason?: string } = {},
  ): Job {
    return this.transaction(() => {
      const current = this.requireJob(id);
      assertTransition(current.status, nextStatus);
      const timestamp = now();
      const startedAt = current.startedAt ?? (nextStatus === "planning" ? timestamp : undefined);
      const completedAt = isTerminal(nextStatus) ? timestamp : undefined;
      this.database.prepare(`
        UPDATE jobs SET
          status = ?, resume_status = ?, updated_at = ?, started_at = ?, completed_at = ?, exit_reason = ?
        WHERE id = ?
      `).run(
        nextStatus,
        options.resumeStatus ?? null,
        timestamp,
        startedAt ?? current.startedAt ?? null,
        completedAt ?? current.completedAt ?? null,
        options.exitReason ?? null,
        id,
      );
      this.insertEvent(id, eventType, { from: current.status, to: nextStatus, ...payload });
      return this.requireJob(id);
    });
  }

  pauseJob(id: string): Job {
    const current = this.requireJob(id);
    if (isTerminal(current.status)) throw new Error(`Cannot pause terminal job ${id} (${current.status}).`);
    if (current.status === "paused") return current;
    return this.transitionJob(id, "paused", "JOB_PAUSED", {}, { resumeStatus: current.status });
  }

  resumeJob(id: string): Job {
    const current = this.requireJob(id);
    if (current.status !== "paused") throw new Error(`Only paused jobs can be resumed (current state: ${current.status}).`);
    const target = current.resumeStatus ?? "working";
    return this.transitionJob(id, target, "JOB_RESUMED", { resumeFrom: target });
  }

  cancelJob(id: string): Job {
    const current = this.requireJob(id);
    if (isTerminal(current.status)) return current;
    return this.transitionJob(id, "cancelled", "JOB_CANCELLED");
  }

  incrementAttempts(id: string): Job {
    return this.transaction(() => {
      this.database.prepare("UPDATE jobs SET attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now(), id);
      const job = this.requireJob(id);
      this.insertEvent(id, "ATTEMPT_STARTED", { attempt: job.attempts });
      return job;
    });
  }

  markBaseline(id: string): void {
    const timestamp = now();
    this.database.prepare("UPDATE jobs SET baseline_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, id);
    this.insertEvent(id, "BASELINE_RECORDED", { at: timestamp });
  }

  appendEvent(id: string, type: string, payload: Record<string, unknown> = {}): JobEvent {
    const sequence = this.insertEvent(id, type, payload);
    return {
      sequence,
      jobId: id,
      type,
      payload,
      createdAt: now(),
    };
  }

  getEvents(id: string, limit = 200): JobEvent[] {
    return (this.database.prepare(`
      SELECT id, job_id, event_type, payload_json, created_at
      FROM events WHERE job_id = ? ORDER BY id DESC LIMIT ?
    `).all(id, limit) as Row[]).reverse().map((row) => ({
      sequence: numberValue(row.id),
      jobId: text(row.job_id),
      type: text(row.event_type),
      payload: parseJson<Record<string, unknown>>(row.payload_json, "event payload"),
      createdAt: text(row.created_at),
    }));
  }

  countRecentFailureFingerprint(id: string, fingerprint: string, limit = 6): number {
    const rows = this.database.prepare(`
      SELECT payload_json FROM events
      WHERE job_id = ? AND event_type = 'WORKER_FAILED'
      ORDER BY id DESC LIMIT ?
    `).all(id, limit) as Row[];
    return rows.filter((row) => parseJson<Record<string, unknown>>(row.payload_json, "event payload").fingerprint === fingerprint).length;
  }

  createCheckpoint(checkpoint: Omit<Checkpoint, "id" | "createdAt">): Checkpoint {
    const createdAt = now();
    const result = this.database.prepare(`
      INSERT INTO checkpoints (job_id, reason, snapshot_json, git_sha, git_diff, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      checkpoint.jobId,
      checkpoint.reason,
      JSON.stringify(checkpoint.snapshot),
      checkpoint.gitSha ?? null,
      checkpoint.gitDiff ?? null,
      createdAt,
    );
    const id = Number(result.lastInsertRowid);
    this.insertEvent(checkpoint.jobId, "CHECKPOINT_CREATED", { checkpointId: id, reason: checkpoint.reason });
    return { id, ...checkpoint, createdAt };
  }

  latestCheckpoint(jobId: string): Checkpoint | undefined {
    const row = this.database.prepare("SELECT * FROM checkpoints WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(jobId) as Row | undefined;
    if (!row) return undefined;
    return {
      id: numberValue(row.id),
      jobId: text(row.job_id),
      reason: text(row.reason),
      snapshot: parseJson<Record<string, unknown>>(row.snapshot_json, "checkpoint snapshot"),
      ...(optionalText(row.git_sha) === undefined ? {} : { gitSha: optionalText(row.git_sha)! }),
      ...(optionalText(row.git_diff) === undefined ? {} : { gitDiff: optionalText(row.git_diff)! }),
      createdAt: text(row.created_at),
    };
  }

  createWorker(worker: Omit<WorkerRecord, "id" | "startedAt" | "status">): WorkerRecord {
    const startedAt = now();
    const result = this.database.prepare(`
      INSERT INTO workers (job_id, kind, pid, status, metadata_json, started_at)
      VALUES (?, ?, ?, 'running', ?, ?)
    `).run(worker.jobId, worker.kind, worker.pid ?? null, JSON.stringify(worker.metadata), startedAt);
    const id = Number(result.lastInsertRowid);
    this.insertEvent(worker.jobId, "WORKER_STARTED", { workerId: id, kind: worker.kind, pid: worker.pid ?? null });
    return { id, ...worker, status: "running", startedAt };
  }

  finishWorker(id: number, status: WorkerRecord["status"], exitCode: number | null): void {
    const row = this.database.prepare("SELECT job_id FROM workers WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`Worker not found: ${id}`);
    const completedAt = now();
    this.database.prepare("UPDATE workers SET status = ?, exit_code = ?, completed_at = ? WHERE id = ?").run(status, exitCode, completedAt, id);
    this.insertEvent(text(row.job_id), "WORKER_FINISHED", { workerId: id, status, exitCode });
  }

  saveVerification(result: VerificationResult): VerificationResult {
    const insert = this.database.prepare(`
      INSERT INTO verification_runs (
        job_id, phase, command, label, exit_code, timed_out, output, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.jobId,
      result.phase,
      result.command,
      result.label,
      result.exitCode,
      result.timedOut ? 1 : 0,
      result.output,
      result.startedAt,
      result.completedAt,
    );
    const saved = { ...result, id: Number(insert.lastInsertRowid) };
    this.insertEvent(result.jobId, "VERIFICATION_RESULT", {
      verificationId: saved.id,
      phase: result.phase,
      label: result.label,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    });
    return saved;
  }

  getVerificationResults(id: string): VerificationResult[] {
    return (this.database.prepare("SELECT * FROM verification_runs WHERE job_id = ? ORDER BY id ASC").all(id) as Row[]).map((row) => ({
      id: numberValue(row.id),
      jobId: text(row.job_id),
      phase: text(row.phase) as VerificationResult["phase"],
      command: text(row.command),
      label: text(row.label),
      exitCode: row.exit_code === null ? null : numberValue(row.exit_code),
      timedOut: numberValue(row.timed_out) === 1,
      output: text(row.output),
      startedAt: text(row.started_at),
      completedAt: text(row.completed_at),
    }));
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        resume_status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        baseline_at TEXT,
        exit_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_job_id_id ON events(job_id, id);
      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        reason TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        git_sha TEXT,
        git_diff TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        kind TEXT NOT NULL,
        pid INTEGER,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        exit_code INTEGER
      );
      CREATE TABLE IF NOT EXISTS verification_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        phase TEXT NOT NULL,
        command TEXT NOT NULL,
        label TEXT NOT NULL,
        exit_code INTEGER,
        timed_out INTEGER NOT NULL,
        output TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );
    `);
  }

  private insertEvent(jobId: string, type: string, payload: Record<string, unknown>): number {
    const result = this.database.prepare(
      "INSERT INTO events (job_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(jobId, type, JSON.stringify(payload), now());
    return Number(result.lastInsertRowid);
  }

  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private toJob(row: Row): Job {
    return {
      id: text(row.id),
      status: text(row.status) as JobStatus,
      definition: parseJson<Job["definition"]>(row.definition_json, "job definition"),
      attempts: numberValue(row.attempts),
      ...(optionalText(row.resume_status) === undefined ? {} : { resumeStatus: optionalText(row.resume_status) as JobStatus }),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
      ...(optionalText(row.started_at) === undefined ? {} : { startedAt: optionalText(row.started_at)! }),
      ...(optionalText(row.completed_at) === undefined ? {} : { completedAt: optionalText(row.completed_at)! }),
      ...(optionalText(row.baseline_at) === undefined ? {} : { baselineAt: optionalText(row.baseline_at)! }),
      ...(optionalText(row.exit_reason) === undefined ? {} : { exitReason: optionalText(row.exit_reason)! }),
    };
  }
}

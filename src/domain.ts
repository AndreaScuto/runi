export const JOB_STATUSES = [
  "created",
  "planning",
  "working",
  "verifying",
  "repairing",
  "reviewing",
  "complete",
  "paused",
  "failed",
  "cancelled",
  "budget_exceeded",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_STATUSES = new Set<JobStatus>([
  "complete",
  "failed",
  "cancelled",
  "budget_exceeded",
]);

export type AgentKind = "opencode" | "command";

export interface VerificationCommand {
  command: string;
  label?: string;
  timeoutMs?: number;
}

export interface Budget {
  maxAttempts: number;
  wallTimeMs?: number;
}

export interface ExecutorConfig {
  kind: AgentKind;
  /** Required for the generic command adapter. */
  command?: string;
  /** Optional path or command name of the OpenCode executable. */
  binary?: string;
}

export interface TaskDefinition {
  goal: string;
  taskPath: string;
  workingDirectory: string;
  executor: ExecutorConfig;
  verification: VerificationCommand[];
  budget: Budget;
}

export interface Job {
  id: string;
  status: JobStatus;
  definition: TaskDefinition;
  attempts: number;
  resumeStatus?: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  baselineAt?: string;
  exitReason?: string;
}

export interface JobEvent {
  sequence: number;
  jobId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Checkpoint {
  id: number;
  jobId: string;
  reason: string;
  snapshot: Record<string, unknown>;
  gitSha?: string;
  gitDiff?: string;
  createdAt: string;
}

export interface VerificationResult {
  id?: number;
  jobId: string;
  phase: "baseline" | "final";
  command: string;
  label: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  startedAt: string;
  completedAt: string;
}

export interface WorkerRecord {
  id: number;
  jobId: string;
  kind: AgentKind;
  pid?: number;
  status: "running" | "completed" | "failed" | "stopped";
  metadata: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
  exitCode?: number | null;
}

export interface AgentEvent {
  type: "stdout" | "stderr" | "status";
  message: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface WorkerResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

export interface WorkerSession {
  pid?: number;
  metadata: Record<string, unknown>;
  events(): AsyncIterable<AgentEvent>;
  result: Promise<WorkerResult>;
  stop(): Promise<void>;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  start(job: Job, context: string): Promise<WorkerSession>;
  resume(job: Job, context: string): Promise<WorkerSession>;
}

export const now = (): string => new Date().toISOString();

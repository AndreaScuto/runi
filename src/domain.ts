export const JOB_STATUSES = [
  "created",
  "working",
  "verifying",
  "repairing",
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

export type AgentKind = "opencode" | "codex" | "claude" | "command";

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
  /** Optional path or command name of the selected coding-agent executable. */
  binary?: string;
  /** Explicit model identifier understood by the selected coding agent. */
  model?: string;
  /** Pass OpenCode's non-interactive auto-approval flag. Use only in disposable workspaces. */
  autoApprove?: boolean;
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
  events(): AsyncIterable<AgentEvent>;
  result: Promise<WorkerResult>;
  stop(): Promise<void>;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  start(job: Job, context: string): Promise<WorkerSession>;
}

export const now = (): string => new Date().toISOString();

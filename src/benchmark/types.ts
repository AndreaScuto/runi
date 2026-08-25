export type BenchmarkMode = "direct" | "runi";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  samples: number;
}

export interface VerificationEvidence {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

export interface BenchmarkCaseResult {
  scenarioId: string;
  title: string;
  mode: BenchmarkMode;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  verified: boolean;
  workerExitCode: number | null;
  status: string;
  attempts: number;
  retries: number;
  jobId?: string;
  usage?: TokenUsage;
  verification: VerificationEvidence[];
  logFile: string;
  workspace: string;
}

export interface BenchmarkConfiguration {
  opencodeBinary: string;
  model?: string;
  scenarioCount: number;
  maxAttempts: number;
  wallTimeMs: number;
}

export interface BenchmarkResult {
  schemaVersion: 1;
  id: string;
  startedAt: string;
  completedAt: string;
  configuration: BenchmarkConfiguration;
  cases: BenchmarkCaseResult[];
}

export interface AggregateMetrics {
  total: number;
  verified: number;
  verifiedRate: number;
  durationMs: { total: number; average: number; median: number; p95: number };
  attempts: number;
  retries: number;
  tokenUsage?: { total: number; observedRuns: number };
  costUsd?: { total: number; observedRuns: number };
}

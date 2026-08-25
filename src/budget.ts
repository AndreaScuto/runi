import type { Job } from "./domain.js";

export interface BudgetStatus {
  exceeded: boolean;
  reason?: string;
  elapsedMs: number;
}

export function checkBudget(job: Job, at = Date.now()): BudgetStatus {
  const started = Date.parse(job.startedAt ?? job.createdAt);
  const elapsedMs = Math.max(0, at - started);

  const wallTime = job.definition.budget.wallTimeMs;
  if (wallTime !== undefined && elapsedMs >= wallTime) {
    return {
      exceeded: true,
      reason: `Wall-time budget reached (${formatDuration(wallTime)})`,
      elapsedMs,
    };
  }

  return { exceeded: false, elapsedMs };
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

export function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}. Use values such as 30m, 2h, or 500ms.`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  const multiplier: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.round(amount * multiplier[unit]!);
}

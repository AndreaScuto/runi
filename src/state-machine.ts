import { type JobStatus, TERMINAL_STATUSES } from "./domain.js";

const transitions: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  created: ["planning", "cancelled", "failed"],
  planning: ["working", "paused", "cancelled", "failed", "budget_exceeded"],
  working: ["verifying", "repairing", "paused", "cancelled", "failed", "budget_exceeded"],
  verifying: ["reviewing", "repairing", "paused", "cancelled", "failed", "budget_exceeded"],
  repairing: ["working", "paused", "cancelled", "failed", "budget_exceeded"],
  reviewing: ["complete", "repairing", "paused", "cancelled", "failed", "budget_exceeded"],
  paused: ["planning", "working", "verifying", "repairing", "reviewing", "cancelled", "failed", "budget_exceeded"],
  complete: [],
  failed: [],
  cancelled: [],
  budget_exceeded: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid job transition: ${from} -> ${to}`);
  }
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

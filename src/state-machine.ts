import { type JobStatus, TERMINAL_STATUSES } from "./domain.js";

const transitions: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  created: ["working", "cancelled", "failed"],
  working: ["verifying", "repairing", "paused", "cancelled", "failed", "budget_exceeded"],
  verifying: ["complete", "repairing", "paused", "cancelled", "failed", "budget_exceeded"],
  repairing: ["working", "paused", "cancelled", "failed", "budget_exceeded"],
  paused: ["working", "verifying", "repairing", "cancelled", "failed", "budget_exceeded"],
  complete: [],
  failed: [],
  cancelled: [],
  budget_exceeded: [],
};

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!transitions[from].includes(to)) {
    throw new Error(`Invalid job transition: ${from} -> ${to}`);
  }
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

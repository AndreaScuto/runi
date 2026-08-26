import type { AgentAdapter, Job, WorkerSession } from "../domain.js";
import { needsWindowsShell, resolveExecutable } from "../agents.js";
import { ProcessWorkerSession } from "./process.js";

export class OpenCodeAdapter implements AgentAdapter {
  readonly kind = "opencode" as const;

  async start(job: Job, context: string): Promise<WorkerSession> {
    const invocation = openCodeInvocation(job, context);
    const binary = resolveExecutable(invocation.binary) ?? invocation.binary;
    return new ProcessWorkerSession(binary, invocation.args, {
      cwd: job.definition.workingDirectory,
      env: { ...process.env, RUNI_JOB_ID: job.id, RUNI_ATTEMPT: String(job.attempts) },
      shell: needsWindowsShell(binary),
    });
  }
}

/**
 * Shared by Runi and its benchmark harness so the direct and supervised modes
 * invoke the same OpenCode worker prompt and flags.
 */
export function openCodeInvocation(job: Job, context: string): { binary: string; args: string[] } {
  const args = ["run", "--format", "json"];
  if (job.definition.executor.autoApprove === true) args.push("--auto");
  if (job.definition.executor.model !== undefined) args.push("--model", job.definition.executor.model);
  args.push(openCodePrompt(job, context));
  return { binary: job.definition.executor.binary ?? "opencode", args };
}

export function openCodePrompt(job: Job, context: string): string {
  return [
      "You are the execution worker for a durable Runi job.",
      "Work directly in the assigned repository and make concrete progress toward the goal.",
      "Runi, not you, decides completion and will independently run the verification contract.",
      "Do not only describe a solution: implement it and leave the working tree in its best correct state.",
      "",
      `Goal:\n${job.definition.goal}`,
      context ? `\nContext from prior attempts:\n${context}` : "",
  ].join("\n");
}

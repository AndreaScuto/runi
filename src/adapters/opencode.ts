import type { AgentAdapter, Job, WorkerSession } from "../domain.js";
import { ProcessWorkerSession } from "./process.js";

export class OpenCodeAdapter implements AgentAdapter {
  readonly kind = "opencode" as const;

  async start(job: Job, context: string): Promise<WorkerSession> {
    const invocation = openCodeInvocation(job, context);
    return new ProcessWorkerSession(invocation.binary, invocation.args, {
      cwd: job.definition.workingDirectory,
      env: { ...process.env, RUNI_JOB_ID: job.id, RUNI_ATTEMPT: String(job.attempts) },
      shell: needsWindowsShell(invocation.binary),
    });
  }

  async resume(job: Job, context: string): Promise<WorkerSession> {
    return this.start(job, `${context}\n\nThis is a resumed durable job. Inspect the current repository before changing it.`);
  }

}

export interface OpenCodeInvocation {
  binary: string;
  args: string[];
}

/** Windows package-manager shims need cmd.exe; native executables do not. */
export function needsWindowsShell(binary: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(binary);
}

/**
 * Shared by Runi and its benchmark harness so the direct and supervised modes
 * invoke the same OpenCode worker prompt and flags.
 */
export function openCodeInvocation(job: Job, context: string): OpenCodeInvocation {
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

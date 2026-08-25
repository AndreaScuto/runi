import type { AgentAdapter, Job, WorkerSession } from "../domain.js";
import { needsWindowsShell, openCodePrompt as workerPrompt } from "./opencode.js";
import { ProcessWorkerSession } from "./process.js";

export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex" as const;

  async start(job: Job, context: string): Promise<WorkerSession> {
    const invocation = codexInvocation(job, context);
    return new ProcessWorkerSession(invocation.binary, invocation.args, {
      cwd: job.definition.workingDirectory,
      env: { ...process.env, RUNI_JOB_ID: job.id, RUNI_ATTEMPT: String(job.attempts) },
      shell: needsWindowsShell(invocation.binary),
    });
  }
}

export function codexInvocation(job: Job, context: string): { binary: string; args: string[] } {
  const args = ["exec", "--sandbox", "workspace-write", "--ask-for-approval", "never", "--color", "never", "--json"];
  if (job.definition.executor.model !== undefined) args.push("--model", job.definition.executor.model);
  args.push(workerPrompt(job, context));
  return { binary: job.definition.executor.binary ?? "codex", args };
}

import type { AgentAdapter, Job, WorkerSession } from "../domain.js";
import { needsWindowsShell, openCodePrompt as workerPrompt } from "./opencode.js";
import { ProcessWorkerSession } from "./process.js";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly kind = "claude" as const;

  async start(job: Job, context: string): Promise<WorkerSession> {
    const invocation = claudeCodeInvocation(job, context);
    return new ProcessWorkerSession(invocation.binary, invocation.args, {
      cwd: job.definition.workingDirectory,
      env: { ...process.env, RUNI_JOB_ID: job.id, RUNI_ATTEMPT: String(job.attempts) },
      shell: needsWindowsShell(invocation.binary),
    });
  }
}

export function claudeCodeInvocation(job: Job, context: string): { binary: string; args: string[] } {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--no-session-persistence"];
  if (job.definition.executor.model !== undefined) args.push("--model", job.definition.executor.model);
  args.push(workerPrompt(job, context));
  return { binary: job.definition.executor.binary ?? "claude", args };
}

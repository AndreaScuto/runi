import type { AgentAdapter, Job, WorkerSession } from "../domain.js";
import { ProcessWorkerSession } from "./process.js";

export class CommandAdapter implements AgentAdapter {
  readonly kind = "command" as const;

  async start(job: Job, context: string): Promise<WorkerSession> {
    const command = job.definition.executor.command;
    if (!command) throw new Error("The command adapter requires executor.command.");
    return new ProcessWorkerSession(command, [], {
      cwd: job.definition.workingDirectory,
      shell: true,
      env: {
        ...process.env,
        RUNI_JOB_ID: job.id,
        RUNI_GOAL: job.definition.goal,
        RUNI_CONTEXT: context,
        RUNI_ATTEMPT: String(job.attempts),
      },
    });
  }

  async resume(job: Job, context: string): Promise<WorkerSession> {
    return this.start(job, context);
  }
}

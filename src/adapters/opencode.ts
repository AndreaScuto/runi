import type { AgentAdapter, Job, WorkerSession } from "../domain.js";
import { ProcessWorkerSession } from "./process.js";

export class OpenCodeAdapter implements AgentAdapter {
  readonly kind = "opencode" as const;

  async start(job: Job, context: string): Promise<WorkerSession> {
    const binary = job.definition.executor.binary ?? "opencode";
    return new ProcessWorkerSession(binary, ["run", "--format", "json", this.prompt(job, context)], {
      cwd: job.definition.workingDirectory,
      env: { ...process.env, RUNI_JOB_ID: job.id, RUNI_ATTEMPT: String(job.attempts) },
    });
  }

  async resume(job: Job, context: string): Promise<WorkerSession> {
    return this.start(job, `${context}\n\nThis is a resumed durable job. Inspect the current repository before changing it.`);
  }

  private prompt(job: Job, context: string): string {
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
}

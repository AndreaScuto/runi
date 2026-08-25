import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentEvent, WorkerResult, WorkerSession } from "../domain.js";

class AsyncEventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    const next = this.waiting.shift();
    if (next) next({ value: item, done: false });
    else if (!this.closed) this.items.push(item);
  }

  close(): void {
    this.closed = true;
    while (this.waiting.length > 0) this.waiting.shift()!({ value: undefined as never, done: true });
  }

  async *iterate(): AsyncIterable<T> {
    while (true) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

function event(type: AgentEvent["type"], message: string, data?: Record<string, unknown>): AgentEvent {
  return { type, message, ...(data === undefined ? {} : { data }), createdAt: new Date().toISOString() };
}

export class ProcessWorkerSession implements WorkerSession {
  readonly pid?: number;
  readonly metadata: Record<string, unknown>;
  readonly result: Promise<WorkerResult>;
  private readonly queue = new AsyncEventQueue<AgentEvent>();
  private readonly child: ChildProcess;
  private readonly output: string[] = [];
  private stdoutBuffer = "";
  private stderrBuffer = "";

  constructor(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; shell?: boolean }) {
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (this.child.pid !== undefined) this.pid = this.child.pid;
    this.metadata = { sessionId: randomUUID(), command, args, ...(this.pid === undefined ? {} : { pid: this.pid }) };
    this.child.stdout?.on("data", (chunk: Buffer) => this.consume("stdout", chunk.toString()));
    this.child.stderr?.on("data", (chunk: Buffer) => this.consume("stderr", chunk.toString()));
    this.result = new Promise<WorkerResult>((resolve) => {
      this.child.once("error", (error) => {
        this.consume("stderr", error.message);
        this.finishBuffers();
        this.queue.close();
        resolve({ exitCode: -1, signal: null, output: this.output.join("\n") });
      });
      this.child.once("close", (exitCode, signal) => {
        this.finishBuffers();
        this.queue.close();
        resolve({ exitCode, signal, output: this.output.join("\n") });
      });
    });
  }

  events(): AsyncIterable<AgentEvent> {
    return this.queue.iterate();
  }

  async stop(): Promise<void> {
    if (!this.child.killed) this.child.kill("SIGTERM");
  }

  private consume(type: "stdout" | "stderr", text: string): void {
    const buffer = type === "stdout" ? this.stdoutBuffer + text : this.stderrBuffer + text;
    const lines = buffer.split(/\r?\n/);
    const remainder = lines.pop() ?? "";
    if (type === "stdout") this.stdoutBuffer = remainder;
    else this.stderrBuffer = remainder;
    for (const line of lines) this.emit(type, line);
  }

  private finishBuffers(): void {
    if (this.stdoutBuffer) this.emit("stdout", this.stdoutBuffer);
    if (this.stderrBuffer) this.emit("stderr", this.stderrBuffer);
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
  }

  private emit(type: "stdout" | "stderr", message: string): void {
    if (!message) return;
    this.output.push(message);
    this.queue.push(event(type, message));
  }
}

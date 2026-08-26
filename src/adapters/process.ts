import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter, on } from "node:events";
import type { AgentEvent, WorkerResult, WorkerSession } from "../domain.js";

function event(type: AgentEvent["type"], message: string): AgentEvent {
  return { type, message, createdAt: new Date().toISOString() };
}

export class ProcessWorkerSession implements WorkerSession {
  readonly pid?: number;
  readonly result: Promise<WorkerResult>;
  private readonly emitter = new EventEmitter();
  private readonly eventIterator = on(this.emitter, "event", { close: ["close"] });
  private readonly child: ChildProcess;
  private readonly output: string[] = [];
  private stdoutBuffer = "";
  private stderrBuffer = "";

  constructor(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; shell?: boolean }) {
    const windowsShim = options.shell === true;
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const spawnArgs = windowsShim ? args.map((arg) => arg.replace(/\r?\n/g, " ")) : args;
    this.child = windowsShim && args.length === 0
      ? spawn(command, { ...spawnOptions, shell: true })
      : spawn(windowsShim ? process.env.ComSpec ?? "cmd.exe" : command, windowsShim ? ["/d", "/s", "/c", command, ...spawnArgs] : spawnArgs, spawnOptions);
    if (this.child.pid !== undefined) this.pid = this.child.pid;
    this.child.stdout?.on("data", (chunk: Buffer) => this.consume("stdout", chunk.toString()));
    this.child.stderr?.on("data", (chunk: Buffer) => this.consume("stderr", chunk.toString()));
    this.result = new Promise<WorkerResult>((resolve) => {
      this.child.once("error", (error) => {
        this.consume("stderr", error.message);
        this.finishBuffers();
        this.emitter.emit("close");
        resolve({ exitCode: -1, signal: null, output: this.output.join("\n") });
      });
      this.child.once("close", (exitCode, signal) => {
        this.finishBuffers();
        this.emitter.emit("close");
        resolve({ exitCode, signal, output: this.output.join("\n") });
      });
    });
  }

  async *events(): AsyncIterable<AgentEvent> {
    for await (const [entry] of this.eventIterator) yield entry as AgentEvent;
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
    this.emitter.emit("event", event(type, message));
  }
}

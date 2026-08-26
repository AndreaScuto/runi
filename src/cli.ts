#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ClaudeCodeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { CommandAdapter } from "./adapters/command.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import { formatDuration } from "./budget.js";
import { now, type AgentAdapter, type Job } from "./domain.js";
import { RuniStore } from "./storage.js";
import { loadTaskDefinition, type StartOverrides } from "./task-file.js";
import { Supervisor } from "./supervisor.js";
import { createGuidedTask } from "./wizard.js";
import { createInteractiveUi, runInteractive, type InteractiveJob, type InteractiveUi } from "./interactive.js";
import { loadSettings, saveSettings, type RuniSettings } from "./settings.js";
import { CODING_AGENTS, diagnoseAgent, type AgentDiagnostic } from "./agents.js";

const CLI_OPTIONS = {
  agent: { type: "string" },
  binary: { type: "string" },
  command: { type: "string" },
  model: { type: "string" },
  "opencode-binary": { type: "string" },
  "opencode-model": { type: "string" },
  verify: { type: "string", multiple: true },
  "max-attempts": { type: "string" },
  "wall-time": { type: "string" },
  workdir: { type: "string" },
  help: { type: "boolean" },
  guided: { type: "boolean" },
  grill: { type: "boolean" },
} as const;

function parseArguments(argv: string[]) {
  return parseArgs({ args: argv, allowPositionals: true, options: CLI_OPTIONS });
}

type ParsedArguments = ReturnType<typeof parseArguments>;

function requirePositional(args: ParsedArguments, index: number, command: string): string {
  const value = args.positionals[index];
  if (!value) throw new Error(`Usage: ${command}`);
  return value;
}

function databasePath(workingDirectory: string): string {
  return join(workingDirectory, ".runi", "runi.db");
}

function supervisor(store: RuniStore): Supervisor {
  return new Supervisor(store, new Map<string, AgentAdapter>([
    ["opencode", new OpenCodeAdapter()],
    ["codex", new CodexAdapter()],
    ["claude", new ClaudeCodeAdapter()],
    ["command", new CommandAdapter()],
  ]));
}

function shortId(id: string): string {
  return id.slice(0, 14);
}

export function leoStatus(job: Job, at = Date.now()): string {
  const elapsed = at - Date.parse(job.startedAt ?? job.createdAt);
  return `🐕 Leo · supervising ${shortId(job.id)} · ${job.status.toUpperCase()} · attempt ${job.attempts}/${job.definition.budget.maxAttempts} · ${formatDuration(elapsed)}`;
}

async function superviseWithLeo(store: RuniStore, jobId: string): Promise<Job> {
  const line = () => leoStatus(store.requireJob(jobId));
  const running = supervisor(store).run(jobId);
  if (!process.stdout.isTTY) {
    console.log(line());
    return running;
  }
  const draw = () => process.stdout.write(`\r\x1b[2K${line()}`);
  draw();
  const timer = setInterval(draw, 250);
  timer.unref();
  try {
    return await running;
  } finally {
    clearInterval(timer);
    process.stdout.write("\r\x1b[2K");
  }
}

function printJob(job: Job): void {
  const elapsed = Date.now() - Date.parse(job.startedAt ?? job.createdAt);
  console.log(`\nJOB ${job.id}`);
  console.log(`Goal        ${job.definition.goal}`);
  console.log(`State       ${job.status.toUpperCase()}`);
  console.log(`Worker      ${job.definition.executor.kind}`);
  console.log(`Attempts    ${job.attempts} / ${job.definition.budget.maxAttempts}`);
  console.log(`Elapsed     ${formatDuration(elapsed)}`);
  if (job.definition.budget.wallTimeMs !== undefined) console.log(`Wall budget ${formatDuration(job.definition.budget.wallTimeMs)}`);
  if (job.exitReason) console.log(`Reason      ${job.exitReason}`);
}

function printLatestFailure(store: RuniStore, jobId: string): void {
  const events = store.getEvents(jobId, 20);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "WORKER_FAILED") continue;
    const detail = event.payload.detail;
    if (typeof detail === "string" && detail.trim()) console.log(`Last worker failure\n${detail.trim()}`);
    return;
  }
}

function help(): void {
  console.log(`Runi 0.2 — durable execution for coding agents

Usage:
  runi start <task.md|task.json> [options]
  runi start --guided "<job>" [options]
  runi start --grill "<job>" [options]
  runi status [job-id] [--workdir <dir>]
  runi inspect <job-id> [--workdir <dir>]
  runi logs <job-id> [--workdir <dir>]
  runi pause <job-id> [--workdir <dir>]
  runi resume <job-id> [--workdir <dir>]
  runi stop <job-id> [--workdir <dir>]
  runi settings [--workdir <dir>]
  runi doctor [--workdir <dir>]

Start options:
  --guided                      Prompt for settings and create a reusable task
  --grill                       AI-guided implementation choices and editable verification
  --agent <opencode|codex|claude|command>
                                 Worker adapter (default: opencode)
  --binary <path>                Coding-agent executable override
  --model <id>                   Coding-agent model override
  --command <command>            Command for the generic command adapter
  --verify <command>             Required verification command; repeatable
  --max-attempts <n>             Hard attempt budget
  --wall-time <duration>         Hard wall-time budget (for example: 90m)
  --workdir <dir>                Repository to supervise (default: current directory)

Interactive:
  Run \`runi\`, describe the job, or enter / to choose a slash command.
`);
}

function diagnosticChoice(diagnostic: AgentDiagnostic) {
  const detail = diagnostic.status === "READY"
    ? diagnostic.binary
    : `${diagnostic.status}: ${diagnostic.detail}`;
  return {
    value: diagnostic.agent,
    label: diagnostic.agent,
    ...(detail === undefined ? {} : { hint: detail }),
    ...(diagnostic.status === "READY" ? {} : { disabled: true }),
  };
}

async function agentDiagnostics(workingDirectory: string, current?: RuniSettings): Promise<AgentDiagnostic[]> {
  return Promise.all(CODING_AGENTS.map((agent) => diagnoseAgent(agent, {
    currentDirectory: workingDirectory,
    ...(current?.agent === agent && current.binary ? { binary: current.binary } : {}),
  })));
}

async function doctor(args: ParsedArguments): Promise<number> {
  const workingDirectory = resolve(args.values.workdir ?? process.cwd());
  const diagnostics = await agentDiagnostics(workingDirectory, loadSettings(workingDirectory));
  console.log("AGENT      STATUS                 EXECUTABLE / ACTION");
  for (const diagnostic of diagnostics) {
    const detail = diagnostic.binary ?? diagnostic.detail;
    console.log(`${diagnostic.agent.padEnd(10)} ${diagnostic.status.padEnd(22)} ${detail}`);
    if (diagnostic.status !== "READY" && diagnostic.binary) console.log(`${"".padEnd(33)} ${diagnostic.detail}`);
  }
  console.log("\nRuni uses each CLI's existing login. It never reads or stores API keys.");
  return 0;
}

async function guidedTask(goal: string, workingDirectory: string, grill: boolean, ui?: InteractiveUi): Promise<string> {
  const defaults = loadSettings(workingDirectory);
  if (ui) {
    const ask = async (question: string): Promise<string> => {
      const answer = await ui.input(question.replace(/:\s*$/, ""));
      if (answer === undefined) throw new Error("Interactive task creation cancelled.");
      return answer;
    };
    const path = await createGuidedTask(goal, workingDirectory, ask, {
      grill,
      defaults,
      choose: async (question, options, initialValue) => {
        const answer = await ui.choose(question, options.map((value) => ({ value, label: value })), initialValue);
        if (answer === undefined) throw new Error("Interactive task creation cancelled.");
        return answer;
      },
    });
    console.log(`Saved reusable task to ${path}.`);
    return path;
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  try {
    const path = await createGuidedTask(goal, workingDirectory, async (question) => {
      process.stdout.write(question);
      const answer = await iterator.next();
      if (answer.done) throw new Error("Interactive input ended before the task was complete.");
      return answer.value;
    }, { grill, defaults });
    console.log(`Saved reusable task to ${path}.`);
    return path;
  } finally {
    lines.close();
  }
}

async function settings(args: ParsedArguments, ui?: InteractiveUi): Promise<number> {
  const workingDirectory = resolve(args.values.workdir ?? process.cwd());
  const prompt = ui ?? createInteractiveUi();
  const ownsPrompt = ui === undefined;
  const current = loadSettings(workingDirectory);
  const choose = async (message: string, values: readonly string[], initial: string): Promise<string> => {
    const answer = await prompt.choose(message, values.map((value) => ({ value, label: value })), initial);
    if (answer === undefined) throw new Error("Settings cancelled.");
    return answer;
  };
  try {
    const diagnostics = await agentDiagnostics(workingDirectory, current);
    const choices = [
      ...diagnostics.map(diagnosticChoice),
      { value: "command", label: "command", hint: "Run any installed CLI or local command" },
    ];
    const ready = new Set(diagnostics.filter((diagnostic) => diagnostic.status === "READY").map((diagnostic) => diagnostic.agent));
    const initial = current.agent === "command" || ready.has(current.agent as typeof CODING_AGENTS[number])
      ? current.agent
      : diagnostics.find((diagnostic) => diagnostic.status === "READY")?.agent ?? "command";
    const selected = await prompt.choose("Default worker agent", choices, initial);
    if (selected === undefined) throw new Error("Settings cancelled.");
    const agent = selected as RuniSettings["agent"];
    const next: RuniSettings = {
      agent,
      maxAttempts: current.maxAttempts,
      wallTime: current.wallTime,
      verificationPolicy: current.verificationPolicy,
    };
    if (agent === "command") {
      const command = await prompt.input("Default worker command", current.command ?? "Required for command jobs");
      if (!command) throw new Error("A default worker command is required.");
      next.command = command;
      next.verificationPolicy = "manual";
    } else {
      const model = await prompt.input("Default model (blank uses agent default)", current.agent === agent ? current.model : undefined);
      if (model) next.model = model;
      const diagnostic = diagnostics.find((entry) => entry.agent === agent);
      if (diagnostic?.status !== "READY" || !diagnostic.binary) throw new Error(`${agent} is not ready: ${diagnostic?.detail ?? "executable unavailable"}`);
      next.binary = diagnostic.binary;
    }
    const attempt = await choose("Default maximum attempts", ["1", "2", "3", "5", "Custom…"], String(current.maxAttempts));
    next.maxAttempts = Number(attempt === "Custom…" ? await prompt.input("Maximum attempts", String(current.maxAttempts)) : attempt);
    if (!Number.isInteger(next.maxAttempts) || next.maxAttempts < 1) throw new Error("Maximum attempts must be a positive integer.");
    const wall = await choose("Default wall-time budget", ["30m", "1h", "2h", "4h", "8h", "Custom…"], current.wallTime);
    next.wallTime = wall === "Custom…" ? await prompt.input("Wall-time budget", current.wallTime) ?? "" : wall;
    if (!next.wallTime) throw new Error("Wall-time budget is required.");
    if (agent !== "command") next.verificationPolicy = await choose("Default verification policy", ["manual", "ai"], current.verificationPolicy) as RuniSettings["verificationPolicy"];
    const path = saveSettings(workingDirectory, next);
    prompt.info(`Agent ${next.agent} · attempts ${next.maxAttempts} · wall time ${next.wallTime}\n${path}`, "Defaults saved");
    return 0;
  } finally {
    if (ownsPrompt) prompt.close();
  }
}

async function start(args: ParsedArguments, ui?: InteractiveUi): Promise<number> {
  const taskOrGoal = requirePositional(args, 1, "runi start <task.md|task.json> | runi start --guided|--grill \"<job>\"");
  const workingDirectory = resolve(args.values.workdir ?? process.cwd());
  if (!existsSync(workingDirectory)) throw new Error(`Working directory does not exist: ${workingDirectory}`);
  const guided = args.values.guided === true || args.values.grill === true;
  const task = guided ? await guidedTask(taskOrGoal, workingDirectory, args.values.grill === true, ui) : taskOrGoal;
  const maxAttemptsText = args.values["max-attempts"];
  const parsedAttempts = maxAttemptsText === undefined ? undefined : Number(maxAttemptsText);
  if (parsedAttempts !== undefined && (!Number.isInteger(parsedAttempts) || parsedAttempts < 1)) {
    throw new Error("--max-attempts must be a positive integer.");
  }
  const overrides: StartOverrides = { workingDirectory };
  const agent = args.values.agent;
  const command = args.values.command;
  const binary = args.values.binary ?? args.values["opencode-binary"];
  const model = args.values.model ?? args.values["opencode-model"];
  const verification = args.values.verify;
  const wallTime = args.values["wall-time"];
  if (agent !== undefined) overrides.agent = agent;
  if (command !== undefined) overrides.command = command;
  if (binary !== undefined) overrides.binary = binary;
  if (model !== undefined) overrides.model = model;
  if (verification !== undefined) overrides.verification = verification;
  if (parsedAttempts !== undefined) overrides.maxAttempts = parsedAttempts;
  if (wallTime !== undefined) overrides.wallTime = wallTime;
  const definition = await loadTaskDefinition(task, overrides);
  const store = new RuniStore(databasePath(workingDirectory));
  try {
    const timestamp = now();
    const job: Job = {
      id: `rn_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      status: "created",
      definition,
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    store.createJob(job);
    console.log(`Started durable job ${job.id}. State is persisted in ${databasePath(workingDirectory)}.`);
    const completed = await superviseWithLeo(store, job.id);
    printJob(completed);
    if (completed.status !== "complete") printLatestFailure(store, completed.id);
    return completed.status === "complete" ? 0 : 1;
  } finally {
    store.close();
  }
}

function openStore(args: ParsedArguments): RuniStore {
  const workingDirectory = resolve(args.values.workdir ?? process.cwd());
  return new RuniStore(databasePath(workingDirectory));
}

async function resume(args: ParsedArguments): Promise<number> {
  const jobId = requirePositional(args, 1, "runi resume <job-id>");
  const store = openStore(args);
  try {
    const job = store.resumeJob(jobId);
    console.log(`Resuming ${job.id} from ${job.status}.`);
    const completed = await superviseWithLeo(store, job.id);
    printJob(completed);
    if (completed.status !== "complete") printLatestFailure(store, completed.id);
    return completed.status === "complete" ? 0 : 1;
  } finally {
    store.close();
  }
}

function status(args: ParsedArguments): number {
  const store = openStore(args);
  try {
    const jobId = args.positionals[1];
    if (jobId) {
      printJob(store.requireJob(jobId));
      return 0;
    }
    const jobs = store.listJobs();
    if (jobs.length === 0) {
      console.log("No Runi jobs found.");
      return 0;
    }
    console.log("ID             STATE              ATTEMPTS  GOAL");
    for (const job of jobs) {
      console.log(`${shortId(job.id).padEnd(14)} ${job.status.padEnd(18)} ${`${job.attempts}/${job.definition.budget.maxAttempts}`.padEnd(9)} ${job.definition.goal}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

function inspect(args: ParsedArguments): number {
  const jobId = requirePositional(args, 1, "runi inspect <job-id>");
  const store = openStore(args);
  try {
    const job = store.requireJob(jobId);
    printJob(job);
    console.log("\nCompletion contract");
    if (job.definition.verification.length === 0) console.log("  No verification commands configured (completion cannot be evidence-backed).");
    for (const check of job.definition.verification) console.log(`  - ${check.label ?? check.command}: ${check.command}`);
    console.log("\nVerification history");
    const results = store.getVerificationResults(job.id);
    if (results.length === 0) console.log("  No checks run yet.");
    for (const result of results) {
      console.log(`  ${result.phase.padEnd(8)} ${result.exitCode === 0 && !result.timedOut ? "PASS" : "FAIL"} ${result.label}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

function logs(args: ParsedArguments): number {
  const jobId = requirePositional(args, 1, "runi logs <job-id>");
  const store = openStore(args);
  try {
    for (const event of store.getEvents(jobId, 500)) {
      const payload = Object.keys(event.payload).length === 0 ? "" : ` ${JSON.stringify(event.payload)}`;
      console.log(`${event.sequence.toString().padStart(6, "0")} ${event.createdAt} ${event.type}${payload}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

function pause(args: ParsedArguments): number {
  const jobId = requirePositional(args, 1, "runi pause <job-id>");
  const store = openStore(args);
  try {
    printJob(store.pauseJob(jobId));
    return 0;
  } finally {
    store.close();
  }
}

function stop(args: ParsedArguments): number {
  const jobId = requirePositional(args, 1, "runi stop <job-id>");
  const store = openStore(args);
  try {
    printJob(store.cancelJob(jobId));
    return 0;
  } finally {
    store.close();
  }
}

export async function run(argv: string[], ui?: InteractiveUi): Promise<number> {
  const args = parseArguments(argv);
  const command = args.positionals[0];
  if (command === "help" || args.values.help === true) {
    help();
    return 0;
  }
  if (command === undefined) return home();
  if (command === "start") return start(args, ui);
  if (command === "status") return status(args);
  if (command === "inspect") return inspect(args);
  if (command === "logs") return logs(args);
  if (command === "pause") return pause(args);
  if (command === "resume") return resume(args);
  if (command === "stop") return stop(args);
  if (command === "settings") return settings(args, ui);
  if (command === "doctor") return doctor(args);
  throw new Error(`Unknown command: ${command}`);
}

async function home(): Promise<number> {
  const jobs = (): InteractiveJob[] => {
    const store = new RuniStore(databasePath(process.cwd()));
    try {
      return store.listJobs().map((job) => ({
        id: job.id,
        label: `${job.status.toUpperCase()} · ${job.definition.goal}`,
        hint: shortId(job.id),
      }));
    } finally {
      store.close();
    }
  };
  return runInteractive({ dispatch: (argv, interactiveUi) => run(argv, interactiveUi), jobs }, createInteractiveUi());
}

function isDirectExecution(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    // Package managers can invoke the bin through a symlink. Compare canonical paths,
    // rather than URL strings, so the installed CLI behaves like the workspace copy.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  run(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      console.error(`runi: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}

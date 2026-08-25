import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDuration } from "./budget.js";
import { ProcessWorkerSession } from "./adapters/process.js";
import { needsWindowsShell } from "./adapters/opencode.js";
import type { AgentKind, ExecutorConfig } from "./domain.js";

export type Ask = (question: string) => Promise<string>;

const AGENTS = new Set<AgentKind>(["opencode", "codex", "claude", "command"]);

interface GuidedTaskOptions {
  grill?: boolean;
}

interface GrillQuestion {
  question: string;
  options: string[];
}

async function chooseAgent(ask: Ask): Promise<AgentKind> {
  while (true) {
    const answer = (await ask("Worker agent [opencode|codex|claude|command] (opencode): ")).trim() || "opencode";
    if (AGENTS.has(answer as AgentKind)) return answer as AgentKind;
  }
}

async function required(ask: Ask, question: string): Promise<string> {
  while (true) {
    const answer = (await ask(question)).trim();
    if (answer) return answer;
  }
}

async function attempts(ask: Ask): Promise<number> {
  while (true) {
    const answer = (await ask("Maximum attempts (3): ")).trim() || "3";
    const value = Number(answer);
    if (Number.isInteger(value) && value > 0) return value;
  }
}

async function wallTime(ask: Ask): Promise<string> {
  while (true) {
    const answer = (await ask("Wall-time budget (4h): ")).trim() || "4h";
    try {
      parseDuration(answer);
      return answer;
    } catch {
      // Ask again with the same compact prompt.
    }
  }
}

async function manualVerification(ask: Ask): Promise<string[]> {
  const commands: string[] = [];
  while (true) {
    const command = (await ask(commands.length === 0
      ? "Verification command (required): "
      : "Add another verification command (blank to finish): ")).trim();
    if (!command && commands.length > 0) return commands;
    if (command) commands.push(command);
  }
}

function collectStrings(value: unknown, strings: string[]): void {
  if (typeof value === "string") strings.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, strings);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, strings);
  }
}

function markedJson(output: string, marker: string): unknown {
  const strings = [output];
  for (const line of output.split(/\r?\n/)) {
    try {
      collectStrings(JSON.parse(line) as unknown, strings);
    } catch {
      // Provider output can mix JSON events with plain text.
    }
  }
  for (const text of strings) {
    for (const line of text.split(/\r?\n/)) {
      const index = line.indexOf(`${marker}=`);
      if (index < 0) continue;
      try {
        return JSON.parse(line.slice(index + marker.length + 1));
      } catch {
        // Keep looking in case an earlier provider event contained a partial response.
      }
    }
  }
  throw new Error(`AI response did not contain valid ${marker} JSON.`);
}

function grillQuestions(output: string): GrillQuestion[] {
  const value = markedJson(output, "RUNI_GRILL");
  if (!Array.isArray(value)) throw new Error("AI grill response must be an array.");
  const questions = value.slice(0, 6).map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("Invalid AI grill question.");
    const { question, options } = item as { question?: unknown; options?: unknown };
    if (typeof question !== "string" || !question.trim() || !Array.isArray(options)) throw new Error("Invalid AI grill question.");
    const choices = options.filter((option): option is string => typeof option === "string" && option.trim().length > 0).slice(0, 5);
    if (choices.length < 2) throw new Error("AI grill questions require at least two options.");
    return { question: question.trim(), options: choices };
  });
  if (questions.length === 0) throw new Error("AI did not provide grill questions.");
  return questions;
}

function verificationSuggestions(output: string): string[] {
  const value = markedJson(output, "RUNI_VERIFICATION");
  if (!Array.isArray(value)) throw new Error("AI verification response must be an array.");
  const commands = value.filter((command): command is string => typeof command === "string" && command.trim().length > 0)
    .map((command) => command.trim()).slice(0, 10);
  if (commands.length === 0) throw new Error("AI did not provide verification commands.");
  return commands;
}

function analysisInvocation(executor: ExecutorConfig, prompt: string): { binary: string; args: string[]; env: NodeJS.ProcessEnv } {
  const model = executor.model === undefined ? [] : ["--model", executor.model];
  if (executor.kind === "opencode") {
    return {
      binary: executor.binary ?? "opencode",
      args: ["run", "--format", "json", "--agent", "explore", ...model, prompt],
      env: {
        ...process.env,
        OPENCODE_PERMISSION: JSON.stringify({ "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow" }),
      },
    };
  }
  if (executor.kind === "codex") {
    return {
      binary: executor.binary ?? "codex",
      args: ["exec", "--sandbox", "read-only", "--ask-for-approval", "never", "--color", "never", "--json", ...model, prompt],
      env: { ...process.env },
    };
  }
  if (executor.kind === "claude") {
    return {
      binary: executor.binary ?? "claude",
      args: ["-p", "--output-format", "json", "--permission-mode", "plan", "--no-session-persistence", "--disallowedTools", "Edit", "Write", "NotebookEdit", "Bash", ...model, prompt],
      env: { ...process.env },
    };
  }
  throw new Error("AI guidance requires OpenCode, Codex, or Claude Code.");
}

async function askAgent(executor: ExecutorConfig, workingDirectory: string, prompt: string): Promise<string> {
  const invocation = analysisInvocation(executor, prompt);
  const session = new ProcessWorkerSession(invocation.binary, invocation.args, {
    cwd: workingDirectory,
    env: invocation.env,
    shell: needsWindowsShell(invocation.binary),
  });
  const result = await session.result;
  if (result.exitCode !== 0) throw new Error(`AI guidance failed with exit code ${result.exitCode}.`);
  return result.output;
}

async function grillGoal(goal: string, executor: ExecutorConfig, workingDirectory: string, ask: Ask): Promise<string> {
  const output = await askAgent(executor, workingDirectory, [
    "Inspect this repository without modifying it. Turn the short job into 2-5 high-value implementation questions.",
    "Each question must offer 2-4 concrete, mutually exclusive implementation choices.",
    `Job: ${goal}`,
    "Return exactly one line and no Markdown: RUNI_GRILL=[{\"question\":\"...\",\"options\":[\"...\",\"...\"]}]",
  ].join("\n"));
  const decisions: string[] = [];
  for (const item of grillQuestions(output)) {
    const choices = item.options.map((option, index) => `  ${index + 1}) ${option}`).join("\n");
    const answer = (await ask(`${item.question}\n${choices}\nChoice (number or custom answer, 1): `)).trim();
    const selected = answer === "" ? item.options[0]! : Number.isInteger(Number(answer)) && Number(answer) >= 1 && Number(answer) <= item.options.length
      ? item.options[Number(answer) - 1]!
      : answer;
    decisions.push(`- ${item.question}: ${selected}`);
  }
  return `Original job:\n${goal}\n\nImplementation decisions:\n${decisions.join("\n")}`;
}

async function editSuggestions(ask: Ask, suggestions: string[]): Promise<string[]> {
  const commands: string[] = [];
  for (const [index, suggestion] of suggestions.entries()) {
    const answer = (await ask(`${index === 0 ? "AI verification suggestions\n" : ""}${index + 1}. ${suggestion}\nEdit (blank keeps it, - removes it): `)).trim();
    if (answer !== "-") commands.push(answer || suggestion);
  }
  while (true) {
    const command = (await ask("Add verification command (blank to finish): ")).trim();
    if (!command) break;
    commands.push(command);
  }
  return commands.length > 0 ? commands : manualVerification(ask);
}

async function verificationPolicy(goal: string, executor: ExecutorConfig, workingDirectory: string, ask: Ask): Promise<string[]> {
  while (true) {
    const source = (await ask(`Verification policy [manual${executor.kind === "command" ? "" : "|ai"}] (manual): `)).trim() || "manual";
    if (source === "manual") return manualVerification(ask);
    if (source !== "ai" || executor.kind === "command") continue;
    try {
      const output = await askAgent(executor, workingDirectory, [
        "Inspect this repository without modifying it. Suggest deterministic, non-destructive commands that independently verify the job.",
        "Use existing local project tools, avoid network calls and AI-based checks, and return only commands that can run from the repository root.",
        `Job:\n${goal}`,
        "Return exactly one line and no Markdown: RUNI_VERIFICATION=[\"command 1\",\"command 2\"]",
      ].join("\n"));
      return editSuggestions(ask, verificationSuggestions(output));
    } catch (error) {
      await ask(`AI suggestion unavailable: ${error instanceof Error ? error.message : String(error)} Press Enter for manual verification: `);
      return manualVerification(ask);
    }
  }
}

export async function createGuidedTask(goal: string, workingDirectory: string, ask: Ask, options: GuidedTaskOptions = {}): Promise<string> {
  const agent = await chooseAgent(ask);
  if (options.grill === true && agent === "command") throw new Error("Grill mode requires OpenCode, Codex, or Claude Code.");
  const executor: ExecutorConfig = { kind: agent };
  if (agent === "command") {
    executor.command = await required(ask, "Worker command: ");
  } else {
    const binary = (await ask(`Executable override (${agent}): `)).trim();
    const model = (await ask("Model override (agent default): ")).trim();
    if (binary) executor.binary = binary;
    if (model) executor.model = model;
  }
  const refinedGoal = options.grill === true ? await grillGoal(goal, executor, workingDirectory, ask) : goal;
  const budget = { maxAttempts: await attempts(ask), wallTime: await wallTime(ask) };
  const verification = await verificationPolicy(refinedGoal, executor, workingDirectory, ask);
  const directory = join(workingDirectory, ".runi", "tasks");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `guided-${randomUUID()}.json`);
  await writeFile(path, `${JSON.stringify({ goal: refinedGoal, executor, verification, budget }, null, 2)}\n`, "utf8");
  return path;
}

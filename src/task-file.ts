import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { AgentKind, Budget, ExecutorConfig, TaskDefinition, VerificationCommand } from "./domain.js";
import { parseDuration } from "./budget.js";

export interface StartOverrides {
  agent?: string;
  command?: string;
  binary?: string;
  model?: string;
  verification?: string[];
  maxAttempts?: number;
  wallTime?: string;
  workingDirectory?: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireGoal(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Task configuration requires a non-empty `goal`.");
  }
  return value.trim();
}

function parseAgent(value: unknown): AgentKind {
  if (value === undefined) return "opencode";
  if (value === "opencode" || value === "command") return value;
  throw new Error("executor.kind must be `opencode` or `command`.");
}

function parseVerification(value: unknown): VerificationCommand[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("verification must be an array of commands.");
  return value.map((item, index) => {
    if (typeof item === "string" && item.trim()) return { command: item.trim() };
    if (!isRecord(item) || typeof item.command !== "string" || !item.command.trim()) {
      throw new Error(`verification[${index}] must be a command string or { command, label?, timeoutMs? }.`);
    }
    if (item.label !== undefined && typeof item.label !== "string") throw new Error(`verification[${index}].label must be a string.`);
    if (item.timeoutMs !== undefined && (typeof item.timeoutMs !== "number" || item.timeoutMs <= 0)) {
      throw new Error(`verification[${index}].timeoutMs must be a positive number.`);
    }
    return {
      command: item.command.trim(),
      ...(typeof item.label === "string" ? { label: item.label } : {}),
      ...(typeof item.timeoutMs === "number" ? { timeoutMs: item.timeoutMs } : {}),
    };
  });
}

function parseBudget(value: unknown): Budget {
  if (value === undefined) return { maxAttempts: 3, wallTimeMs: 4 * 60 * 60_000 };
  if (!isRecord(value)) throw new Error("budget must be an object.");
  const maxAttempts = value.maxAttempts ?? value.attempts ?? 3;
  if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("budget.maxAttempts must be a positive integer.");
  }
  const rawWallTime = value.wallTimeMs ?? value.wallTime;
  let wallTimeMs: number | undefined;
  if (rawWallTime !== undefined) {
    if (typeof rawWallTime === "number" && rawWallTime > 0) wallTimeMs = rawWallTime;
    else if (typeof rawWallTime === "string") wallTimeMs = parseDuration(rawWallTime);
    else throw new Error("budget.wallTime must be a duration string or budget.wallTimeMs a positive number.");
  }
  return { maxAttempts, ...(wallTimeMs === undefined ? {} : { wallTimeMs }) };
}

function parseExecutor(value: unknown): ExecutorConfig {
  if (value === undefined) return { kind: "opencode" };
  if (!isRecord(value)) throw new Error("executor must be an object.");
  const kind = parseAgent(value.kind ?? value.agent);
  if (value.command !== undefined && typeof value.command !== "string") throw new Error("executor.command must be a string.");
  if (value.binary !== undefined && typeof value.binary !== "string") throw new Error("executor.binary must be a string.");
  if (value.model !== undefined && typeof value.model !== "string") throw new Error("executor.model must be a string.");
  if (value.autoApprove !== undefined && typeof value.autoApprove !== "boolean") throw new Error("executor.autoApprove must be a boolean.");
  if (kind === "command" && (typeof value.command !== "string" || !value.command.trim())) {
    throw new Error("executor.command is required when executor.kind is `command`.");
  }
  return {
    kind,
    ...(typeof value.command === "string" ? { command: value.command } : {}),
    ...(typeof value.binary === "string" ? { binary: value.binary } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.autoApprove === "boolean" ? { autoApprove: value.autoApprove } : {}),
  };
}

function markdownGoal(contents: string): string {
  const heading = /^#\s+(.+)$/m.exec(contents)?.[1]?.trim();
  return heading || contents.trim();
}

export async function loadTaskDefinition(taskPath: string, overrides: StartOverrides = {}): Promise<TaskDefinition> {
  const absoluteTaskPath = resolve(taskPath);
  const contents = await readFile(absoluteTaskPath, "utf8");
  const source: UnknownRecord = extname(absoluteTaskPath).toLowerCase() === ".json"
    ? parseJsonTask(contents, absoluteTaskPath)
    : { goal: markdownGoal(contents) };

  const sourceExecutor = parseExecutor(source.executor);
  const agent = overrides.agent === undefined ? sourceExecutor.kind : parseAgent(overrides.agent);
  const command = overrides.command ?? sourceExecutor.command;
  const binary = overrides.binary ?? sourceExecutor.binary;
  const model = overrides.model ?? sourceExecutor.model;
  const executor: ExecutorConfig = {
    kind: agent,
    ...(command === undefined ? {} : { command }),
    ...(binary === undefined ? {} : { binary }),
    ...(model === undefined ? {} : { model }),
    ...(sourceExecutor.autoApprove === undefined ? {} : { autoApprove: sourceExecutor.autoApprove }),
  };
  if (executor.kind === "command" && !executor.command) throw new Error("--command is required for the command adapter.");

  const sourceBudget = parseBudget(source.budget);
  const maxAttempts = overrides.maxAttempts ?? sourceBudget.maxAttempts;
  const wallTimeMs = overrides.wallTime === undefined ? sourceBudget.wallTimeMs : parseDuration(overrides.wallTime);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("--max-attempts must be a positive integer.");
  const verification = overrides.verification === undefined ? parseVerification(source.verification) : overrides.verification.map((command) => ({ command }));
  if (verification.length === 0) {
    throw new Error("A Runi task requires at least one verification command. Add `verification` to task JSON or pass --verify.");
  }

  return {
    goal: requireGoal(source.goal),
    taskPath: absoluteTaskPath,
    workingDirectory: resolve(overrides.workingDirectory ?? process.cwd()),
    executor,
    verification,
    budget: { maxAttempts, ...(wallTimeMs === undefined ? {} : { wallTimeMs }) },
  };
}

function parseJsonTask(contents: string, sourcePath: string): UnknownRecord {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isRecord(parsed)) throw new Error("root must be an object");
    return parsed;
  } catch (error) {
    throw new Error(`Cannot parse task file ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

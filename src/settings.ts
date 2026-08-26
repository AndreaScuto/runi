import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDuration } from "./budget.js";
import type { AgentKind } from "./domain.js";

export interface RuniSettings {
  agent: AgentKind;
  model?: string;
  binary?: string;
  command?: string;
  maxAttempts: number;
  wallTime: string;
  verificationPolicy: "manual" | "ai";
}

export const DEFAULT_RUNI_SETTINGS: RuniSettings = {
  agent: "opencode",
  maxAttempts: 3,
  wallTime: "4h",
  verificationPolicy: "manual",
};

const AGENTS = new Set<AgentKind>(["opencode", "codex", "claude", "command"]);

function pathFor(workingDirectory: string): string {
  return join(workingDirectory, ".runi", "settings.json");
}

export function loadSettings(workingDirectory: string): RuniSettings {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(pathFor(workingDirectory), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_RUNI_SETTINGS };
    throw new Error(`Cannot read Runi settings: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Runi settings must be a JSON object.");
  const input = value as Partial<RuniSettings>;
  const settings: RuniSettings = {
    agent: AGENTS.has(input.agent as AgentKind) ? input.agent as AgentKind : DEFAULT_RUNI_SETTINGS.agent,
    maxAttempts: Number.isInteger(input.maxAttempts) && (input.maxAttempts ?? 0) > 0 ? input.maxAttempts! : DEFAULT_RUNI_SETTINGS.maxAttempts,
    wallTime: DEFAULT_RUNI_SETTINGS.wallTime,
    verificationPolicy: input.verificationPolicy === "ai" ? "ai" : "manual",
  };
  if (typeof input.wallTime === "string") {
    try {
      parseDuration(input.wallTime);
      settings.wallTime = input.wallTime;
    } catch {
      // Invalid hand-edited values fall back to the safe default.
    }
  }
  for (const key of ["model", "binary", "command"] as const) {
    const text = input[key];
    if (typeof text === "string" && text.trim()) settings[key] = text.trim();
  }
  if (settings.agent === "command") settings.verificationPolicy = "manual";
  return settings;
}

export function saveSettings(workingDirectory: string, settings: RuniSettings): string {
  const path = pathFor(workingDirectory);
  mkdirSync(join(workingDirectory, ".runi"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return path;
}

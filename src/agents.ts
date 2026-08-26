import { existsSync, statSync } from "node:fs";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { ProcessWorkerSession } from "./adapters/process.js";

export const CODING_AGENTS = ["opencode", "codex", "claude"] as const;
export type CodingAgent = typeof CODING_AGENTS[number];
export type AgentStatus = "READY" | "NOT FOUND" | "NOT AUTHENTICATED" | "NOT EXECUTABLE";

export interface AgentDiagnostic {
  agent: CodingAgent;
  status: AgentStatus;
  binary?: string;
  detail: string;
}

export interface ProbeResult {
  exitCode: number | null;
  output: string;
  errorCode?: string;
}

export type AgentProbe = (binary: string, args: string[]) => Promise<ProbeResult>;

/** Windows package-manager shims need cmd.exe; native executables do not. */
export function needsWindowsShell(binary: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(binary);
}

interface DiscoveryEnvironment {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  currentDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DiagnoseAgentOptions extends DiscoveryEnvironment {
  binary?: string;
  candidates?: string[];
  probe?: AgentProbe;
}

function pathValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function unique(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  return values.filter((value): value is string => {
    if (!value) return false;
    const key = process.platform === "win32" ? value.toLowerCase() : value;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Returns ordered candidate paths without touching the filesystem, so discovery rules are portable and testable. */
export function executableCandidates(name: string, options: DiscoveryEnvironment = {}): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const cwd = options.currentDirectory ?? process.cwd();
  const path = platform === "win32" ? win32 : posix;
  const hasPath = path.isAbsolute(name) || name.includes("/") || name.includes("\\");
  const directories: Array<string | undefined> = hasPath
    ? [path.dirname(path.resolve(cwd, name))]
    : pathValue(env).split(platform === "win32" ? ";" : ":");
  if (!hasPath && platform === "win32") {
    directories.push(
      env.APPDATA && path.join(env.APPDATA, "npm"),
      env.PNPM_HOME,
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "pnpm"),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"),
      env.NVM_SYMLINK,
      home && path.join(home, ".local", "bin"),
    );
  } else if (!hasPath) {
    directories.push(
      env.PNPM_HOME,
      env.npm_config_prefix && path.join(env.npm_config_prefix, "bin"),
      path.join(home, ".local", "bin"),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      ...(platform === "darwin" ? ["/opt/homebrew/bin"] : []),
    );
  }
  const base = hasPath ? path.basename(path.resolve(cwd, name)) : name;
  const extensions = platform === "win32" && !path.extname(base)
    ? unique((env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((extension) => extension.trim().toLowerCase()))
    : [""];
  return unique(directories.map((directory) => directory && path.resolve(directory, base)).flatMap((candidate) =>
    extensions.map((extension) => `${candidate}${extension}`)));
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveExecutable(name: string, options: DiscoveryEnvironment = {}): string | undefined {
  return executableCandidates(name, options).find(isFile);
}

async function defaultProbe(binary: string, args: string[]): Promise<ProbeResult> {
  const session = new ProcessWorkerSession(binary, args, {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: "1" },
    shell: needsWindowsShell(binary),
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      session.result,
      new Promise<undefined>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(undefined), 8_000);
        timer.unref();
      }),
    ]);
    if (result === undefined) {
      await session.stop();
      return { exitCode: null, output: "Probe timed out after 8 seconds.", errorCode: "ETIMEDOUT" };
    }
    const errorCode = result.exitCode === -1 ? result.output.match(/\b(?:EACCES|ENOENT|EPERM)\b/)?.[0] : undefined;
    return { exitCode: result.exitCode, output: result.output, ...(errorCode === undefined ? {} : { errorCode }) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function authArguments(agent: CodingAgent): string[] {
  if (agent === "opencode") return ["auth", "list"];
  if (agent === "codex") return ["login", "status"];
  return ["auth", "status"];
}

function agentProcess(binary: string, args: string[], options: { cwd: string; stdio: "inherit" | "pipe" }): ChildProcess {
  const stdio: SpawnOptions["stdio"] = options.stdio === "inherit" ? "inherit" : ["pipe", "pipe", "pipe"];
  return needsWindowsShell(binary)
    ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", binary, ...args], { cwd: options.cwd, env: process.env, windowsHide: true, stdio })
    : spawn(binary, args, { cwd: options.cwd, env: process.env, windowsHide: true, stdio });
}

/** Launches the selected CLI's own login flow. Credentials remain owned by that CLI. */
export async function authenticateAgent(agent: CodingAgent, binary: string, workingDirectory: string): Promise<void> {
  const child = agentProcess(binary, agent === "codex" ? ["login"] : ["auth", "login"], { cwd: workingDirectory, stdio: "inherit" });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) throw new Error(`${agent} authentication ended with exit code ${exitCode ?? "unknown"}.`);
}

async function codexModels(binary: string, workingDirectory: string): Promise<string[]> {
  const child = agentProcess(binary, ["app-server", "--stdio"], { cwd: workingDirectory, stdio: "pipe" });
  return new Promise((resolveModels) => {
    let buffer = "";
    let finished = false;
    const finish = (models: string[] = []) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (child.exitCode !== null) resolveModels(models);
      else {
        child.once("close", () => resolveModels(models));
        child.kill();
      }
    };
    const consume = (text: string) => {
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { id?: number; result?: { data?: Array<{ model?: unknown; id?: unknown }> } };
          if (message.id === 1) child.stdin?.write(`${JSON.stringify({ id: 2, method: "model/list", params: { includeHidden: false } })}\n`);
          if (message.id === 2) finish((message.result?.data ?? [])
            .map((model) => typeof model.model === "string" ? model.model : typeof model.id === "string" ? model.id : "")
            .filter(Boolean));
        } catch {
          // Ignore diagnostics and notifications; only JSON-RPC responses matter.
        }
      }
    };
    const timer = setTimeout(() => finish(), 12_000);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => consume(chunk.toString()));
    child.once("error", () => finish());
    child.once("close", () => finish());
    child.stdin?.write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "runi", version: "0.2.0" } } })}\n`);
  });
}

/** Retrieves models from the installed CLI when it exposes a machine-readable catalog. */
export async function listAgentModels(agent: CodingAgent, binary: string, workingDirectory: string, probe: AgentProbe = defaultProbe): Promise<string[]> {
  if (agent === "codex") return codexModels(binary, workingDirectory);
  if (agent !== "opencode") return [];
  try {
    const result = await probe(binary, ["models"]);
    if (result.exitCode !== 0) return [];
    return unique(result.output.split(/\r?\n/).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim())
      .filter((line) => line.length > 0 && line.length < 160 && !/\s/.test(line)));
  } catch {
    return [];
  }
}

function firstLine(output: string): string | undefined {
  const line = output.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  return line?.slice(0, 160);
}

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return code && !error.message.includes(code) ? `${code}: ${error.message}` : error.message;
}

export async function diagnoseAgent(agent: CodingAgent, options: DiagnoseAgentOptions = {}): Promise<AgentDiagnostic> {
  const discovered = options.binary
    ? unique([...executableCandidates(options.binary, options), ...executableCandidates(agent, options)])
    : executableCandidates(agent, options);
  const candidates = options.candidates ?? discovered.filter(isFile);
  if (candidates.length === 0) {
    return { agent, status: "NOT FOUND", detail: `Install ${agent} or add it to PATH.` };
  }
  const probe = options.probe ?? defaultProbe;
  let lastFailure = "The executable could not be started.";
  for (const binary of candidates) {
    let version: ProbeResult;
    try {
      version = await probe(binary, ["--version"]);
    } catch (error) {
      lastFailure = errorDetail(error);
      continue;
    }
    if (version.exitCode !== 0 || version.errorCode) {
      lastFailure = firstLine(version.output) ?? version.errorCode ?? lastFailure;
      continue;
    }
    let auth: ProbeResult;
    try {
      auth = await probe(binary, authArguments(agent));
    } catch (error) {
      return { agent, status: "NOT EXECUTABLE", binary, detail: errorDetail(error) };
    }
    const authOutput = auth.output.trim();
    const notAuthenticated = auth.exitCode !== 0
      || /\bnot logged in\b|\bnot authenticated\b|\bno (?:stored )?(?:credentials|providers?)\b|\b0 credentials\b/i.test(authOutput);
    if (notAuthenticated) {
      if (agent === "opencode") {
        try {
          const models = await probe(binary, ["models", "opencode"]);
          if (models.exitCode === 0 && /(?:^|[/\s-])free(?:$|\s)/im.test(models.output)) {
            return {
              agent,
              status: "READY",
              binary,
              detail: "Installed and usable with OpenCode free models; no provider credential is stored.",
            };
          }
        } catch {
          // Fall through to the normal authentication guidance.
        }
      }
      return {
        agent,
        status: "NOT AUTHENTICATED",
        binary,
        detail: `Run '${agent === "codex" ? "codex login" : `${agent} auth login`}' in your terminal.`,
      };
    }
    return {
      agent,
      status: "READY",
      binary,
      detail: "Installed, executable and authenticated.",
    };
  }
  return { agent, status: "NOT EXECUTABLE", binary: candidates[0]!, detail: lastFailure };
}

import { existsSync, statSync } from "node:fs";
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
  version?: string;
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
    const versionText = firstLine(version.output);
    if (notAuthenticated) {
      if (agent === "opencode") {
        try {
          const models = await probe(binary, ["models", "opencode"]);
          if (models.exitCode === 0 && /(?:^|[/\s-])free(?:$|\s)/im.test(models.output)) {
            return {
              agent,
              status: "READY",
              binary,
              ...(versionText === undefined ? {} : { version: versionText }),
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
        ...(versionText === undefined ? {} : { version: versionText }),
        detail: `Run '${agent === "codex" ? "codex login" : `${agent} auth login`}' in your terminal.`,
      };
    }
    return {
      agent,
      status: "READY",
      binary,
      ...(versionText === undefined ? {} : { version: versionText }),
      detail: "Installed, executable and authenticated.",
    };
  }
  return { agent, status: "NOT EXECUTABLE", binary: candidates[0]!, detail: lastFailure };
}

export async function diagnoseAgents(options: DiscoveryEnvironment = {}): Promise<AgentDiagnostic[]> {
  return Promise.all(CODING_AGENTS.map((agent) => diagnoseAgent(agent, options)));
}

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  diagnoseAgent,
  executableCandidates,
  listAgentModels,
  type AgentProbe,
} from "../agents.js";

test("Windows discovery covers PATH, PATHEXT, npm, pnpm and WinGet locations", () => {
  const candidates = executableCandidates("opencode", {
    platform: "win32",
    homeDirectory: "C:\\Users\\dev",
    env: {
      PATH: "C:\\tools;C:\\custom",
      PATHEXT: ".EXE;.CMD;.BAT",
      APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
      PNPM_HOME: "C:\\pnpm",
    },
  });

  assert.ok(candidates.includes("C:\\tools\\opencode.exe"));
  assert.ok(candidates.includes("C:\\tools\\opencode.cmd"));
  assert.ok(candidates.includes("C:\\Users\\dev\\AppData\\Roaming\\npm\\opencode.cmd"));
  assert.ok(candidates.includes("C:\\pnpm\\opencode.exe"));
  assert.ok(candidates.includes("C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links\\opencode.exe"));
});

test("macOS and Linux discovery covers package-manager and native locations", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const candidates = executableCandidates("claude", {
      platform,
      homeDirectory: "/Users/dev",
      env: { PATH: "/custom/bin:/usr/bin" },
    });
    assert.ok(candidates.includes("/custom/bin/claude"));
    assert.ok(candidates.includes("/Users/dev/.local/bin/claude"));
    assert.ok(candidates.includes("/usr/local/bin/claude"));
    if (platform === "darwin") assert.ok(candidates.includes("/opt/homebrew/bin/claude"));
  }
});

test("diagnostics distinguish missing, non-executable, unauthenticated and ready agents", async () => {
  const probe: AgentProbe = async (binary, args) => {
    if (binary.endsWith("broken.exe")) return { exitCode: null, output: "spawn EPERM", errorCode: "EPERM" };
    if (args.join(" ") === "login status") return { exitCode: 1, output: "Not logged in" };
    return { exitCode: 0, output: "codex-cli 1.0" };
  };
  const base = { platform: "win32" as const, homeDirectory: "C:\\Users\\dev", env: {}, probe };

  assert.equal((await diagnoseAgent("codex", { ...base, candidates: [] })).status, "NOT FOUND");
  assert.equal((await diagnoseAgent("codex", { ...base, candidates: ["C:\\broken.exe"] })).status, "NOT EXECUTABLE");
  const unauthenticated = await diagnoseAgent("codex", { ...base, candidates: ["C:\\codex.cmd"] });
  assert.equal(unauthenticated.status, "NOT AUTHENTICATED");
  assert.equal(unauthenticated.binary, "C:\\codex.cmd");

  const ready = await diagnoseAgent("claude", {
    ...base,
    candidates: ["C:\\claude.bat"],
    probe: async (_binary, args) => args[0] === "auth"
      ? { exitCode: 0, output: "{\"loggedIn\":true}" }
      : { exitCode: 0, output: "2.0.0" },
  });
  assert.equal(ready.status, "READY");
  assert.equal(ready.binary, "C:\\claude.bat");
});

test("OpenCode uses its credential listing without exposing or storing secrets", async () => {
  const calls: string[][] = [];
  const result = await diagnoseAgent("opencode", {
    platform: "linux",
    homeDirectory: "/home/dev",
    env: {},
    candidates: ["/usr/local/bin/opencode"],
    probe: async (_binary, args) => {
      calls.push(args);
      return args[0] === "auth"
        ? { exitCode: 0, output: "anthropic oauth" }
        : { exitCode: 0, output: "opencode 1.0" };
    },
  });
  assert.equal(result.status, "READY");
  assert.deepEqual(calls, [["--version"], ["auth", "list"]]);
  assert.doesNotMatch(JSON.stringify(result), /key|token|secret/i);
});

test("OpenCode is READY without credentials when its free models are available", async () => {
  const calls: string[][] = [];
  const result = await diagnoseAgent("opencode", {
    candidates: ["/usr/local/bin/opencode"],
    probe: async (_binary, args) => {
      calls.push(args);
      if (args[0] === "--version") return { exitCode: 0, output: "1.18.22" };
      if (args[0] === "auth") return { exitCode: 0, output: "0 credentials" };
      return { exitCode: 0, output: "opencode/mimo-v2.5-free" };
    },
  });
  assert.equal(result.status, "READY");
  assert.match(result.detail, /free model/i);
  assert.deepEqual(calls, [["--version"], ["auth", "list"], ["models", "opencode"]]);
});

test("model discovery reads OpenCode's installed catalog", async () => {
  const models = await listAgentModels("opencode", "/usr/local/bin/opencode", process.cwd(), async (_binary, args) => {
    assert.deepEqual(args, ["models"]);
    return { exitCode: 0, output: "provider/model-a\nprovider/model-b\n" };
  });
  assert.deepEqual(models, ["provider/model-a", "provider/model-b"]);
});

test("model discovery reads Codex's machine-readable model catalog", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runi-codex-models-"));
  try {
    const server = join(directory, "model-server.mjs");
    const binary = join(directory, process.platform === "win32" ? "codex.cmd" : "codex");
    writeFileSync(server, `let buffer = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', chunk => {\n  buffer += chunk;\n  const lines = buffer.split(/\\r?\\n/); buffer = lines.pop() ?? '';\n  for (const line of lines) {\n    const request = JSON.parse(line);\n    if (request.id === 1) console.log(JSON.stringify({id: 1, result: {userAgent: 'fake'}}));\n    if (request.id === 2) console.log(JSON.stringify({id: 2, result: {data: [{model: 'gpt-test-a'}, {model: 'gpt-test-b'}]}}));\n  }\n});\n`);
    writeFileSync(binary, process.platform === "win32"
      ? `@echo off\r\n\"${process.execPath}\" \"${server}\"\r\n`
      : `#!/bin/sh\nexec '${process.execPath}' '${server}'\n`);
    if (process.platform !== "win32") chmodSync(binary, 0o755);

    assert.deepEqual(await listAgentModels("codex", binary, directory), ["gpt-test-a", "gpt-test-b"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a synchronous spawn failure becomes NOT EXECUTABLE instead of crashing doctor", async () => {
  const result = await diagnoseAgent("codex", {
    platform: "win32",
    homeDirectory: "C:\\Users\\dev",
    env: {},
    candidates: ["C:\\Program Files\\WindowsApps\\codex.exe"],
    probe: async () => { throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" }); },
  });
  assert.equal(result.status, "NOT EXECUTABLE");
  assert.match(result.detail, /EPERM/);
});

test("the real launcher probes Windows batch shims and Unix native scripts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runi-agent-probe-"));
  try {
    const binary = join(directory, process.platform === "win32" ? "claude.bat" : "claude");
    writeFileSync(binary, process.platform === "win32"
      ? "@echo off\r\nif \"%1\"==\"--version\" (echo claude-test 1.0& exit /b 0)\r\nif \"%1\"==\"auth\" (echo {\"loggedIn\":true}& exit /b 0)\r\nexit /b 1\r\n"
      : "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'claude-test 1.0'; exit 0; fi\nif [ \"$1\" = \"auth\" ]; then echo '{\"loggedIn\":true}'; exit 0; fi\nexit 1\n");
    if (process.platform !== "win32") chmodSync(binary, 0o755);
    const result = await diagnoseAgent("claude", { candidates: [binary] });
    assert.equal(result.status, "READY", result.detail);
    assert.equal(result.binary, binary);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a stale saved executable falls back to another global installation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runi-agent-fallback-"));
  try {
    const extension = process.platform === "win32" ? ".cmd" : "";
    const stale = join(directory, `stale${extension}`);
    const global = join(directory, `codex${extension}`);
    writeFileSync(stale, "stale");
    writeFileSync(global, "global");
    const result = await diagnoseAgent("codex", {
      binary: stale,
      env: { PATH: directory, PATHEXT: ".EXE;.CMD;.BAT" },
      probe: async (binary, args) => binary === stale
        ? { exitCode: null, output: "spawn EPERM", errorCode: "EPERM" }
        : args[0] === "--version"
          ? { exitCode: 0, output: "codex 2.0" }
          : { exitCode: 0, output: "Logged in using ChatGPT" },
    });
    assert.equal(result.status, "READY");
    assert.equal(result.binary, global);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

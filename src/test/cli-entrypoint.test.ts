import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function writeFakeCodex(directory: string): string {
  const path = join(directory, process.platform === "win32" ? "codex.cmd" : "codex");
  writeFileSync(path, process.platform === "win32"
    ? "@echo off\r\nif \"%1\"==\"--version\" (echo codex-test 1.0& exit /b 0)\r\nif \"%1\"==\"login\" (echo Logged in using ChatGPT& exit /b 0)\r\nexit /b 0\r\n"
    : "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex-test 1.0'; exit 0; fi\nif [ \"$1\" = \"login\" ]; then echo 'Logged in using ChatGPT'; exit 0; fi\nexit 0\n");
  if (process.platform !== "win32") chmodSync(path, 0o755);
  return path;
}

function writeFakeOpenCode(directory: string): string {
  const path = join(directory, process.platform === "win32" ? "opencode.cmd" : "opencode");
  writeFileSync(path, process.platform === "win32"
    ? "@echo off\r\nif \"%1\"==\"--version\" (echo opencode-test 1.0& exit /b 0)\r\nif \"%1\"==\"auth\" (echo github oauth& exit /b 0)\r\nif \"%1\"==\"models\" (echo provider/model-a& echo provider/model-b& exit /b 0)\r\nexit /b 0\r\n"
    : "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'opencode-test 1.0'; exit 0; fi\nif [ \"$1\" = \"auth\" ]; then echo 'github oauth'; exit 0; fi\nif [ \"$1\" = \"models\" ]; then printf '%s\\n' 'provider/model-a' 'provider/model-b'; exit 0; fi\nexit 0\n");
  if (process.platform !== "win32") chmodSync(path, 0o755);
  return path;
}

test("compiled CLI executes when invoked directly", () => {
  const result = spawnSync(process.execPath, [resolve("dist", "cli.js"), "help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Runi 0\.2/);
  assert.match(result.stdout, /runi start/);
  assert.match(result.stdout, /--guided/);
  assert.match(result.stdout, /--grill/);
  assert.match(result.stdout, /opencode\|codex\|claude\|command/);
});

test("--help remains non-interactive", () => {
  const result = spawnSync(process.execPath, [resolve("dist", "cli.js"), "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.doesNotMatch(result.stdout, /Choose:/);
});

test("doctor reports actionable coding-agent states", () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "runi-doctor-"));
  try {
    const fakeCodex = writeFakeCodex(workingDirectory);
    const result = spawnSync(process.execPath, [resolve("dist", "cli.js"), "doctor", "--workdir", workingDirectory], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${workingDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /codex\s+READY/);
    assert.match(result.stdout, new RegExp(fakeCodex.replaceAll("\\", "\\\\")));
    assert.match(result.stdout, /opencode\s+(?:READY|NOT FOUND|NOT AUTHENTICATED|NOT EXECUTABLE)/);
    assert.match(result.stdout, /never reads or stores API keys/);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("no-argument CLI opens Leo's slash-command session", () => {
  const result = spawnSync(process.execPath, [resolve("dist", "cli.js")], {
    encoding: "utf8",
    input: "/\n14\n",
    env: { ...process.env, FORCE_COLOR: "1" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /@\\___/);
  assert.match(result.stdout, /\/guided/);
  assert.match(result.stdout, /\/grill/);
  assert.match(result.stdout, /\/doctor/);
  assert.match(result.stdout, /What should Runi do\?/);
  assert.doesNotMatch(result.stdout, /Search:/);
  assert.match(result.stdout, /\x1b\[38;2;255;192;0m/);
});

test("slash settings persist workspace defaults", () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "runi-settings-"));
  try {
    const fakeCodex = writeFakeCodex(workingDirectory);
    const input = [
      "/settings",
      "2",
      "2",
      "gpt-5.4",
      "2",
      "3",
      "2",
      "/exit",
    ].join("\n") + "\n";
    const result = spawnSync(process.execPath, [resolve("dist", "cli.js")], {
      cwd: workingDirectory,
      encoding: "utf8",
      input,
      env: { ...process.env, PATH: `${workingDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` },
    });

    assert.equal(result.status, 0, result.stderr);
    const settings = JSON.parse(readFileSync(join(workingDirectory, ".runi", "settings.json"), "utf8"));
    assert.deepEqual(settings, {
      agent: "codex",
      model: "gpt-5.4",
      binary: fakeCodex,
      maxAttempts: 2,
      wallTime: "2h",
      verificationPolicy: "ai",
    });
    assert.match(result.stdout, /Defaults saved/);
    assert.match(result.stdout, /unavailable: NOT FOUND/);
    assert.doesNotMatch(JSON.stringify(settings), /api.?key|token|secret/i);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("settings retrieves models and prioritizes selection over manual entry", () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "runi-models-"));
  try {
    const fakeOpenCode = writeFakeOpenCode(workingDirectory);
    const input = [
      "/settings",
      "1",
      "3",
      "3",
      "4",
      "1",
      "/exit",
    ].join("\n") + "\n";
    const result = spawnSync(process.execPath, [resolve("dist", "cli.js")], {
      cwd: workingDirectory,
      encoding: "utf8",
      input,
      env: { ...process.env, PATH: `${workingDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` },
    });

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /provider\/model-a/);
    assert.match(result.stdout, /provider\/model-b/);
    assert.deepEqual(JSON.parse(readFileSync(join(workingDirectory, ".runi", "settings.json"), "utf8")), {
      agent: "opencode",
      model: "provider/model-b",
      binary: fakeOpenCode,
      maxAttempts: 3,
      wallTime: "4h",
      verificationPolicy: "manual",
    });
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("settings can hand an unauthenticated agent to its native login", () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "runi-auth-"));
  try {
    const binary = join(workingDirectory, process.platform === "win32" ? "codex.cmd" : "codex");
    const marker = join(workingDirectory, "authenticated");
    writeFileSync(binary, process.platform === "win32"
      ? `@echo off\r\nif \"%1\"==\"--version\" (echo codex-test 1.0& exit /b 0)\r\nif \"%1\"==\"login\" if \"%2\"==\"status\" (if exist \"${marker}\" (echo Logged in& exit /b 0) else (echo Not logged in& exit /b 1))\r\nif \"%1\"==\"login\" (break > \"${marker}\"& exit /b 0)\r\nexit /b 1\r\n`
      : `#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex-test 1.0'; exit 0; fi\nif [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then [ -f '${marker}' ] && { echo 'Logged in'; exit 0; }; echo 'Not logged in'; exit 1; fi\nif [ \"$1\" = \"login\" ]; then touch '${marker}'; exit 0; fi\nexit 1\n`);
    if (process.platform !== "win32") chmodSync(binary, 0o755);
    const input = ["/settings", "2", "2", "1", "3", "4", "1", "/exit"].join("\n") + "\n";
    const result = spawnSync(process.execPath, [resolve("dist", "cli.js")], {
      cwd: workingDirectory,
      encoding: "utf8",
      input,
      env: { ...process.env, PATH: `${workingDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` },
    });

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(existsSync(marker), true, `${result.stderr}\n${result.stdout}`);
    assert.equal(readFileSync(marker, "utf8"), "");
    assert.match(result.stdout, /Sign in to codex/);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("AI guidance reports the original spawn error instead of exit code -1", () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "runi-guidance-error-"));
  try {
    const missing = join(workingDirectory, process.platform === "win32" ? "missing-agent.exe" : "missing-agent");
    const result = spawnSync(process.execPath, [
      resolve("dist", "cli.js"),
      "start",
      "Refine this job",
      "--grill",
      "--workdir",
      workingDirectory,
    ], { encoding: "utf8", input: `codex\n${missing}\n\n` });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /ENOENT|not found/i);
    assert.doesNotMatch(result.stderr, /exit code -1/i);
    assert.match(result.stderr, new RegExp(missing.replaceAll("\\", "\\\\")));
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("failed jobs print the worker root cause", () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "runi-worker-error-"));
  try {
    const task = join(workingDirectory, "task.json");
    writeFileSync(task, JSON.stringify({
      goal: "Expose the real worker error",
      executor: {
        kind: "command",
        command: `${quote(process.execPath)} -e "console.error('worker root cause'); process.exit(2)"`,
      },
      verification: [`${quote(process.execPath)} -e "process.exit(0)"`],
      budget: { maxAttempts: 1, wallTime: "1m" },
    }));

    const result = spawnSync(process.execPath, [resolve("dist", "cli.js"), "start", task, "--workdir", workingDirectory], {
      encoding: "utf8",
    });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Last worker failure\s+worker root cause/);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("grill mode refines the goal and lets users edit AI verification", () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "runi-grill-"));
  try {
    const grill = `RUNI_GRILL=${JSON.stringify([{ question: "Choose storage", options: ["SQLite", "JSON"] }])}`;
    const verification = `RUNI_VERIFICATION=${JSON.stringify([
      "node -e \"process.exit(1)\"",
      "node -e \"console.log('suggested')\"",
    ])}`;
    const fakeAgent = join(workingDirectory, process.platform === "win32" ? "fake-agent.cmd" : "fake-agent");
    writeFileSync(fakeAgent, process.platform === "win32"
      ? `@echo off\r\necho ${grill}\r\necho ${verification}\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${grill}' '${verification}'\n`);
    if (process.platform !== "win32") chmodSync(fakeAgent, 0o755);

    const editedVerification = `${quote(process.execPath)} -e \"process.exit(0)\"`;
    const input = [
      "codex",
      fakeAgent,
      "",
      "2",
      "1",
      "1m",
      "ai",
      "-",
      editedVerification,
      "",
    ].join("\n") + "\n";
    const result = spawnSync(process.execPath, [
      resolve("dist", "cli.js"),
      "start",
      "Build durable storage",
      "--grill",
      "--workdir",
      workingDirectory,
    ], { encoding: "utf8", input });

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /Choose storage/);
    assert.match(result.stdout, /AI verification suggestions/);
    const taskFile = readdirSync(join(workingDirectory, ".runi", "tasks"))[0]!;
    const task = JSON.parse(readFileSync(join(workingDirectory, ".runi", "tasks", taskFile), "utf8")) as {
      goal: string;
      verification: string[];
    };
    assert.match(task.goal, /Original job:\nBuild durable storage/);
    assert.match(task.goal, /Choose storage: JSON/);
    assert.deepEqual(task.verification, [editedVerification]);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("OpenCode AI guidance accepts marked JSON split across multiple lines", () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "runi-opencode-json-"));
  try {
    const script = join(workingDirectory, "fake-opencode.mjs");
    const binary = join(workingDirectory, process.platform === "win32" ? "opencode.cmd" : "opencode");
    writeFileSync(script, `const permissions = JSON.parse(process.env.OPENCODE_PERMISSION || '{}');\nconst prompt = process.argv.at(-1) || '';\nif (permissions.read === 'allow' || !prompt.includes('Create hello.py')) { console.log(JSON.stringify({type:'text',part:{type:'text',text:'Which job should I verify?'}})); process.exit(0); }\nconst grill = 'RUNI_GRILL=\\n' + JSON.stringify([{question:'Storage?',options:['SQLite','JSON']}], null, 2);\nconst verify = 'RUNI_VERIFICATION=[${process.execPath.replaceAll("\\", "\\\\")} -e "process.exit(0)"]';\nconsole.log(JSON.stringify({type:'text',part:{type:'text',text:grill + '\\n' + verify}}));\n`);
    writeFileSync(binary, process.platform === "win32"
      ? `@echo off\r\n\"${process.execPath}\" \"${script}\" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
    if (process.platform !== "win32") chmodSync(binary, 0o755);
    const input = ["opencode", binary, "", "1", "1", "30m", "ai", "", "", ""].join("\n") + "\n";
    const result = spawnSync(process.execPath, [resolve("dist", "cli.js"), "start", "Create hello.py", "--grill", "--workdir", workingDirectory], {
      encoding: "utf8",
      input,
    });

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.doesNotMatch(result.stdout, /AI suggestion unavailable/);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("logs present agent events without nested provider JSON", () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "runi-readable-logs-"));
  try {
    const task = join(workingDirectory, "task.json");
    const worker = join(workingDirectory, "worker.mjs");
    const event = JSON.stringify({ type: "text", part: { type: "text", text: "Readable progress" } });
    writeFileSync(worker, `console.log(${JSON.stringify(event)});\n`);
    writeFileSync(task, JSON.stringify({
      goal: "Emit provider progress",
      executor: { kind: "command", command: `${quote(process.execPath)} ${quote(worker)}` },
      verification: [`${quote(process.execPath)} -e \"process.exit(0)\"`],
      budget: { maxAttempts: 1, wallTime: "1m" },
    }));
    const started = spawnSync(process.execPath, [resolve("dist", "cli.js"), "start", task, "--workdir", workingDirectory], { encoding: "utf8" });
    const jobId = /Started durable job (rn_[a-z0-9]+)/i.exec(started.stdout)?.[1];
    assert.ok(jobId, started.stdout);
    const result = spawnSync(process.execPath, [resolve("dist", "cli.js"), "logs", jobId, "--workdir", workingDirectory], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /agent\s+Readable progress/);
    assert.doesNotMatch(result.stdout, /AGENT_STDOUT \{"message":"\{/);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("guided start turns a goal into a reusable supervised task", () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "runi-guided-"));
  try {
    const input = [
      "command",
      `${quote(process.execPath)} -e \"console.log('guided worker')\"`,
      "1",
      "1m",
      "manual",
      `${quote(process.execPath)} -e \"process.exit(0)\"`,
      "",
    ].join("\n") + "\n";
    const result = spawnSync(process.execPath, [
      resolve("dist", "cli.js"),
      "start",
      "Create a guided task",
      "--guided",
      "--workdir",
      workingDirectory,
    ], { encoding: "utf8", input });

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /Worker agent/);
    assert.match(result.stdout, /Saved reusable task/);
    assert.match(result.stdout, /State\s+COMPLETE/);
    const taskFiles = readdirSync(join(workingDirectory, ".runi", "tasks"));
    assert.equal(taskFiles.length, 1);
    const task = JSON.parse(readFileSync(join(workingDirectory, ".runi", "tasks", taskFiles[0]!), "utf8")) as {
      goal: string;
      verification: string[];
    };
    assert.equal(task.goal, "Create a guided task");
    assert.deepEqual(task.verification, [`${quote(process.execPath)} -e \"process.exit(0)\"`]);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("Leo visibly supervises a foreground job", () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "runi-leo-"));
  try {
    const result = spawnSync(process.execPath, [
      resolve("dist", "cli.js"),
      "start",
      resolve("examples", "command-task.json"),
      "--workdir",
      workingDirectory,
      "--command",
      `${quote(process.execPath)} -e \"console.log('worker complete')\"`,
      "--verify",
      `${quote(process.execPath)} -e \"process.exit(0)\"`,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /🐕 Leo · supervising/);
    assert.match(result.stdout, /State\s+COMPLETE/);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("compiled CLI executes when invoked directly", () => {
  const result = spawnSync(process.execPath, [resolve("dist", "cli.js"), "help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Runi 0\.2/);
  assert.match(result.stdout, /runi start/);
  assert.match(result.stdout, /--guided/);
  assert.match(result.stdout, /--grill/);
  assert.match(result.stdout, /opencode\|codex\|claude\|command/);
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

    const editedVerification = "node -e \"process.exit(0)\"";
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

    assert.equal(result.status, 0, result.stderr);
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

test("guided start turns a goal into a reusable supervised task", () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "runi-guided-"));
  try {
    const input = [
      "command",
      "node -e \"console.log('guided worker')\"",
      "1",
      "1m",
      "manual",
      "node -e \"process.exit(0)\"",
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

    assert.equal(result.status, 0, result.stderr);
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
    assert.deepEqual(task.verification, ["node -e \"process.exit(0)\""]);
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
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /🐕 Leo · supervising/);
    assert.match(result.stdout, /State\s+COMPLETE/);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

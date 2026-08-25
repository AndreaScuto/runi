import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("compiled CLI executes when invoked directly", () => {
  const result = spawnSync(process.execPath, [resolve("dist", "cli.js"), "help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Runi 0\.1/);
  assert.match(result.stdout, /runi start/);
  assert.match(result.stdout, /opencode\|codex\|claude\|command/);
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

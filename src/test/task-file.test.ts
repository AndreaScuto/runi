import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseDuration } from "../budget.js";
import { loadTaskDefinition } from "../task-file.js";

test("parseDuration accepts human-readable durations", () => {
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("30m"), 1_800_000);
});

test("task JSON produces a validated completion contract", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runi-task-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const taskPath = join(root, "task.json");
  await writeFile(taskPath, JSON.stringify({
    goal: "Add tests",
    executor: { kind: "command", command: "echo work" },
    verification: [{ command: "echo verify", label: "verification" }],
    budget: { maxAttempts: 5, wallTime: "45m" },
  }));
  const task = await loadTaskDefinition(taskPath, { workingDirectory: root });
  assert.equal(task.executor.kind, "command");
  assert.equal(task.verification[0]?.label, "verification");
  assert.equal(task.budget.wallTimeMs, 2_700_000);
});

test("task parsing rejects a task without independent verification", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runi-task-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const taskPath = join(root, "task.json");
  await writeFile(taskPath, JSON.stringify({ goal: "No proof", executor: { kind: "command", command: "echo work" } }));
  await assert.rejects(loadTaskDefinition(taskPath, { workingDirectory: root }), /requires at least one verification command/);
});

test("task parsing accepts each supported coding agent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runi-agents-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const taskPath = join(root, "task.json");
  for (const kind of ["opencode", "codex", "claude"] as const) {
    await writeFile(taskPath, JSON.stringify({ goal: "Work", executor: { kind }, verification: ["echo verify"] }));
    assert.equal((await loadTaskDefinition(taskPath, { workingDirectory: root })).executor.kind, kind);
  }
});

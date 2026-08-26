import assert from "node:assert/strict";
import test from "node:test";
import { claudeCodeInvocation } from "../adapters/claude.js";
import { codexInvocation } from "../adapters/codex.js";
import type { AgentKind, Job } from "../domain.js";

function job(kind: AgentKind, binary: string, model: string): Job {
  return {
    id: "rn_adapter_test",
    status: "created",
    attempts: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    definition: {
      goal: "Implement the requested change",
      taskPath: "task.json",
      workingDirectory: process.cwd(),
      executor: { kind, binary, model },
      verification: [{ command: "node --test" }],
      budget: { maxAttempts: 2 },
    },
  };
}

test("Codex adapter uses safe non-interactive workspace execution", () => {
  const invocation = codexInvocation(job("codex", "codex-test", "codex-model"), "retry context");
  assert.equal(invocation.binary, "codex-test");
  assert.deepEqual(invocation.args.slice(0, 7), [
    "exec", "--approve-for-me",
    "--color", "never", "--json", "--model", "codex-model",
  ]);
  assert.ok(!invocation.args.includes("--sandbox"));
  assert.ok(!invocation.args.includes("--ask-for-approval"));
  assert.match(invocation.args.at(-1) ?? "", /retry context/);
});

test("Claude Code adapter uses non-interactive edit permissions", () => {
  const invocation = claudeCodeInvocation(job("claude", "claude-test", "claude-model"), "verifier failed");
  assert.equal(invocation.binary, "claude-test");
  assert.deepEqual(invocation.args.slice(0, 9), [
    "-p", "--output-format", "stream-json", "--verbose", "--permission-mode",
    "acceptEdits", "--no-session-persistence", "--model", "claude-model",
  ]);
  assert.match(invocation.args.at(-1) ?? "", /verifier failed/);
});

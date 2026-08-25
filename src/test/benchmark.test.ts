import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCodeInvocation } from "../adapters/opencode.js";
import type { BenchmarkResult } from "../benchmark/types.js";
import { markdownReport } from "../benchmark/report.js";
import { runBenchmark } from "../benchmark/runner.js";
import { BENCHMARK_SCENARIOS, createScenarioWorkspace } from "../benchmark/scenarios.js";
import { sumAttemptUsage, usageFromOpenCodeOutput } from "../benchmark/usage.js";
import type { Job } from "../domain.js";

function job(): Job {
  return {
    id: "rn_benchmark_test",
    status: "created",
    attempts: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    definition: {
      goal: "Implement sum",
      taskPath: "task.json",
      workingDirectory: process.cwd(),
      executor: { kind: "opencode", binary: "opencode-test", model: "provider/model", autoApprove: true },
      verification: [{ command: "node verify.mjs" }],
      budget: { maxAttempts: 3, wallTimeMs: 60_000 },
    },
  };
}

test("benchmark ships ten deterministic scenarios with generated hidden acceptance", async (t) => {
  assert.equal(BENCHMARK_SCENARIOS.length, 10);
  const root = await mkdtemp(join(tmpdir(), "runi-benchmark-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const acceptance = join(root, "acceptance.mjs");
  await createScenarioWorkspace(workspace, acceptance, BENCHMARK_SCENARIOS[0]!);
  assert.match(await readFile(acceptance, "utf8"), /assert\.equal\(sum\(0, 0\), 0\)/);
  assert.match(await readFile(join(workspace, "test", "utils.test.js"), "utf8"), /test\("sum"/);
});

test("OpenCode invocation pins non-interactive flags and the requested model", () => {
  const invocation = openCodeInvocation(job(), "retry with verifier output");
  assert.equal(invocation.binary, "opencode-test");
  assert.deepEqual(invocation.args.slice(0, 6), ["run", "--format", "json", "--auto", "--model", "provider/model"]);
  assert.match(invocation.args.at(-1) ?? "", /retry with verifier output/);
});

test("usage extraction keeps cumulative OpenCode values and sums independent attempts", () => {
  const first = usageFromOpenCodeOutput('noise\n{"type":"step","usage":{"input_tokens":12,"output_tokens":5,"total_tokens":17,"cost_usd":0.01}}\n{"usage":{"input_tokens":20,"output_tokens":8,"total_tokens":28,"cost_usd":0.02}}');
  const second = usageFromOpenCodeOutput('{"usage":{"inputTokens":7,"outputTokens":3,"totalTokens":10,"costUsd":0.005}}');
  assert.deepEqual(first, { inputTokens: 20, outputTokens: 8, totalTokens: 28, costUsd: 0.02, samples: 2 });
  assert.deepEqual(sumAttemptUsage([first!, second!]), { inputTokens: 27, outputTokens: 11, totalTokens: 38, costUsd: 0.025, samples: 3 });
});

test("report renders observed token savings and does not turn unavailable telemetry into zero", () => {
  const result: BenchmarkResult = {
    schemaVersion: 1,
    id: "example",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:10.000Z",
    configuration: { opencodeBinary: "opencode", scenarioCount: 1, maxAttempts: 3, wallTimeMs: 60_000 },
    cases: [
      {
        scenarioId: "sum", title: "sum", mode: "direct", startedAt: "", completedAt: "", durationMs: 5_000, verified: true,
        workerExitCode: 0, status: "complete", attempts: 1, retries: 0, usage: { totalTokens: 100, costUsd: 0.1, samples: 1 },
        verification: [], logFile: "direct.log", workspace: "direct",
      },
      {
        scenarioId: "sum", title: "sum", mode: "runi", startedAt: "", completedAt: "", durationMs: 4_000, verified: true,
        workerExitCode: 0, status: "complete", attempts: 1, retries: 0, usage: { totalTokens: 80, costUsd: 0.08, samples: 1 },
        verification: [], logFile: "runi.log", workspace: "runi",
      },
    ],
  };
  const report = markdownReport(result);
  assert.match(report, /20 tokens saved by Runi/);
  assert.match(report, /1,000 ms saved by Runi/);
  assert.doesNotMatch(report, /N\/A \(provider did not emit tokens\)/);
});

test("paired runner writes independently verified reusable artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runi-benchmark-run-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const agent = join(root, "fake-opencode.mjs");
  await writeFile(agent, [
    'import { writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    'await writeFile(join(process.cwd(), "src", "utils.js"), "export function sum(a, b) { return a + b; }\\n");',
    'console.log(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, cost_usd: 0.002 } }));',
  ].join("\n"));
  const wrapper = join(root, process.platform === "win32" ? "fake-opencode.cmd" : "fake-opencode");
  if (process.platform === "win32") {
    await writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${agent}" %*\r\n`);
  } else {
    await writeFile(wrapper, `#!/bin/sh\n"${process.execPath}" "${agent}" "$@"\n`);
    await chmod(wrapper, 0o755);
  }
  const output = join(root, "artifacts");
  const result = await runBenchmark({ outputDirectory: output, opencodeBinary: wrapper, scenarioCount: 1, maxAttempts: 2, wallTimeMs: 30_000 });
  assert.equal(result.cases.length, 2);
  assert.ok(result.cases.every((entry) => entry.verified));
  assert.deepEqual(result.cases.map((entry) => entry.usage?.totalTokens), [14, 14]);
  assert.match(await readFile(join(output, "BENCHMARK_REPORT.md"), "utf8"), /OpenCode vs OpenCode \+ Runi benchmark/);
  assert.equal(JSON.parse(await readFile(join(output, "summary.json"), "utf8")).cases.length, 2);
});

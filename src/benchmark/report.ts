import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AggregateMetrics, BenchmarkCaseResult, BenchmarkMode, BenchmarkResult } from "./types.js";

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

function optionalTotal(cases: BenchmarkCaseResult[], field: "totalTokens" | "costUsd"): { total: number; observedRuns: number } | undefined {
  const values = cases.map((entry) => entry.usage?.[field]).filter((value): value is number => typeof value === "number");
  return values.length === 0 ? undefined : { total: values.reduce((total, value) => total + value, 0), observedRuns: values.length };
}

export function aggregate(result: BenchmarkResult, mode: BenchmarkMode): AggregateMetrics {
  const cases = result.cases.filter((entry) => entry.mode === mode);
  const durations = cases.map((entry) => entry.durationMs).sort((a, b) => a - b);
  const totalDuration = durations.reduce((total, value) => total + value, 0);
  const aggregate: AggregateMetrics = {
    total: cases.length,
    verified: cases.filter((entry) => entry.verified).length,
    verifiedRate: cases.length === 0 ? 0 : cases.filter((entry) => entry.verified).length / cases.length,
    durationMs: {
      total: totalDuration,
      average: cases.length === 0 ? 0 : totalDuration / cases.length,
      median: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
    },
    attempts: cases.reduce((total, entry) => total + entry.attempts, 0),
    retries: cases.reduce((total, entry) => total + entry.retries, 0),
    ...(optionalTotal(cases, "totalTokens") === undefined ? {} : { tokenUsage: optionalTotal(cases, "totalTokens")! }),
    ...(optionalTotal(cases, "costUsd") === undefined ? {} : { costUsd: optionalTotal(cases, "costUsd")! }),
  };
  return aggregate;
}

function duration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds.toFixed(0)} ms`;
  return `${(milliseconds / 1_000).toFixed(2)} s`;
}

function decimal(value: number, digits = 2): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function metricPair(
  direct: number | undefined,
  runi: number | undefined,
  unit: string,
  digits = 2,
): string {
  if (direct === undefined || runi === undefined) return `N/A (provider did not emit ${unit})`;
  const delta = direct - runi;
  const percent = direct === 0 ? undefined : (delta / direct) * 100;
  const direction = delta >= 0 ? "saved by Runi" : "additional with Runi";
  return `${decimal(direct, digits)} → ${decimal(runi, digits)} (${decimal(Math.abs(delta), digits)} ${unit} ${direction}${percent === undefined ? "" : `, ${decimal(Math.abs(percent), 1)}%`})`;
}

function csv(value: string | number | boolean | null | undefined): string {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function comparisonRows(result: BenchmarkResult): string {
  const direct = new Map(result.cases.filter((entry) => entry.mode === "direct").map((entry) => [entry.scenarioId, entry]));
  const runi = new Map(result.cases.filter((entry) => entry.mode === "runi").map((entry) => [entry.scenarioId, entry]));
  return [...direct.keys()].map((scenarioId) => {
    const a = direct.get(scenarioId)!;
    const b = runi.get(scenarioId)!;
    const tokenDelta = a.usage?.totalTokens !== undefined && b.usage?.totalTokens !== undefined ? a.usage.totalTokens - b.usage.totalTokens : undefined;
    const costDelta = a.usage?.costUsd !== undefined && b.usage?.costUsd !== undefined ? a.usage.costUsd - b.usage.costUsd : undefined;
    return `| ${scenarioId} | ${a.verified ? "PASS" : "FAIL"} | ${b.verified ? "PASS" : "FAIL"} | ${duration(a.durationMs)} | ${duration(b.durationMs)} | ${tokenDelta === undefined ? "N/A" : decimal(tokenDelta, 0)} | ${costDelta === undefined ? "N/A" : `$${decimal(costDelta, 4)}`} | ${b.attempts} | ${b.retries} |`;
  }).join("\n");
}

export function markdownReport(result: BenchmarkResult): string {
  const direct = aggregate(result, "direct");
  const runi = aggregate(result, "runi");
  return `# OpenCode vs OpenCode + Runi benchmark

Run: \`${result.id}\`  
Started: ${result.startedAt}  
Completed: ${result.completedAt}

## Protocol

- ${result.configuration.scenarioCount} deterministic coding tasks, each in a fresh disposable repository.
- Both modes use the same OpenCode binary${result.configuration.model === undefined ? " and inherited model selection" : ` and model \`${result.configuration.model}\``}.
- Both modes use the same worker prompt and host-side hidden acceptance verifier.
- Runs are serial. A successful operation is counted only when the independent verifier exits with code 0.
- Runi uses a maximum of ${result.configuration.maxAttempts} attempts and a ${duration(result.configuration.wallTimeMs)} wall-time budget per operation.

## Summary

| Metric | OpenCode direct | OpenCode + Runi |
| --- | ---: | ---: |
| Verified completions | ${direct.verified} / ${direct.total} (${decimal(direct.verifiedRate * 100, 1)}%) | ${runi.verified} / ${runi.total} (${decimal(runi.verifiedRate * 100, 1)}%) |
| Total end-to-end time | ${duration(direct.durationMs.total)} | ${duration(runi.durationMs.total)} |
| Mean end-to-end time | ${duration(direct.durationMs.average)} | ${duration(runi.durationMs.average)} |
| Median end-to-end time | ${duration(direct.durationMs.median)} | ${duration(runi.durationMs.median)} |
| P95 end-to-end time | ${duration(direct.durationMs.p95)} | ${duration(runi.durationMs.p95)} |
| Worker attempts | ${direct.attempts} | ${runi.attempts} |
| Automatic retries | ${direct.retries} | ${runi.retries} |
| Token usage | ${direct.tokenUsage === undefined ? "N/A" : `${decimal(direct.tokenUsage.total, 0)} (${direct.tokenUsage.observedRuns}/${direct.total} runs emitted usage)`} | ${runi.tokenUsage === undefined ? "N/A" : `${decimal(runi.tokenUsage.total, 0)} (${runi.tokenUsage.observedRuns}/${runi.total} runs emitted usage)`} |
| Cost | ${direct.costUsd === undefined ? "N/A" : `$${decimal(direct.costUsd.total, 4)} (${direct.costUsd.observedRuns}/${direct.total} runs emitted cost)`} | ${runi.costUsd === undefined ? "N/A" : `$${decimal(runi.costUsd.total, 4)} (${runi.costUsd.observedRuns}/${runi.total} runs emitted cost)`} |

## Savings / overhead

- Tokens: ${metricPair(direct.tokenUsage?.total, runi.tokenUsage?.total, "tokens", 0)}
- Cost: ${metricPair(direct.costUsd?.total, runi.costUsd?.total, "USD", 4)}
- Time: ${metricPair(direct.durationMs.total, runi.durationMs.total, "ms", 0)}

Positive token/cost deltas mean Runi used less. Positive time deltas mean Runi completed sooner. Missing provider telemetry is shown as N/A rather than zero.

## Per-operation evidence

| Scenario | Direct | Runi | Direct time | Runi time | Token delta | Cost delta | Runi attempts | Runi retries |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
${comparisonRows(result)}

## Interpretation limits

This is a paired, small-sample benchmark. It measures verified outcomes, not model quality in general. Provider/model availability, rate limits, cache effects and API pricing can change results. Inspect \`summary.json\`, \`cases.csv\` and per-run logs before making product or cost decisions.
`;
}

export async function writeBenchmarkArtifacts(result: BenchmarkResult, outputDirectory: string): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, "summary.json"), JSON.stringify(result, null, 2));
  await writeFile(join(outputDirectory, "BENCHMARK_REPORT.md"), markdownReport(result));
  const lines = [
    ["scenario", "mode", "verified", "status", "duration_ms", "attempts", "retries", "total_tokens", "cost_usd", "job_id", "log_file"].join(","),
    ...result.cases.map((entry) => [
      entry.scenarioId,
      entry.mode,
      entry.verified,
      entry.status,
      entry.durationMs,
      entry.attempts,
      entry.retries,
      entry.usage?.totalTokens,
      entry.usage?.costUsd,
      entry.jobId,
      entry.logFile,
    ].map(csv).join(",")),
  ];
  await writeFile(join(outputDirectory, "cases.csv"), `${lines.join("\n")}\n`);
}

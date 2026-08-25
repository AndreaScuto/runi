import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDuration } from "../budget.js";
import { writeBenchmarkArtifacts } from "./report.js";
import { defaultBenchmarkOutputDirectory, runBenchmark } from "./runner.js";
import type { BenchmarkResult } from "./types.js";

interface Arguments {
  positionals: string[];
  options: Map<string, string>;
}

function parseArguments(argv: string[]): Arguments {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [name, inline] = value.slice(2).split("=", 2);
    const next = inline ?? argv[index + 1];
    if (!name || next === undefined || next.startsWith("--")) throw new Error(`Option --${name ?? "?"} requires a value.`);
    options.set(name, next);
    if (inline === undefined) index += 1;
  }
  return { positionals, options };
}

function help(): void {
  console.log(`Runi benchmark — paired OpenCode evaluation

Usage:
  runi-benchmark run [options]
  runi-benchmark report <run-directory>

Run options:
  --opencode <path>       OpenCode executable (default: opencode)
  --model <provider/id>   Pin the OpenCode model for both modes
  --count <1-10>          Number of paired scenarios (default: 10)
  --max-attempts <n>      Runi retry budget per operation (default: 3)
  --wall-time <duration>  Per-operation budget (default: 10m)
  --output <directory>    Artifact directory (default: benchmarks/runs/<timestamp>)

Artifacts: summary.json, cases.csv, BENCHMARK_REPORT.md and per-operation logs.
Token and cost fields are reported only when OpenCode/provider JSON output emits them.`);
}

function integer(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArguments(argv);
  const command = args.positionals[0];
  if (command === undefined || command === "help") {
    help();
    return 0;
  }
  if (command === "report") {
    const directory = args.positionals[1];
    if (!directory) throw new Error("Usage: runi-benchmark report <run-directory>");
    const outputDirectory = resolve(directory);
    const result = JSON.parse(await readFile(resolve(outputDirectory, "summary.json"), "utf8")) as BenchmarkResult;
    await writeBenchmarkArtifacts(result, outputDirectory);
    console.log(`Regenerated ${resolve(outputDirectory, "BENCHMARK_REPORT.md")}`);
    return 0;
  }
  if (command !== "run") throw new Error(`Unknown command: ${command}`);
  const count = integer(args.options.get("count"), "--count");
  const maxAttempts = integer(args.options.get("max-attempts"), "--max-attempts");
  const wallTime = args.options.get("wall-time");
  const outputDirectory = resolve(args.options.get("output") ?? defaultBenchmarkOutputDirectory());
  const result = await runBenchmark({
    outputDirectory,
    opencodeBinary: args.options.get("opencode") ?? "opencode",
    ...(args.options.get("model") === undefined ? {} : { model: args.options.get("model")! }),
    ...(count === undefined ? {} : { scenarioCount: count }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(wallTime === undefined ? {} : { wallTimeMs: parseDuration(wallTime) }),
  });
  console.log(`Completed ${result.cases.length} runs. Report: ${resolve(outputDirectory, "BENCHMARK_REPORT.md")}`);
  return result.cases.every((entry) => entry.verified) ? 0 : 1;
}

function isDirectExecution(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  run(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      console.error(`runi-benchmark: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}

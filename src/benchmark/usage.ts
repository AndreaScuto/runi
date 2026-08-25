import type { TokenUsage } from "./types.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberAt(record: JsonRecord, names: string[]): number | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function candidate(record: JsonRecord): Omit<TokenUsage, "samples"> | undefined {
  const inputTokens = numberAt(record, ["input_tokens", "inputTokens"]);
  const outputTokens = numberAt(record, ["output_tokens", "outputTokens"]);
  const reasoningTokens = numberAt(record, ["reasoning_tokens", "reasoningTokens"]);
  const cacheReadTokens = numberAt(record, ["cache_read_tokens", "cacheReadTokens", "cached_tokens"]);
  const explicitTotal = numberAt(record, ["total_tokens", "totalTokens"]);
  const costUsd = numberAt(record, ["cost_usd", "costUsd", "cost"]);
  const totalTokens = explicitTotal ?? (inputTokens === undefined && outputTokens === undefined && reasoningTokens === undefined && cacheReadTokens === undefined
    ? undefined
    : (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningTokens ?? 0) + (cacheReadTokens ?? 0));
  if (totalTokens === undefined && costUsd === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function openCodeStep(value: unknown): Omit<TokenUsage, "samples"> | undefined {
  if (!isRecord(value) || value.type !== "step_finish" || !isRecord(value.part) || !isRecord(value.part.tokens)) return undefined;
  const tokens = value.part.tokens;
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
  const inputTokens = numberAt(tokens, ["input"]);
  const outputTokens = numberAt(tokens, ["output"]);
  const reasoningTokens = numberAt(tokens, ["reasoning"]);
  const cacheReadTokens = cache === undefined ? undefined : numberAt(cache, ["read"]);
  const cacheWriteTokens = cache === undefined ? undefined : numberAt(cache, ["write"]);
  const totalTokens = numberAt(tokens, ["total"]);
  const costUsd = numberAt(value.part, ["cost"]);
  if (totalTokens === undefined && costUsd === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function collect(value: unknown, candidates: Array<Omit<TokenUsage, "samples">>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collect(entry, candidates);
    return;
  }
  if (!isRecord(value)) return;
  const current = candidate(value);
  if (current) candidates.push(current);
  for (const child of Object.values(value)) collect(child, candidates);
}

function maximum(values: Array<number | undefined>): number | undefined {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length === 0 ? undefined : Math.max(...known);
}

function summedUsage(usages: Array<Omit<TokenUsage, "samples">>, samples: number): TokenUsage {
  const usage: TokenUsage = { samples };
  for (const field of ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costUsd"] as const) {
    const values = usages.map((entry) => entry[field]).filter((value): value is number => typeof value === "number");
    if (values.length > 0) usage[field] = values.reduce((total, value) => total + value, 0);
  }
  return usage;
}

/** Extracts token/cost metrics from OpenCode JSON-line output, including per-step native events. */
export function usageFromOpenCodeOutput(output: string): TokenUsage | undefined {
  const steps: Array<Omit<TokenUsage, "samples">> = [];
  const candidates: Array<Omit<TokenUsage, "samples">> = [];
  for (const line of output.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      const step = openCodeStep(parsed);
      if (step === undefined) collect(parsed, candidates);
      else steps.push(step);
    } catch {
      // OpenCode can interleave human-readable lines with JSON events.
    }
  }
  // OpenCode step_finish events are independent model calls, so billed tokens add up.
  if (steps.length > 0) return summedUsage(steps, steps.length);
  if (candidates.length === 0) return undefined;
  const usage: TokenUsage = { samples: candidates.length };
  const inputTokens = maximum(candidates.map((item) => item.inputTokens));
  const outputTokens = maximum(candidates.map((item) => item.outputTokens));
  const reasoningTokens = maximum(candidates.map((item) => item.reasoningTokens));
  const cacheReadTokens = maximum(candidates.map((item) => item.cacheReadTokens));
  const cacheWriteTokens = maximum(candidates.map((item) => item.cacheWriteTokens));
  const totalTokens = maximum(candidates.map((item) => item.totalTokens));
  const costUsd = maximum(candidates.map((item) => item.costUsd));
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  if (costUsd !== undefined) usage.costUsd = costUsd;
  return usage;
}

/** Adds per-attempt cumulative values; absent provider fields remain absent rather than being reported as zero. */
export function sumAttemptUsage(usages: TokenUsage[]): TokenUsage | undefined {
  if (usages.length === 0) return undefined;
  return summedUsage(usages, usages.reduce((total, usage) => total + usage.samples, 0));
}

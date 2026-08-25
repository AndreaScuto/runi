# Runi

**Durable, verified execution for coding agents.**

Runi supervises a coding agent as a replaceable worker. It owns the job state, retry budget, checkpoints and proof of completion, so a job can be resumed after the terminal, agent process or Runi process stops.

> The agent can die. The job doesn't.

## What v0.1 does

- Persists jobs, worker attempts, checkpoints, verification runs and append-only events in local SQLite.
- Enforces a host-side wall-time and attempt budget.
- Uses an explicit state machine: `created → planning → working → verifying → reviewing → complete`.
- Treats agent completion as a proposal: only configured commands can produce successful completion evidence.
- Retries failed execution or verification, detects repeated failures, and can pause, resume or stop a job.
- Includes an OpenCode adapter and a generic command adapter for deterministic local integration.

Runi is CLI-first, local-first and intentionally single-worker in v0.1. It does not yet offer multi-agent routing, cloud execution or a web dashboard.

## Requirements

- Node.js 24 or newer (Runi uses the built-in `node:sqlite` module)
- An OpenCode executable in `PATH` to use the default adapter, or any shell command for the command adapter

## Install and build

```bash
pnpm install
pnpm run build
pnpm test
```

For local development:

```bash
pnpm run start -- help
```

After installing the package globally, the same commands are available as `runi`.

## Create a task

A Markdown file is accepted as a goal. Use JSON when you want the task's executor, verification contract and budgets to travel with the task:

```json
{
  "goal": "Add a /health endpoint and its tests.",
  "executor": {
    "kind": "opencode"
  },
  "verification": [
    { "label": "unit tests", "command": "pnpm test" },
    { "label": "typecheck", "command": "pnpm run typecheck" }
  ],
  "budget": {
    "maxAttempts": 3,
    "wallTime": "2h"
  }
}
```

The `goal` says what to do. The `verification` list is the completion contract: if any required command fails, Runi cannot mark the job complete.

## Run a job

```bash
pnpm run start -- start task.json --workdir /path/to/repository
```

Or use a task file containing only a Markdown goal and configure the contract on the command line:

```bash
pnpm run start -- start task.md \
  --agent opencode \
  --verify "pnpm test" \
  --verify "pnpm run typecheck" \
  --max-attempts 3 \
  --wall-time 2h
```

For a deterministic integration without OpenCode, use the generic command adapter. Runi supplies `RUNI_JOB_ID`, `RUNI_GOAL`, `RUNI_CONTEXT`, and `RUNI_ATTEMPT` as environment variables:

```bash
pnpm run start -- start task.md --agent command --command "./scripts/implement-task.sh" --verify "pnpm test"
```

Try the included smoke-test task with:

```bash
pnpm run start -- start examples/command-task.json
```

## Operate a durable job

Every repository keeps its Runi data in `.runi/runi.db` (ignored by Git).

```bash
runi status
runi inspect <job-id>
runi logs <job-id>
runi pause <job-id>
runi resume <job-id>
runi stop <job-id>
```

On every worker launch Runi records a checkpoint with job state and, where Git is available, the current revision and diff. If Runi or a worker exits, `runi resume <job-id>` runs the persisted job again with recovery context rather than relying on the old model session.

## Reusable benchmark: OpenCode vs OpenCode + Runi

Runi includes a paired benchmark harness for repeatable regression testing. It runs ten small deterministic coding tasks twice, each in a new disposable workspace:

- **OpenCode direct**: baseline check, one OpenCode operation, final hidden acceptance check.
- **OpenCode + Runi**: the same prompt and model via the Runi supervisor, with the same baseline and final hidden acceptance check, retry budget and wall-time budget.

The timer covers the complete operation, including verification. A task counts as successful only when the host-side hidden acceptance check exits with code 0. This prevents a worker's successful exit from being mistaken for a correct implementation.

Install and authenticate OpenCode first. On Windows, an explicit local executable keeps the benchmark isolated from global tools:

```powershell
pnpm --dir .benchmark-tools add opencode-ai
.\.benchmark-tools\node_modules\opencode-ai\bin\opencode.exe auth list
pnpm run build
pnpm run benchmark -- run `
  --opencode .\.benchmark-tools\node_modules\opencode-ai\bin\opencode.exe `
  --count 10 `
  --max-attempts 3 `
  --wall-time 10m
```

Use `--model provider/model` to pin the same model in both modes. On macOS/Linux, pass the corresponding `opencode` executable path. The run writes an ignored, timestamped directory under `benchmarks/runs/` containing:

- `BENCHMARK_REPORT.md`: verified-completion rate, total/mean/median/P95 execution time, retries, token/cost comparison and per-operation table.
- `summary.json`: complete structured evidence, including verifier outputs and paths to the isolated workspaces.
- `cases.csv`: one row per operation for spreadsheets or CI analysis.
- `cases/<scenario>/<mode>/worker.log`: raw worker output.

When OpenCode/provider JSON output exposes token or cost telemetry, the report aggregates it by independent worker attempt and shows **tokens/cost saved by Runi** (or additional usage, if negative). If the selected provider does not expose those fields, the report explicitly shows `N/A`; it never invents zero token or cost usage.

Regenerate a Markdown/CSV report from an existing JSON run without consuming more model tokens:

```bash
pnpm run benchmark -- report benchmarks/runs/<run-directory>
```

## Lifecycle and evidence

```text
created → planning → working → verifying → reviewing → complete
                         │             │
                         └── repairing ◀┘

working / verifying / repairing → paused | failed | cancelled | budget_exceeded
```

The worker's zero exit code only moves a job to `verifying`. Runi reaches `complete` only after every final verification command exits successfully. The command results and output are stored as evidence in SQLite.

## Project scope

Runi v0.1 is the durable single-agent supervisor. Future work may add richer recovery policies, other agent adapters, independent reviewers, usage/cost budgets, multi-agent scheduling and remote control — none of those are required for the core local workflow.

## License

Apache-2.0. See [LICENSE](LICENSE).

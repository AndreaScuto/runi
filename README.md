# Runi

**Durable, verified execution for coding agents.**

Launch a coding job, let your agent work, and come back later. Runi keeps the job state, budgets, recovery history, and proof of completion outside the agent session.

> The agent can die. The job doesn't.

## Why Runi?

Coding agents run in sessions. Real engineering work is a job that may outlive a terminal, a provider connection, or one model context.

Runi adds the control layer around an existing agent:

- **Durable jobs** — state survives Runi and worker process restarts.
- **Verified completion** — a worker cannot declare its own success; required commands must pass.
- **Bounded execution** — wall-time and attempt budgets are enforced by the host.
- **Recovery** — failed execution or verification becomes another persisted attempt.
- **Auditability** — events and verification evidence live in local SQLite.
- **Agent independence** — OpenCode is an adapter, not the runtime.

Runi is local-first, CLI-first, and intentionally single-worker today.

## Try it in two minutes

You need Node.js 24 or newer and pnpm.

```bash
pnpm install
pnpm run check
pnpm run start -- start examples/command-task.json
```

The example completes only after the configured verification succeeds:

```text
JOB rn_7c16257b199e401a
State       COMPLETE
Attempts    1 / 2
```

The example uses a deterministic command worker, so it does not require an AI provider or consume model tokens.

## How it works

```text
Task + completion contract
          ↓
   Runi Supervisor  ← budgets, events, recovery
          ↓
  replaceable worker
          ↓
 independent verification
          ↓
     COMPLETE only with evidence
```

A worker exit code of zero means only “ready to verify.” Runi persists `complete` only after every required final command passes.

## Define a job

JSON keeps the goal, executor, verification contract, and budgets together:

```json
{
  "goal": "Add a /health endpoint and its tests.",
  "executor": {
    "kind": "opencode"
  },
  "verification": [
    { "label": "tests", "command": "pnpm test" },
    { "label": "typecheck", "command": "pnpm run typecheck" }
  ],
  "budget": {
    "maxAttempts": 3,
    "wallTime": "2h"
  }
}
```

Then run it against the target repository:

```bash
pnpm run start -- start task.json --workdir /path/to/repository
```

A Markdown file can be used as the goal when the completion contract is supplied on the command line:

```bash
pnpm run start -- start task.md \
  --agent opencode \
  --verify "pnpm test" \
  --verify "pnpm run typecheck" \
  --max-attempts 3 \
  --wall-time 2h
```

OpenCode must be installed and authenticated for agent-backed jobs. Pin a model with `--opencode-model provider/model` when reproducibility matters.

## Operate a durable job

Runi stores local state in `<workdir>/.runi/runi.db`.

```bash
runi status
runi inspect <job-id>
runi logs <job-id>
runi pause <job-id>
runi resume <job-id>
runi stop <job-id>
```

`resume` starts a fresh worker with bounded recovery context and the current repository state. It does not depend on restoring the previous model session.

## Use a deterministic command worker

The generic command adapter is useful for integration tests and ordinary automation:

```bash
runi start task.md \
  --agent command \
  --command "./scripts/implement-task.sh" \
  --verify "pnpm test"
```

Runi provides `RUNI_JOB_ID`, `RUNI_GOAL`, `RUNI_CONTEXT`, and `RUNI_ATTEMPT` to the command environment.

## Evidence and recovery

The current lifecycle is deliberately small:

```text
created → working → verifying → complete
             │          │
             └ repairing ◀

working / verifying / repairing
  → paused | failed | cancelled | budget_exceeded
```

Baseline checks record the repository's initial condition. Final checks decide completion. Failed workers and failed verification are persisted with fingerprints so Runi can retry without looping forever on the same failure.

## Benchmark

Runi includes a reusable paired harness that runs the same task, model, prompt, workspace, and hidden acceptance verifier through:

1. OpenCode directly;
2. OpenCode supervised by Runi.

The latest published [10×2 benchmark](benchmarks/reports/2026-08-25-mimo-v2.5-free.md) reached 10/10 independently verified completions in both modes. That sample observed 9.1% fewer tokens and 11.4% less total time with Runi; it is evidence from one paired run, not a universal performance claim.

```powershell
pnpm run build
pnpm run benchmark -- run `
  --opencode .\.benchmark-tools\node_modules\opencode-ai\bin\opencode.exe `
  --model opencode/mimo-v2.5-free `
  --count 10
```

Reports include Markdown, JSON, CSV, raw worker logs, verification evidence, duration, attempts, retries, and provider telemetry. Missing token or cost telemetry is reported as `N/A`, never zero.

## Project direction

- **v0.1:** durable, verified, bounded single-worker supervisor.
- **v0.2 (next):** adaptive recovery — failure classification, progress detection, recovery strategy selection, fault-injection benchmarks, and Leo's supervision experience.
- Later versions may add structured execution knowledge, multiple workers, and provider-aware routing only after the simpler runtime proves its value.

Not in the current core: web dashboard, cloud service, multi-agent scheduling, automatic provider switching, or repository rollback.

## Develop

```bash
pnpm install
pnpm run build
pnpm test
pnpm run check
```

Runi uses TypeScript, Node.js, built-in `node:sqlite`, and the Node test runner. There are no runtime dependencies.

## License

Apache-2.0. See [LICENSE](LICENSE).

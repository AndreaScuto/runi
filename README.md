# Runi

**Durable, verified execution for coding agents.**

Launch a coding job, let your agent work, and come back later. Runi keeps the job state, budgets, recovery history, and proof of completion outside the agent session.

> The agent can die. The job doesn't.

🐕 **Leo is watching.** He is Runi's mascot and the CLI signal that your worker is still being supervised.

## Why Runi?

Coding agents run in sessions. Real engineering work is a job that may outlive a terminal, a provider connection, or one model context.

Runi adds the control layer around an existing agent:

- **Durable jobs** — state survives Runi and worker process restarts.
- **Verified completion** — a worker cannot declare its own success; required commands must pass.
- **Bounded execution** — wall-time and attempt budgets are enforced by the host.
- **Recovery** — failed execution or verification becomes another persisted attempt.
- **Auditability** — events and verification evidence live in local SQLite.
- **Agent independence** — OpenCode, Codex CLI, and Claude Code are replaceable adapters, not the runtime.

Runi is local-first, CLI-first, and intentionally single-worker today.

## Install

Starting with the stable v0.2 release, Runi is a public npm package. No GitHub login or package token is required:

```bash
npm install --global @andreascuto/runi
runi
```

`runi` opens a persistent terminal session led by Leo and immediately asks what job to run. Describe the job to enter the standard guided flow, or enter `/` to open the command picker. Runi presents selectable choices for agents, budgets, policies, persisted jobs, and AI suggestions; typing is reserved for goals, commands, models, and custom answers.

```text
   / \__
  (    @\___
  /         O
 /   (_____/
/_____/   U

What should Runi do? Build a health endpoint and its tests
```

Use `/help` inside the session for every operation and `/exit` when Leo can clock off. `/doctor` checks every supported coding agent; `/settings` disables unavailable agents and saves the selected executable's absolute path with the workspace defaults under `.runi/`. Direct commands such as `runi start` and `runi status` remain stable for scripts and experienced users.

## Try it in two minutes

You need Node.js 24 or newer and pnpm.

```bash
pnpm install
pnpm run check
pnpm run start -- start examples/command-task.json
```

During the run, Leo exposes the persisted job state:

```text
🐕 Leo · supervising rn_7c16257b19 · WORKING · attempt 1/2 · 1s

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

Prefer prompts? Give Runi only the job. Guided mode asks for the worker, model, budgets, and verification policy, saves the resulting JSON under `<workdir>/.runi/tasks/`, and starts it through the same Supervisor:

```bash
runi start --guided "Add a /health endpoint and its tests" --workdir /path/to/repository
```

Choose `manual` to enter verification commands yourself or `ai` to ask the selected coding agent for suggestions. In the interactive session, every AI command has selectable `Keep`, `Edit`, and `Remove` actions; edited and additional commands remain free text.

For a short or ambiguous idea, grill mode asks the selected agent to propose concrete implementation alternatives before creating the task:

```bash
runi start --grill "Add durable caching" --workdir /path/to/repository
```

Select an answer for each question or choose `Custom answer…`. Runi persists the original job plus your decisions in the generated goal so the worker receives the intended implementation direction. AI guidance runs with read-only analysis settings; it remains untrusted advice, never completion evidence.

A Markdown file can be used as the goal when the completion contract is supplied on the command line:

```bash
pnpm run start -- start task.md \
  --agent opencode \
  --verify "pnpm test" \
  --verify "pnpm run typecheck" \
  --max-attempts 3 \
  --wall-time 2h
```

## Choose your coding agent

The selected CLI must already be installed and authenticated. Check the setup before creating a job:

```bash
runi doctor
```

Each agent is reported as `READY`, `NOT FOUND`, `NOT AUTHENTICATED`, or `NOT EXECUTABLE`, with its resolved path or a corrective action. Discovery supports native executables and package-manager shims on Windows (`.exe`, `.cmd`, `.bat`, npm, pnpm, WinGet), macOS, and Linux.

Runi reuses the login already owned by OpenCode, Codex CLI, or Claude Code. It never asks for, reads, or stores an API key. Run the agent's own login command when `/doctor` reports an authentication problem. Environment-based credentials and free models remain the selected CLI's responsibility.

| `--agent` | Worker CLI | Default executable |
|-----------|------------|--------------------|
| `opencode` | OpenCode | `opencode` |
| `codex` | Codex CLI | `codex` |
| `claude` | Claude Code | `claude` |

```bash
runi start task.json --agent codex --model <model-id>
runi start task.json --agent claude --model <model-id>
```

Use `--binary <path>` for a non-standard installation. `/settings` resolves normal global installs automatically and persists the absolute executable path, so subsequent jobs do not depend on ambiguous shell lookup. The older `--opencode-binary` and `--opencode-model` flags remain accepted for v0.1 compatibility. Agent selection is explicit per job; Runi does not silently switch provider or model.

The adapters do not bypass vendor safety controls. Codex runs with a writable-workspace sandbox and no interactive approval prompts; Claude Code runs in `acceptEdits` mode. Project or user settings may restrict additional shell commands, while Runi's verification still runs independently.

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

## Meet Leo 🐕

Leo does not write code and does not make lifecycle decisions. He simply shows that Runi is still supervising the active job.

His terminal face and sunny `#ffc000` accent make supervision easy to spot without turning status into decoration. Yellow means Runi; success and failure keep their own semantic colors.

In an interactive terminal, Leo's line updates in place with state, attempt budget, and elapsed time. In logs and CI, Runi prints one stable supervision line instead of terminal animation.

If Leo says `WORKING`, the worker is working. If Runi says `COMPLETE`, the evidence passed. Leo never guesses.

## Use a deterministic command worker

The generic command adapter is useful for integration tests and ordinary automation:

```bash
runi start task.md \
  --agent command \
  --command "./scripts/implement-task.sh" \
  --verify "pnpm test"
```

Runi provides `RUNI_JOB_ID`, `RUNI_GOAL`, `RUNI_CONTEXT`, and `RUNI_ATTEMPT` to the command environment.

This is also the escape hatch for another globally installed CLI: choose `command` and provide its normal non-interactive command line. Runi does not guess whether an arbitrary executable is a coding agent or how it authenticates.

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
- **v0.2 (in development):** adaptive recovery, agent-agnostic OpenCode/Codex/Claude execution, fault-injection benchmarks, and Leo's supervision experience.
- Later versions may add structured execution knowledge, multiple workers, and provider-aware routing only after the simpler runtime proves its value.

Not in the current core: web dashboard, cloud service, multi-agent scheduling, automatic provider switching, or repository rollback.

## Develop

```bash
pnpm install
pnpm run build
pnpm test
pnpm run check
```

Runi uses TypeScript, Node.js, built-in `node:sqlite`, the Node test runner, and Clack for accessible terminal selection prompts.

## License

Runi v0.2 and later are licensed under `AGPL-3.0-only`. If you distribute a modified version, or let users interact with one over a network, you must offer its corresponding source under the same license. See [LICENSE](LICENSE).

The published v0.1.0 release remains available under Apache-2.0; rights already granted for that release are unchanged.

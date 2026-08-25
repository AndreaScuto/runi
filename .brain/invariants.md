# Domain invariants

## Completion and recovery

- A job without at least one independent verification command cannot complete.
- An AI-suggested verification policy must be shown to the user and remain editable, removable, and extensible before any suggested command can execute.
- Baseline verification records initial conditions; failure is allowed because fixing that failure may be the task.
- A worker success can only advance the job to verification. Every required final check must pass before `complete` is persisted.
- Attempt and wall-time budgets are host-enforced and remain cumulative across retries and process restarts.
- Pause and cancellation are cooperative host requests. A terminal job must never launch another worker.
- Repeated equivalent failures must stop a stagnant loop before retries become unbounded.

## Benchmark integrity

- Direct OpenCode and OpenCode through Runi use the same executable, pinned model, prompt, initial workspace, and hidden acceptance contract.
- Each case uses a disposable workspace, and success is determined by hidden host-side verification rather than worker claims.
- Missing provider token or cost telemetry is `N/A`, never zero.
- A paired benchmark is sample evidence, not a universal claim about quality, speed, or savings. Report execution order, retries, missing telemetry, and known biases with the result.

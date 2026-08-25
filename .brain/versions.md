# Product versions

Versions describe product outcomes, not a backlog. Code structure and implementation status belong to GitNexus and the source.

## v0.1 — Persistent single-worker supervisor

Own a local job beyond one agent session and complete it only with host-side evidence. The core includes persistence, lifecycle, verification, retry, bounded execution, basic stagnation detection, pause/resume, and diagnostic events.

## v0.2 — Adaptive supervisor (next target)

Make recovery explainable and evidence-driven: classify failures, detect meaningful progress, select an explicit recovery strategy, and validate recovery through deterministic fault injection. Keep one supervised worker; do not add provider switching, automatic rollback, or multi-agent scheduling yet.

Leo 🐕 becomes the product's supervision signal in this version. The CLI should make active supervision visible, while documentation introduces the mascot without assigning it architectural authority.

## v0.3 — Structured intelligence

Represent the work to perform, runtime knowledge, and evidence relationships through an Execution Graph and a logical Knowledge Layer. Reuse GitNexus for code intelligence instead of duplicating repository symbols, dependencies, or callers.

## v0.4 — Multi-agent runtime

Add multiple workers only after adaptive single-worker recovery is measured: dependency scheduling, parallel work, incremental verification, and reconciliation of independently produced changes.

## v0.5 — Adaptive execution runtime

Allow dynamic worker creation and pluggable execution policies when real workloads demonstrate that the fixed runtime is insufficient.

## v0.6+ — Multi-provider runtime

Route across providers and models using declared capabilities, availability, verified outcomes, time, and cost. Job-level budgets remain authoritative.

## v1.x — Autonomous execution runtime

Deliver persistent execution intelligence and verified learning while preserving provider independence, local usefulness, and evidence-based completion.

## Release discipline

Do not pull features forward merely because a later version names them. Promote a version only when its outcome is covered by repeatable tests or benchmarks, documented limitations, and a stable local workflow.

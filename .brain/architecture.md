# Architectural intent

## Control and trust

Runi is a host-side control plane around a replaceable coding worker. The host owns job state, budgets, recovery, and proof; worker output and a zero exit code are observations, never authority to declare completion.

Independent verification is the trust boundary. New adapters or execution modes must preserve host control instead of delegating lifecycle decisions to the model or provider.

Guided and grill modes are task-authoring layers, not alternate runtimes. They must emit an ordinary reusable task definition and enter the same parser, Supervisor, budgets, and verification boundary as a hand-written task. AI-generated implementation choices and verification commands are untrusted suggestions produced with read-only agent settings; the user owns the final task and must be able to edit or remove every suggested verification command before it can run.

## Meaning of durability

Durability means a fresh worker can continue from persisted task state, evidence, bounded prior context, and the current working tree. It does not mean restoring a model session, replaying every interaction, or rolling the repository back to a snapshot.

Recovery markers are audit and orientation points. They deliberately avoid a checkpoint/restore subsystem until a demonstrated use case justifies one.

## Deliberate scope

The first product boundary is local and single-worker. Worker execution is CLI-agent agnostic: OpenCode, Codex CLI, and Claude Code are manually selected replaceable workers behind the same contract. Multi-agent scheduling, remote control, automatic provider/model routing, and reviewer hierarchies remain separate product decisions.

Adapters must use each CLI's non-interactive mode without bypassing its sandbox or permission system. A worker blocked by vendor policy fails normally and enters Runi recovery; adapter convenience must not expand host authority or weaken the verification boundary.

Persistence favors an append-only evidence trail and non-destructive compatibility with existing local databases. Obsolete legacy tables may remain harmlessly; migrations must not erase a user's job history merely to make the schema tidy.

The generic command executor is a deterministic seam for integration tests and non-agent automation, not a second agent framework.

## Brand boundary

Leo 🐕 is Runi's mascot and the visible sign that a job is being supervised. Leo belongs in CLI status, documentation, community, and future presentation layers; Leo is not a runtime component and never owns lifecycle decisions. Any Leo UI must reflect persisted Runi state rather than inventing a second status model.

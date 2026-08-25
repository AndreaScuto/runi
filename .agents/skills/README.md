# Codex Second Brain

Two dependency-free Codex skills for keeping small, durable repository knowledge alongside a GitNexus code graph.

- `second-brain-init` inspects a repository and creates a progressively retrieved `.brain` plus compact routing in `AGENTS.md`.
- `second-brain-maintain` updates that knowledge after significant changes and makes no edit when the source or graph already tells the full story.

## Division of responsibility

`.brain` stores architectural intent, domain invariants, decision rationale, non-obvious constraints, active migrations or accepted debt, and repeatable development workflows.

GitNexus remains the source of truth for files, symbols, dependencies, callers, execution flows, and blast radius. The skills reject changelogs, task notes, file maps, source summaries, and boilerplate.

## Requirements

- Codex with repository skills enabled.
- An indexed GitNexus repository and its MCP tools available to Codex.
- An existing `AGENTS.md`, or permission for the initialization skill to create one.

## Install

Clone or download this repository, then copy both directories under `skills/`.

For one project:

```text
<project>/.agents/skills/second-brain-init/
<project>/.agents/skills/second-brain-maintain/
```

For personal Codex use:

```text
$CODEX_HOME/skills/second-brain-init/
$CODEX_HOME/skills/second-brain-maintain/
```

Each directory must contain its `SKILL.md` directly.

## Use

Ask Codex to use `second-brain-init` once when adding the knowledge layer to a repository. It will inspect existing instructions, documentation, repository state, and relevant GitNexus flows before writing the smallest useful `.brain`.

Use `second-brain-maintain` after a significant architectural, domain, migration, debt, or development-workflow change. It edits only the relevant page, replaces stale knowledge instead of appending history, and leaves `.brain` untouched for ordinary code changes.

The intended session flow is:

```text
task -> relevant .brain page -> GitNexus -> minimum code -> impact -> change + tests -> durable knowledge update, if needed
```

## License

Apache-2.0.

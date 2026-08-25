---
name: second-brain-init
description: Create or retrofit a lightweight repository Second Brain backed by GitNexus. Use when asked to implement, bootstrap, or design persistent project knowledge without duplicating code structure, symbols, dependencies, callers, Git history, or changelogs.
---

# Initialize a Second Brain

Build the smallest useful memory layer for a repository.

1. Inspect `AGENTS.md`, existing documentation, and repository status. Query the GitNexus repository context, clusters, and relevant execution flows before opening broad areas of code.
2. Extract only knowledge that is durable and hard to infer: architectural intent, domain invariants, decision rationale, non-obvious constraints, active migrations or accepted debt, and important development workflows.
3. Create `.brain/` with a few topic files. Omit any empty category. Prefer `architecture.md`, `invariants.md`, `state.md`, and `workflows.md` only when each has real content.
4. Add a compact router to `AGENTS.md`: read only relevant brain pages, then query GitNexus, inspect minimum code, check impact, implement, test, and update the brain only if durable knowledge changed.
5. Verify every sentence. Remove file maps, symbol lists, dependency descriptions, code summaries, commit history, task logs, speculative roadmaps, and boilerplate.

Do not instruct agents to read the whole repository or `.brain`. Preserve generated GitNexus blocks and place custom instructions outside their markers.

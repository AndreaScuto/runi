---
name: second-brain-maintain
description: Maintain a repository's lightweight .brain after significant architectural, invariant, design-decision, constraint, migration, debt, or development-workflow changes. Do not use for ordinary code edits, graph facts, changelogs, or transient task status.
---

# Maintain a Second Brain

Use this only when durable project knowledge may have changed.

1. Read the `AGENTS.md` router and only the relevant `.brain` page.
2. Query GitNexus for the current structure and blast radius; never encode graph-derived file, symbol, caller, or dependency maps in documentation.
3. Decide whether the change altered intent, an invariant, rationale, a non-obvious constraint, an active migration/debt item, or a repeatable workflow. If not, stop without editing `.brain`.
4. Edit the smallest existing page. Create a page only for a distinct topic that will receive durable knowledge.
5. Replace or delete stale statements rather than appending a history entry. Keep rationale and operational consequences; remove code summaries, diffs, completed task notes, ownerless TODOs, and speculation.
6. Check links and review `git diff -- AGENTS.md .brain .agents/skills`. If code changed, run the repository's normal tests and GitNexus change detection before commit.

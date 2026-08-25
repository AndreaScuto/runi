<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **runi** (397 symbols, 1253 relationships, 33 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/runi/context` | Codebase overview, check index freshness |
| `gitnexus://repo/runi/clusters` | All functional areas |
| `gitnexus://repo/runi/processes` | All execution flows |
| `gitnexus://repo/runi/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## Second Brain

Use `.brain/` only for durable knowledge that code and GitNexus do not explain well. Never read the whole directory by default.

### Route by task

| Need | Read |
|------|------|
| Product boundaries, trust model, architectural intent | `.brain/architecture.md` |
| Completion, durability, budget, or benchmark rules | `.brain/invariants.md` |
| Active migration, accepted debt, or current limitations | `.brain/state.md` |
| Product milestones, current release target, or version scope | `.brain/versions.md` |
| Test, database, benchmark, or documentation workflow | `.brain/workflows.md` |

### Working order

1. Read only the relevant `.brain` page, if any.
2. Query GitNexus for execution flows, symbols, dependencies, callers, and blast radius.
3. Inspect the minimum code needed to confirm the change.
4. Run `impact` before editing symbols and report its risk as required above.
5. Implement and run the proportionate tests.
6. Update `.brain` only when a durable intent, invariant, decision, constraint, migration, debt item, or workflow changed.

GitNexus remains the source of truth for code structure. Do not copy graph facts, source summaries, Git history, task logs, or transient status into `.brain`. For significant durable changes, use `.agents/skills/second-brain-maintain/SKILL.md`.

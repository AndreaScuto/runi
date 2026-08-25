# Development workflows

## Choose tests by risk

- For any code change, run `pnpm run check`.
- For lifecycle, storage, adapter, command-launch, or recovery changes, also run the CLI end-to-end in a disposable directory and confirm terminal state plus persisted verification evidence.
- For database changes, test both a new database and an existing compatible database. Prefer additive migrations; require explicit rationale and a recovery plan for destructive ones.
- For benchmark protocol or reporting changes, first use the deterministic paired test harness. Run paid or rate-limited model benchmarks only when fresh empirical results are part of the task, and retain raw JSON/CSV/log artifacts with the report.

## Maintain durable knowledge

After a significant change, use `.agents/skills/second-brain-maintain/SKILL.md`. Edit the smallest relevant page, replace stale statements instead of appending history, and leave `.brain` untouched when code and GitNexus already tell the full story.

## Publish a stable release

- Set `package.json` to the exact release version before publishing the matching `v<version>` GitHub Release.
- Run the full regression suite and inspect the package tarball before publishing the release.
- A stable GitHub Release publishes `@andreascuto/runi` to GitHub Packages through the repository-scoped `GITHUB_TOKEN`; never store a registry token in the repository.

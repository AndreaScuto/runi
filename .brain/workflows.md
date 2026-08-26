# Development workflows

## Choose tests by risk

- For any code change, run `pnpm run check`.
- For lifecycle, storage, adapter, command-launch, or recovery changes, also run the CLI end-to-end in a disposable directory and confirm terminal state plus persisted verification evidence.
- For database changes, test both a new database and an existing compatible database. Prefer additive migrations; require explicit rationale and a recovery plan for destructive ones.
- For benchmark protocol or reporting changes, first use the deterministic paired test harness. Run paid or rate-limited model benchmarks only when fresh empirical results are part of the task, and retain raw JSON/CSV/log artifacts with the report.

## Maintain durable knowledge

After a significant change, use `.agents/skills/second-brain-maintain/SKILL.md`. Edit the smallest relevant page, replace stale statements instead of appending history, and leave `.brain` untouched when code and GitNexus already tell the full story.

## Publish a stable release

- Never create a pull request targeting `main`, or merge v0.2 or later into `main`, without an explicit user request in the current task. Keep ordinary development on its active branch.
- Set `package.json` to the exact release version before publishing the matching `v<version>` GitHub Release.
- Run the full regression suite and inspect the package tarball before publishing the release.
- Stable GitHub Releases publish public package `@andreascuto/runi` through npm trusted publishing (GitHub Actions OIDC); keep `id-token: write` and never store a registry token in the repository. Because npm can attach a trusted publisher only to an existing package, bootstrap the package once with a maintainer-authenticated prerelease, configure this repository/workflow as its trusted publisher, then let the first stable GitHub Release publish the stable version.

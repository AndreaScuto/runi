# Current project state

- The v0.1 core is the released durable, verified, local single-worker supervisor. The active product target is v0.2: adaptive recovery plus a small Leo-branded supervision experience; keep it single-worker and CLI-first.
- Recovery is intentionally lightweight: persisted events and current repository state, with a fresh worker context. Session restoration and repository rollback are not implemented.
- Existing databases may contain tables from the earlier checkpoint/worker-record design. They are tolerated for compatibility; destructive cleanup is deferred until there is a real migration need and a tested upgrade path.
- Independent reviewers, usage/cost budgets, multi-agent scheduling, remote execution, and a web control plane are absent capabilities, not commitments.
- The existing live paired benchmark demonstrates independently verified correctness parity for its sample. Because it did not exercise retries or injected failures, it is not evidence for recovery effectiveness; use fault injection or repeated counterbalanced runs for that claim.

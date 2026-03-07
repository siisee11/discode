# Quality Score

Canonical for: the repository's current quality bar and the evidence used to judge it
Audience: contributors evaluating readiness, regressions, or validation scope
Update when: the quality bar changes or major verification gaps are opened or closed

Current scorecard:

| Area | Current posture | Evidence |
| --- | --- | --- |
| TypeScript correctness | strong baseline | `npm run typecheck`, `tests/**` |
| Rust component correctness | targeted coverage exists | `daemon-rs` and `runtime-client-rs` cargo tests, sidecar tests |
| Runtime contract stability | explicitly documented | `docs/RUNTIME_WINDOW_API.md`, `docs/DAEMON_RUST_MIGRATION.md` |
| Site validation | weaker than core runtime coverage | landing page and docs pages are mostly validated manually |
| Documentation freshness | improving, still being normalized | indexes in `docs/`, legacy flat docs remain |

Use this document as a scorecard, not a substitute for test results. The canonical operational and reliability details live in [`RELIABILITY.md`](RELIABILITY.md).

# Reliability Map

Canonical for: runtime reliability expectations, operational checks, and failure-oriented references
Audience: contributors touching daemon lifecycle, runtime control, stream delivery, or release operations
Update when: SLOs, recovery guidance, or operational responsibilities change

Start here for reliability topics:

- Architecture and process model: [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- Operational procedures: [`operations/index.md`](operations/index.md)
- Runtime diagnostics: [`references/pty/PTY_RUNTIME_DIAGNOSTICS.md`](references/pty/PTY_RUNTIME_DIAGNOSTICS.md)
- PTY Rust SLO gates: [`references/pty/PTY_RUST_PHASE8_SLO_CANARY.md`](references/pty/PTY_RUST_PHASE8_SLO_CANARY.md)
- Rust daemon SLO gates: [`DAEMON_RUST_PHASE7_SLO_CANARY.md`](DAEMON_RUST_PHASE7_SLO_CANARY.md)
- Runtime window contract: [`references/RUNTIME_WINDOW_API.md`](references/RUNTIME_WINDOW_API.md)
- Rollout/readiness runbook: [`operations/runtime-rollout-readiness.md`](operations/runtime-rollout-readiness.md)

Reliability facts that should stay true:

- daemon control and runtime APIs are treated as compatibility surfaces
- Rust daemon is the shipped daemon backend; TypeScript daemon startup/fallback paths are retired from active operation
- daemon restarts matter after bridge/runtime/import-path changes
- browser-harness boot uses health checks and deterministic worktree ports instead of blind sleeps
- release operations must include web and package updates when applicable
- reliability gates require runtime regression and stress suites to remain green before release promotion

Current reliability gate commands:

- `npm run test:runtime:pty-rust`
- `cargo test --manifest-path daemon-rs/Cargo.toml runtime_stream`
- `cargo test --manifest-path sidecar/pty-rust/Cargo.toml`
- `npm run test:daemon-contract` (run in an environment where Vitest can write inside the worktree)

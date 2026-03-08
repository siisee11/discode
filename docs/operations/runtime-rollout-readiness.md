# Runtime Rollout Readiness

Canonical for: release-time reliability evidence for `pty-rust` runtime and Rust daemon replacement posture
Audience: maintainers preparing rollout/promotion or auditing migration completion evidence
Update when: readiness gates, required commands, or known non-blocking constraints change

## Current shipped posture

- Rust daemon is the active daemon backend in production startup flow.
- Runtime modes allowed in production are `tmux` and `pty-rust`.
- Runtime stream/native attach transport currently targets macOS/Linux.

## Required readiness checks

Run these before release/promotion and capture pass/fail output in release notes or plan evidence:

1. `npm run test:runtime:pty-rust`
2. `cargo test --manifest-path daemon-rs/Cargo.toml runtime_stream`
3. `cargo test --manifest-path sidecar/pty-rust/Cargo.toml`
4. `npm run test:daemon-contract`

If any required suite fails, treat rollout as blocked until resolved or explicitly dispositioned.

## Known environment constraints

These are environment restrictions, not product regressions, when observed in restricted sandboxes:

- `npm run test:daemon-contract` can fail with Vitest write-permission errors when `node_modules` is outside writable roots.
- `tests/runtime/runtime-stream-client.test.ts` can fail with UDS `listen EPERM` where Unix socket bind is restricted.

Rerun affected suites in an unrestricted environment before final release signoff.

## RC-02 disposition

`RC-02` (Windows runtime transport parity) is currently dispositioned as non-blocking for this migration closure because:

- the runtime-native contract explicitly targets macOS/Linux first and treats Windows named-pipe support as follow-up work,
- production runtime mode surface remains bounded to `tmux` and `pty-rust`, and
- reliability gates above continue to enforce the supported-platform behavior.

Track Windows named-pipe parity as a separate follow-up effort; do not silently treat it as shipped.

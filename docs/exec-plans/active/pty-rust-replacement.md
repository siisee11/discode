# PTY Rust Replacement Plan

Canonical for: completing PTY/runtime and Rust-daemon replacement exit criteria with compatibility-first rollout discipline  
Audience: contributors working on runtime, daemon, compatibility tests, and rollout readiness  
Update when: milestone status changes, scope shifts, or rollout gates change

## Goal / scope

Finish the remaining `pty-rust` and Rust-daemon replacement work so production behavior is fully compatible with current CLI/control-plane contracts and documented as the canonical default path.

In scope:

- close remaining parity gaps called out by active migration references
- validate compatibility against real-world fixtures for config/state/hook/runtime contracts
- complete stability-gate and rollout-readiness checks
- update canonical docs to reflect shipped replacement posture

Out of scope:

- new product features unrelated to replacement parity
- changing public runtime/control contracts beyond compatibility-preserving fixes

## Background

- `ARCHITECTURE.md` defines `pty-rust` as the PTY runtime backend and `daemon-rs` as the Rust daemon path.
- `docs/exec-plans/active/README.md` identifies this as active migration work with remaining rollout and compatibility checks.
- `docs/references/PTY_RUST_ARCHITECTURE_CONTRACT.md` defines target sidecar boundaries and migration guardrails.
- `docs/references/DAEMON_RUST_MIGRATION.md` documents frozen daemon contracts and remaining parity expectations.
- `docs/references/pty/PTY_RUST_PHASE8_SLO_CANARY.md` defines operational promotion gates that must stay green.

## Milestones

1. [x] Contract and gap-baseline pass (status: completed 2026-03-09): produced an implementation checklist of unresolved parity items across runtime control, stream protocol, hook routes, and compatibility loading.
2. [ ] Rust daemon endpoint parity pass (status: not started): close any remaining `/runtime/*`, hook-route, and stream error/shape mismatches and add focused contract tests.
3. [ ] Compatibility fixture pass (status: not started): assemble and validate representative config/state/project fixtures (including legacy aliases/maps) against Rust compatibility loaders and persistence behavior.
4. [ ] PTY/runtime reliability pass (status: not started): run and fix targeted PTY runtime and stream stress checks required by SLO/canary references.
5. [ ] Rollout evidence and docs sync pass (status: not started): update canonical architecture/reliability/operations docs and execution-plan evidence so replacement status is auditable and ready to move to completed.

## Current progress

- Milestone 1 is complete with an evidence-backed unresolved parity checklist (below) and explicit scope for Milestones 2-3.
- Rust daemon unit coverage remains green:
  - passed: `cargo test --manifest-path daemon-rs/Cargo.toml`
- Contract-suite execution blocker in this sandbox:
  - `npm run test:daemon-contract` failed before test execution because `node_modules` resolves to `/Users/dev/git/discode/node_modules` (outside writable roots) and Vitest could not write `node_modules/.vite-temp/*` (`EPERM`).

## Milestone 1 output: unresolved parity checklist

### Runtime control

- [ ] `RC-01` Add daemon-rs runtime route contract tests for `/runtime/buffer`, `/runtime/focus`, `/runtime/input`, `/runtime/stop`, and `/runtime/ensure` status/body mappings; current Rust HTTP tests mostly cover auth/rate-limit/opencode-event/send-files and do not exercise the full runtime route matrix.
  - Evidence: `daemon-rs/src/hook_server.rs` tests at lines 965-1260.
- [ ] `RC-02` Close OS parity gap for runtime transport on Windows; daemon-rs runtime control/stream currently use Unix socket APIs directly.
  - Evidence: `daemon-rs/src/runtime_control.rs` uses `std::os::unix::net::UnixStream`; `daemon-rs/src/runtime_stream.rs` uses `std::os::unix::net::{UnixListener, UnixStream}`.

### Stream protocol

- [ ] `SP-01` Resolve v1 stream payload-shape drift: TS v1 emits `frame|patch|frame-styled|patch-styled` directly while daemon-rs v1 currently emits `frame-styled` with nested `frame`.
  - Evidence: TS emitter `src/runtime/stream-frame-renderer.ts` lines 147-230; daemon-rs emitter `daemon-rs/src/runtime_stream.rs` lines 583-587.
  - Compatibility shim evidence: runtime stream client explicitly handles daemon-rs `frame-styled` envelope shape in `tests/runtime/runtime-stream-client.test.ts` lines 140-196.
- [ ] `SP-02` Decide whether daemon-rs v1 should implement `patch`/`patch-styled` parity or formally narrow the v1 contract and update migration references accordingly.
  - Evidence: baseline v1 patch emissions exist in TS renderer (`src/runtime/stream-frame-renderer.ts` lines 147-157 and 216-223); daemon-rs stream path currently has no patch emission branch.

### Hook routes

- [ ] `HR-01` Align `/runtime/ensure` adapter-not-found behavior with TS baseline (`404 Agent adapter not found`); daemon-rs currently does not validate adapter availability and will build a command for arbitrary `agentType`.
  - Evidence: TS route guard `src/bridge/hook-runtime-routes.ts` lines 151-153; daemon-rs ensure path `daemon-rs/src/hook_server.rs` lines 242-327 and command builder fallback `daemon-rs/src/hook_server.rs` lines 876-907.

### Compatibility loading

- [ ] `CL-01` Build a shared fixture corpus (realistic config/state/project JSON) consumed by both TS and daemon-rs compatibility tests; current coverage relies on inline synthetic payloads.
  - Evidence: daemon-rs compat tests in `daemon-rs/src/compat.rs` lines 417-560; TS state/config compatibility tests in `tests/state/state-compatibility.test.ts` and `tests/config/index.test.ts`.

## Key decisions

- Keep replacement work compatibility-first: preserve existing CLI, runtime-control, and stream contracts while closing gaps.
- Use boundary-validation and contract tests as the source of truth for parity signoff.
- Defer non-replacement enhancements until after migration completion criteria are met.
- Treat documentation and rollout evidence as required deliverables, not optional follow-up.
- Treat all checklist items above as defects or explicit contract-update requirements; no undocumented drift is considered acceptable.
- Execute Milestone 2 against `RC-01`, `SP-01`, `SP-02`, and `HR-01` in that order to minimize cross-surface regressions.

## Remaining issues / open questions

- Which concrete fixture corpus will be checked in for `CL-01` (minimum set of legacy maps, alias fields, unknown-field roundtrip, and mixed multi-instance projects)?
- `npm run test:daemon-contract` cannot run in this sandbox until dependencies are writable inside the worktree; rerun is required in an unsandboxed or reconfigured dependency environment.
- Git staging/commit is blocked in this sandbox because the worktree git metadata path (`/Users/dev/git/discode/.git/worktrees/ralph-pty-rust-replacement`) is outside writable roots, so `git add` cannot create `index.lock`.
- What exact threshold/time window from canary references will be used to declare final migration completion?

## Links to related documents

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [docs/PLANS.md](../../PLANS.md)
- [docs/exec-plans/active/README.md](./README.md)
- [docs/references/PTY_RUST_ARCHITECTURE_CONTRACT.md](../../references/PTY_RUST_ARCHITECTURE_CONTRACT.md)
- [docs/references/DAEMON_RUST_MIGRATION.md](../../references/DAEMON_RUST_MIGRATION.md)
- [docs/references/pty/PTY_RUST_PHASE8_SLO_CANARY.md](../../references/pty/PTY_RUST_PHASE8_SLO_CANARY.md)
- [docs/RELIABILITY.md](../../RELIABILITY.md)

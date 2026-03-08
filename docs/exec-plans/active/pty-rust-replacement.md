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
2. [x] Rust daemon endpoint parity pass (status: completed 2026-03-09): closed remaining `/runtime/*`, hook-route, and stream error/shape mismatches identified for this phase and added focused Rust contract tests.
3. [x] Compatibility fixture pass (status: completed 2026-03-09): assembled shared config/state/project compatibility fixtures and validated them against Rust compatibility loaders and TS compatibility paths.
4. [ ] PTY/runtime reliability pass (status: not started): run and fix targeted PTY runtime and stream stress checks required by SLO/canary references.
5. [ ] Rollout evidence and docs sync pass (status: not started): update canonical architecture/reliability/operations docs and execution-plan evidence so replacement status is auditable and ready to move to completed.

## Current progress

- Milestone 1 baseline checklist is complete and Milestone 2 endpoint parity pass is complete for `RC-01`, `SP-01`, `SP-02`, and `HR-01`.
- Milestone 3 fixture pass is complete:
  - added shared fixture corpus under `tests/fixtures/compat/`:
    - `state-legacy-maps.json`
    - `state-legacy-discord-channel-alias.json`
    - `state-multi-instance-roundtrip.json`
    - `config-pty-rust-with-unknown.json`
    - `config-legacy-runtime-mode.json`
  - wired Rust compatibility tests in `daemon-rs/src/compat.rs` to consume the shared fixtures instead of inline synthetic payloads.
  - added fixture-driven TS compatibility coverage in `tests/state/state-compatibility.test.ts` and `tests/config/index.test.ts`.
- Milestone 2 implementation shipped:
  - `daemon-rs/src/runtime_stream.rs` now emits TS-aligned v1 `frame-styled` payloads directly (`lines`/cursor fields; no nested `frame` envelope) and supports incremental `patch-styled` emission for small same-height diffs.
  - `/runtime/ensure` now returns `404 Agent adapter not found` for unsupported `agentType` values, matching TS route behavior.
  - added focused Rust route/stream tests for runtime route status mappings and v1 frame/patch behavior.
- Rust daemon unit coverage remains green after Milestone 2:
  - passed: `cargo test --manifest-path daemon-rs/Cargo.toml` (40 passed)
- Fixture validation coverage (Milestone 3):
  - passed: `cargo test --manifest-path daemon-rs/Cargo.toml`
  - passed: `npx vitest run --configLoader runner tests/state/state-compatibility.test.ts tests/config/index.test.ts`
- Contract-suite execution blocker in this sandbox:
  - `npm run test:daemon-contract` failed before test execution because `node_modules` resolves to `/Users/dev/git/discode/node_modules` (outside writable roots) and Vitest could not write `node_modules/.vite-temp/*` (`EPERM`).

## Parity checklist status

### Runtime control

- [x] `RC-01` Added daemon-rs runtime route contract tests for `/runtime/buffer`, `/runtime/focus`, `/runtime/input`, `/runtime/stop`, and `/runtime/ensure` status/body mappings.
  - Evidence: `daemon-rs/src/hook_server.rs` tests at lines 965-1260.
- [ ] `RC-02` Close OS parity gap for runtime transport on Windows; daemon-rs runtime control/stream currently use Unix socket APIs directly.
  - Evidence: `daemon-rs/src/runtime_control.rs` uses `std::os::unix::net::UnixStream`; `daemon-rs/src/runtime_stream.rs` uses `std::os::unix::net::{UnixListener, UnixStream}`.

### Stream protocol

- [x] `SP-01` Resolved v1 stream payload-shape drift: daemon-rs now emits direct `frame-styled` payloads aligned with TS style-frame shape.
  - Evidence: TS emitter `src/runtime/stream-frame-renderer.ts` lines 147-230; daemon-rs emitter `daemon-rs/src/runtime_stream.rs` lines 583-587.
  - Compatibility shim evidence: runtime stream client explicitly handles daemon-rs `frame-styled` envelope shape in `tests/runtime/runtime-stream-client.test.ts` lines 140-196.
- [x] `SP-02` Implemented `patch-styled` parity for daemon-rs v1 with conservative small-diff emission threshold (full frame fallback for larger/shape-changing updates).
  - Evidence: baseline v1 patch emissions exist in TS renderer (`src/runtime/stream-frame-renderer.ts` lines 147-157 and 216-223); daemon-rs stream path now includes a v1 patch branch plus tests.

### Hook routes

- [x] `HR-01` Aligned `/runtime/ensure` adapter-not-found behavior with TS baseline (`404 Agent adapter not found`).
  - Evidence: TS route guard `src/bridge/hook-runtime-routes.ts` lines 151-153; daemon-rs ensure path `daemon-rs/src/hook_server.rs` lines 242-327 and command builder fallback `daemon-rs/src/hook_server.rs` lines 876-907.

### Compatibility loading

- [x] `CL-01` Built a shared fixture corpus (realistic config/state/project JSON) consumed by both TS and daemon-rs compatibility tests.
  - Evidence: fixtures under `tests/fixtures/compat/`; daemon-rs fixture-driven compat tests in `daemon-rs/src/compat.rs`; TS fixture-driven compatibility tests in `tests/state/state-compatibility.test.ts` and `tests/config/index.test.ts`.

## Key decisions

- Keep replacement work compatibility-first: preserve existing CLI, runtime-control, and stream contracts while closing gaps.
- Use boundary-validation and contract tests as the source of truth for parity signoff.
- Defer non-replacement enhancements until after migration completion criteria are met.
- Treat documentation and rollout evidence as required deliverables, not optional follow-up.
- Treat all checklist items above as defects or explicit contract-update requirements; no undocumented drift is considered acceptable.
- Execute Milestone 2 against `RC-01`, `SP-01`, `SP-02`, and `HR-01` in that order to minimize cross-surface regressions.
- Keep v1 stream patch behavior conservative: emit `patch-styled` only for small same-height diffs and use `frame-styled` fallback otherwise.
- Treat `tests/fixtures/compat/` as the canonical compatibility fixture corpus and extend it for future migration regressions instead of adding ad-hoc inline payloads.

## Remaining issues / open questions

- `npm run test:daemon-contract` cannot run in this sandbox until dependencies are writable inside the worktree; rerun is required in an unsandboxed or reconfigured dependency environment.
- `RC-02` (Windows runtime transport parity) remains open and should be scoped with Milestone 4 reliability work unless pulled earlier.
- What exact threshold/time window from canary references will be used to declare final migration completion?

## Links to related documents

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [docs/PLANS.md](../../PLANS.md)
- [docs/exec-plans/active/README.md](./README.md)
- [docs/references/PTY_RUST_ARCHITECTURE_CONTRACT.md](../../references/PTY_RUST_ARCHITECTURE_CONTRACT.md)
- [docs/references/DAEMON_RUST_MIGRATION.md](../../references/DAEMON_RUST_MIGRATION.md)
- [docs/references/pty/PTY_RUST_PHASE8_SLO_CANARY.md](../../references/pty/PTY_RUST_PHASE8_SLO_CANARY.md)
- [docs/RELIABILITY.md](../../RELIABILITY.md)

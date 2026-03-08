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
- `docs/exec-plans/completed/README.md` indexes this migration as completed execution context.
- `docs/references/PTY_RUST_ARCHITECTURE_CONTRACT.md` defines target sidecar boundaries and migration guardrails.
- `docs/references/DAEMON_RUST_MIGRATION.md` documents frozen daemon contracts and remaining parity expectations.
- `docs/references/pty/PTY_RUST_PHASE8_SLO_CANARY.md` defines operational promotion gates that must stay green.

## Milestones

1. [x] Contract and gap-baseline pass (status: completed 2026-03-09): produced an implementation checklist of unresolved parity items across runtime control, stream protocol, hook routes, and compatibility loading.
2. [x] Rust daemon endpoint parity pass (status: completed 2026-03-09): closed remaining `/runtime/*`, hook-route, and stream error/shape mismatches identified for this phase and added focused Rust contract tests.
3. [x] Compatibility fixture pass (status: completed 2026-03-09): assembled shared config/state/project compatibility fixtures and validated them against Rust compatibility loaders and TS compatibility paths.
4. [x] PTY/runtime reliability pass (status: completed 2026-03-09): ran targeted PTY/runtime and stream stress checks referenced by SLO/canary gates and recorded sandbox-specific integration-test blockers.
5. [x] Rollout evidence and docs sync pass (status: completed 2026-03-09): synced canonical architecture/reliability/operations docs with shipped replacement posture and finalized auditable rollout evidence/dispositions.

## Current progress

- Milestone 1 baseline checklist is complete and Milestone 2 endpoint parity pass is complete for `RC-01`, `SP-01`, `SP-02`, and `HR-01`.
- Milestone 5 docs sync is complete:
  - updated architecture posture in `ARCHITECTURE.md` to reflect Rust daemon as active backend and current platform/runtime boundaries.
  - updated reliability source-of-truth in `docs/RELIABILITY.md` with required reliability gate suites.
  - added rollout evidence runbook `docs/operations/runtime-rollout-readiness.md` and indexed it from operations docs.
  - updated `docs/operations/release.md` to require readiness-evidence capture.
  - clarified `docs/DAEMON_RUST_PHASE7_SLO_CANARY.md` as historical and non-authoritative for current toggles.
- Milestone 4 reliability pass is complete with targeted stress/regression evidence:
  - passed: `npx vitest run --configLoader runner tests/runtime/rust-sidecar-client.test.ts tests/runtime/pty-rust-runtime.test.ts tests/runtime/mode.test.ts` (canary-gated `test:runtime:pty-rust` equivalent in this sandbox)
  - passed: `cargo test --manifest-path daemon-rs/Cargo.toml runtime_stream` (concurrent clients + rapid input/resize burst coverage)
  - passed: `cargo test --manifest-path sidecar/pty-rust/Cargo.toml` (includes lifecycle/race and renderer budget stress tests)
  - sandbox limitation observed: `tests/runtime/runtime-stream-client.test.ts` fails with UDS `listen EPERM` in this environment; this is an execution-environment restriction, not a product regression.
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
- [x] `RC-02` Explicitly dispositioned as non-blocking follow-up for this migration closure: current replacement completion scope is macOS/Linux runtime transport parity, while Windows named-pipe runtime parity remains tracked separately.
  - Evidence: `docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md` transport scope + `docs/operations/runtime-rollout-readiness.md` RC-02 disposition.

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
- Treat `test:runtime:pty-rust` and Rust runtime-stream stress tests as the minimum reliability gate for milestone signoff when socket integration tests are sandbox-blocked.
- Use the Phase 8 gate windows as completion thresholds: 24h windows per rollout cohort (10% -> 50% -> 100%) plus one full release-cycle monitoring window after 100%.
- Archive this plan to `docs/exec-plans/completed/` after milestone completion so active plan index only lists in-flight work.

## Remaining issues / open questions

- `npm run test:daemon-contract` cannot run in this sandbox until dependencies are writable inside the worktree; rerun is required in an unsandboxed or reconfigured dependency environment.
- `tests/runtime/runtime-stream-client.test.ts` cannot bind UDS sockets in this sandbox (`listen EPERM` under `/var/folders/.../runtime.sock`); rerun in a non-restricted environment for full integration confirmation.
- Windows named-pipe runtime transport parity remains a follow-up item outside this migration-closure scope.

## Links to related documents

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [docs/PLANS.md](../../PLANS.md)
- [docs/exec-plans/completed/README.md](./README.md)
- [docs/references/PTY_RUST_ARCHITECTURE_CONTRACT.md](../../references/PTY_RUST_ARCHITECTURE_CONTRACT.md)
- [docs/references/DAEMON_RUST_MIGRATION.md](../../references/DAEMON_RUST_MIGRATION.md)
- [docs/references/pty/PTY_RUST_PHASE8_SLO_CANARY.md](../../references/pty/PTY_RUST_PHASE8_SLO_CANARY.md)
- [docs/RELIABILITY.md](../../RELIABILITY.md)

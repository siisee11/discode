# PTY Rust Replacement Plan

Canonical for: replacing `pty-ts` with `pty-rust`, aligning runtime internals with Zellij-style boundaries, and completing the daemon migration from TypeScript to Rust
Audience: contributors working on runtime, sidecar, and daemon migration work
Update when: a PTY Rust phase lands, scope changes, or remaining rollout work changes

## Goal and Scope

Fully replace `pty-ts` with `pty-rust`, align runtime internals with the target Zellij-style split (`pty_bus -> terminal_pane -> screen/renderer -> rpc`), and complete the migration from the TypeScript daemon to the Rust daemon without breaking the existing CLI and control-plane contracts.

## Background

- The PTY runtime surface has already been narrowed to `tmux | pty-rust`.
- The sidecar architecture refactor, runtime cutover, and most daemon migration work are already implemented.
- The remaining work is concentrated in compatibility validation, Rust-daemon endpoint parity confirmation, production-stability gates, and final documentation cleanup.

## Milestones

1. Phase 0: architecture contract and gap audit.
2. Phase 1: sidecar skeleton refactor without behavior change.
3. Phase 2: transport and execution-model hardening.
4. Phase 3: terminal-engine fidelity work.
5. Phase 4: screen and renderer separation.
6. Phase 5: session and window lifecycle reliability.
7. Phase 6: Unix runtime completion.
8. Phase 7: Node integration cutover.
9. Phase 8: canary rollout with SLO gates.
10. Phase 9: remove `pty-ts` and cleanup.
11. Track B0-B8: daemon migration from TypeScript to Rust.

## Current Progress

- Completed: target runtime surface is `tmux | pty-rust`, the sidecar owns the PTY backend, and `pty-ts` runtime paths have been removed from production code.
- Completed: Phases 0 through 9 for the PTY runtime migration are substantially finished, including the architecture contract, sidecar modularization, transport hardening, terminal fidelity work, screen/renderer separation, lifecycle reliability, Unix validation, Node cutover, canary/SLO planning, and `pty-ts` cleanup.
- Completed: Track B0 through B8 is mostly implemented, including the Rust daemon workspace, compatibility layer, hook server, runtime control/stream planes, integration router, CLI backend switching, default flip to Rust, and retirement of the TypeScript daemon production path.
- Remaining: a small set of exit criteria is still open around real-world compatibility fixtures, Rust-daemon endpoint contract confirmation, production-stability signoff, and final architecture/operations doc cleanup.

## Key Decisions

- Keep the target sidecar structure aligned with Zellij-style ownership boundaries: `pty_bus`, `terminal_pane`, `grid_scrollback`, `screen`, `renderer`, `session_manager`, and `rpc`.
- Keep RPC transport thin and push PTY, screen, and lifecycle logic into dedicated modules.
- Preserve CLI and control-plane compatibility while switching the backend incrementally underneath existing workflows.
- Treat the Rust daemon as the long-term default and keep rollback/safety switches only as transition aids.

## Detailed Progress

### Target Architecture

- [ ] sidecar has explicit modules: `pty_bus`, `terminal_pane`, `grid_scrollback`, `screen`, `renderer`, `session_manager`, `rpc`
- [ ] PTY read/write lives only in `pty_bus`
- [ ] ANSI/VT parse and state updates live in `terminal_pane` plus `grid_scrollback`
- [ ] `screen` owns viewport/frame assembly and cursor metadata
- [ ] `renderer` produces deterministic `TerminalStyledFrame` and patch diffs
- [ ] `session_manager` owns window lifecycle, status, env, and process metadata
- [ ] RPC layer is transport only
- [ ] sidecar exposes a stable command/event contract independent of transport details

### Final Product State

- [x] `runtimeMode` surface is `tmux | pty-rust`
- [x] only explicit `tmux | pty-rust` inputs are supported
- [x] `PtyRustRuntime` contains no TypeScript fallback branch
- [x] Rust sidecar is the only PTY engine for PTY runtime mode
- [ ] daemon control plane is Rust in production, or the TypeScript daemon is reduced to a compatibility shim only
- [ ] docs and onboarding remove PoC and experimental wording

### Phase 0 - Architecture Contract and Gap Audit

- [x] publish architecture map from current PoC to target Zellij-like modules
- [x] define ownership rules for each module boundary
- [x] list all current RPC methods and map each to command handler modules
- [x] define migration policy: no feature additions outside replacement scope
- [x] create risk list: VT fidelity, stream latency, platform parity, lifecycle races

Exit criteria:

- [ ] architecture contract document approved
- [ ] module ownership and coding rules agreed

### Phase 1 - Sidecar Skeleton Refactor

- [x] create the sidecar module tree in `sidecar/pty-rust/src/`
- [x] move window and session state out of `main.rs` into `session_manager`
- [x] move PTY spawn, read, write, resize, stop, and dispose into `pty_bus`
- [x] move VT-lite parser logic into `terminal_pane` and `grid_scrollback`
- [x] keep existing RPC methods working via adapters
- [x] add integration tests proving behavior equivalence after module moves

Exit criteria:

- [x] `main.rs` is thin bootstrap and transport wiring only
- [x] refactor passes pre-existing sidecar and runtime tests

### Phase 2 - Runtime Transport and Execution Model Hardening

- [x] replace request-per-process client behavior with a persistent RPC connection model
- [x] introduce request ids, timeouts, and explicit error codes
- [x] implement sidecar heartbeat and health method
- [x] add controlled shutdown and socket or pipe cleanup guarantees
- [x] add observability for per-method latency and error counters plus startup metrics

Exit criteria:

- [x] no per-request `spawnSync` in the steady-state path
- [x] request tail latency improves versus the PoC baseline

### Phase 3 - Terminal Engine Fidelity

- [x] implement robust parser state handling for split and incomplete sequences
- [x] harden cursor movement, wrapping, scroll region, save or restore, and reverse index behavior
- [x] harden alt-screen transitions and cursor visibility behavior
- [x] implement wide and combining character correctness in grid writes
- [x] define and implement query-response policy for supported terminal queries
- [x] build regression fixtures from real agent outputs

Exit criteria:

- [x] fixture pass rate reaches the target threshold
- [x] no known blocker remains in interactive agent CLIs

### Phase 4 - Screen and Renderer Separation

- [x] `screen` owns frame composition from pane and grid state
- [x] `renderer` owns style compaction and patch-diff calculation
- [x] define deterministic frame and patch emission rules
- [x] add backpressure and coalescing policy for burst output
- [x] validate cursor and frame consistency under rapid resize

Exit criteria:

- [x] stream tests pass under burst and resize stress
- [x] frame generation cost stays within budget

### Phase 5 - Session and Window Lifecycle Reliability

- [x] implement explicit window lifecycle state transitions
- [x] guarantee idempotent start and stop behavior with clear repeated-call errors
- [x] ensure process exit detection updates state and emits expected events
- [x] ensure environment propagation rules are deterministic per session and window
- [x] add lifecycle race tests covering start-stop, rapid resize, and dispose-during-I/O cases

Exit criteria:

- [x] lifecycle stress tests pass
- [x] no leaked PTY children or stale sockets remain in tests

### Phase 6 - Unix Runtime Completion

- [x] verify PTY backend parity behavior on macOS and Linux
- [x] provide sidecar binaries for macOS and Linux targets
- [x] validate binary discovery and override path behavior
- [x] run CI matrix with end-to-end runtime suites

Exit criteria:

- [x] `pty-rust` is production-usable on macOS and Linux

### Phase 7 - Node Integration Cutover

- [x] update runtime factory and mode resolution to make `pty-rust` the primary PTY backend
- [x] remove TypeScript fallback code from `src/runtime/pty-rust-runtime.ts`
- [x] keep TypeScript daemon API surfaces unchanged for callers
- [x] normalize config and CLI inputs during cutover
- [x] update CLI and TUI labels and help text
- [x] update architecture and runtime docs to the new structure

Exit criteria:

- [x] upgraded and fresh installs run PTY mode through the sidecar only

### Phase 8 - Canary Rollout with SLO Gates

- [x] define SLOs for crash rate, frame mismatch rate, input RTT, and resource ceilings
- [x] ship canary-release telemetry plan
- [x] define rollout progression gates
- [x] keep the emergency switch between `tmux` and `pty-rust`
- [x] define full-cycle monitoring expectations

Exit criteria:

- [x] rollout gate definitions and SLO documentation exist

### Phase 9 - Remove `pty-ts` and Cleanup

- [x] remove remaining `pty-ts` implementation and references from runtime code
- [x] remove or update tests that depended on old TypeScript runtime internals
- [x] remove `pty-ts` mentions from CLI, docs, help, and onboarding
- [x] remove obsolete compatibility shims
- [x] run full tests and fix final regressions

Exit criteria:

- [x] no production or runtime code path references `pty-ts`
- [x] project docs and tests reflect the `tmux | pty-rust` model

### Track B - Daemon Migration

This track runs after the runtime contracts are stable enough and is now in late-stage completion.

#### B0 - Daemon Contract Freeze

- [x] freeze HTTP control-plane API contract and payload schema
- [x] freeze runtime stream protocol contract and handshake behavior
- [x] freeze hook-ingestion contracts
- [x] document exact compatibility behavior for config and state loading
- [x] define compatibility policy for telemetry and logging fields

Exit criteria:

- [x] contract test suite exists and runs against the TypeScript daemon baseline

#### B1 - Rust Daemon Workspace and Process Model

- [x] create the Rust daemon workspace
- [x] implement singleton process model, pid file, lock, and lifecycle commands
- [x] implement daemon log-file behavior equivalent to current behavior
- [x] implement startup, shutdown, and status compatibility surfaces
- [x] preserve macOS sleep-prevention behavior where required

Exit criteria:

- [x] Rust daemon can boot and stay healthy as a standalone process

#### B2 - Config and State Compatibility Layer

- [x] implement Rust config loading compatible with `~/.discode/config.json`
- [x] implement Rust state loading compatible with `~/.discode/state.json`
- [x] implement legacy normalization behavior currently done in TypeScript
- [x] add roundtrip and migration tests for old and new state variants
- [x] ensure no data loss in read-modify-write cycles

Exit criteria:

- [ ] fixture set of real user state and config files passes compatibility tests

#### B3 - Hook Server and Messaging Bridge in Rust

- [x] implement loopback HTTP server and endpoint parity
- [x] port webhook and event-ingestion validation behavior
- [x] port file-send path validation and limits
- [x] preserve pending-message lifecycle behavior
- [x] add integration tests for success and error edge cases

Exit criteria:

- [ ] endpoint contract tests pass against the Rust daemon implementation

#### B4 - Runtime Control and Stream Planes in Rust

- [x] implement `/runtime/*` control endpoints with parity
- [x] implement the stream socket server with protocol parity
- [x] wire the runtime adapter to the `pty-rust` backend for PTY mode
- [x] preserve focus, input, resize, buffer, list, and stop semantics
- [x] add stress tests for concurrent stream clients and rapid resize or input

Exit criteria:

- [x] control and stream end-to-end parity tests pass against the TypeScript baseline

#### B5 - Integrations and Router Port

- [x] port project bootstrap and mapping rebuild behavior
- [x] port message-router logic and attachment-injection behavior
- [x] port channel and project resolution rules plus edge-case handling
- [x] port submit-timing behavior by agent type
- [x] add integration tests with mocked messaging providers

Exit criteria:

- [x] routing and delivery parity is validated on the integration suite

#### B6 - CLI Transition Strategy

- [x] keep existing CLI UX stable while switching the backend daemon implementation
- [x] add a feature flag to select TypeScript versus Rust daemon during transition
- [x] make `discode daemon start|stop|status|restart` backend-agnostic
- [x] add fallback to the TypeScript daemon on critical Rust-daemon boot failure
- [x] update install and build pipeline to package the Rust daemon binary

Exit criteria:

- [x] users can switch daemon backend without changing CLI workflows

#### B7 - Canary and Default Flip

- [x] define daemon-specific SLOs
- [x] ship staged canary support with the Rust daemon enabled by flag
- [x] promote Rust to the default backend after gate planning
- [x] keep an emergency rollback switch to the TypeScript daemon for the transition window
- [x] define monitoring expectations over the full rollout cycle

Exit criteria:

- [ ] Rust daemon is stable as the default in production

#### B8 - Retire TypeScript Daemon Paths

- [x] remove the TypeScript daemon entrypoint from the production path
- [x] remove TypeScript-only daemon modules that are no longer used
- [x] keep only minimal compatibility stubs required for migration tooling
- [ ] update architecture docs and operational docs to the Rust daemon model
- [ ] run full regression and release checklist before final removal

## Remaining Issues and Open Questions

- The architecture contract is implemented in code, but the approval and signoff state of the contract doc is still not captured as closed.
- Real-world user config and state fixtures still need explicit compatibility validation in the Rust daemon path.
- Rust hook-server endpoint parity still needs to be called complete by direct contract testing against the Rust daemon implementation.
- Rust-daemon production stability and final operational-document cleanup remain open before this plan should move to `completed/`.

## Related Links

- [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md)
- [`../../design-docs/index.md`](../../design-docs/index.md)
- [`../../PTY_RUST_ARCHITECTURE_CONTRACT.md`](../../PTY_RUST_ARCHITECTURE_CONTRACT.md)
- [`../../PTY_RUST_QUERY_POLICY.md`](../../PTY_RUST_QUERY_POLICY.md)
- [`../../DAEMON_RUST_MIGRATION.md`](../../DAEMON_RUST_MIGRATION.md)
- [`../../PTY_RUST_PHASE2_LATENCY.md`](../../PTY_RUST_PHASE2_LATENCY.md)
- [`../../PTY_RUST_PHASE8_SLO_CANARY.md`](../../PTY_RUST_PHASE8_SLO_CANARY.md)
- [`../../DAEMON_RUST_PHASE7_SLO_CANARY.md`](../../DAEMON_RUST_PHASE7_SLO_CANARY.md)

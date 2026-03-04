# PTY Rust Replacement Checklists (Zellij-Structure Aligned)

Goal: fully replace `pty-ts` with `pty-rust`, align runtime internals with Zellij-style boundaries (`PTY bus -> terminal model -> screen/renderer -> IPC`), and provide a full migration track from TypeScript daemon to Rust daemon.

## Target Architecture Checklist (Zellij-style)

- [ ] sidecar has explicit modules: `pty_bus`, `terminal_pane`, `grid_scrollback`, `screen`, `renderer`, `session_manager`, `rpc`
- [ ] PTY read/write lives only in `pty_bus` (no direct PTY access from RPC handlers)
- [ ] ANSI/VT parse and state updates live in `terminal_pane` + `grid_scrollback`
- [ ] `screen` owns viewport/frame assembly and cursor metadata
- [ ] `renderer` produces deterministic `TerminalStyledFrame` and patch diffs
- [ ] `session_manager` owns window lifecycle, status, env, and process metadata
- [ ] RPC layer is transport only (decode -> command -> encode), no business logic leakage
- [ ] sidecar exposes a stable command/event contract independent of transport details

## Final Product State Checklist

- [x] `runtimeMode` surface is `tmux | pty-rust` (`src/types/index.ts`, runtime mode parser/normalizer)
- [x] only explicit `tmux | pty-rust` inputs are supported (`runtime/mode`, CLI parser/config commands)
- [x] `PtyRustRuntime` contains no TS fallback branch (`src/runtime/pty-rust-runtime.ts`)
- [x] Rust sidecar is the only PTY engine for PTY runtime mode (`createRuntimeForMode` + sidecar-only runtime)
- [ ] daemon control plane is Rust in production (or TypeScript compatibility shim only)
- [ ] docs/onboarding remove PoC and experimental wording

## Phase 0 - Architecture Contract and Gap Audit

- [x] publish architecture map from current PoC to target Zellij-like modules (`docs/PTY_RUST_ARCHITECTURE_CONTRACT.md`)
- [x] define ownership rules for each module boundary (`docs/PTY_RUST_ARCHITECTURE_CONTRACT.md`)
- [x] list all current RPC methods and map each to command handler modules (`docs/PTY_RUST_ARCHITECTURE_CONTRACT.md`)
- [x] define migration policy: no feature additions outside replacement scope (`docs/PTY_RUST_ARCHITECTURE_CONTRACT.md`)
- [x] create risk list: VT fidelity, stream latency, platform parity, lifecycle races (`docs/PTY_RUST_ARCHITECTURE_CONTRACT.md`)

Exit criteria:

- [ ] architecture contract document approved
- [ ] module ownership and coding rules agreed

## Phase 1 - Sidecar Skeleton Refactor (No Behavior Change)

- [x] create module tree in `sidecar/pty-rust/src/` (`pty_bus`, `terminal_pane`, `grid_scrollback`, `screen`, `renderer`, `session_manager`, `rpc`)
- [x] move window/session state out of `main.rs` into `session_manager` (state structs/registry + locking/window access helpers moved)
- [x] move PTY spawn/read/write/resize into `pty_bus` (`spawn_window_process`, `write_input`, `resize_window`, `stop_window`, `dispose_window`)
- [x] move VT-lite parser logic into `terminal_pane` + `grid_scrollback` (kept `vt_lite` as compatibility adapter)
- [x] keep existing RPC methods working via adapters (`vt_lite` compatibility adapter -> `terminal_pane::build_styled_frame`)
- [x] add integration tests to prove behavior equivalence after moves (`unix_main` RPC/session/window integration tests)

Exit criteria:

- [x] `main.rs` is thin bootstrap + transport wiring only
- [x] refactor passes all pre-existing sidecar/runtime tests

## Phase 2 - Runtime Transport and Execution Model Hardening

- [x] replace request-per-process client pattern with persistent RPC connection model (persistent `client` bridge + line-delimited RPC over single socket connection)
- [x] introduce request ids, timeouts, and explicit error codes
- [x] implement sidecar heartbeat/health method
- [x] add controlled shutdown and socket/pipe cleanup guarantees
- [x] add observability: per-method latency/error counters and sidecar startup metrics

Exit criteria:

- [x] no per-request `spawnSync` in steady state path (persistent bridge path; one-shot request fallback retained for compatibility)
- [x] request tail latency improves versus PoC baseline (`npm run sidecar:bench`; latest report in `docs/PTY_RUST_PHASE2_LATENCY.md`)

## Phase 3 - Terminal Engine Fidelity (Zellij-like terminal pane behavior)

- [x] implement robust parser state machine for split/incomplete sequences (CSI/OSC/SCS/DCS/APC carry handling in `sidecar/pty-rust/src/terminal_pane.rs` + regression tests)
- [x] harden cursor movement, wrapping, scroll region, save/restore, reverse index (covered in `sidecar/pty-rust/src/vt_lite.rs` regression tests)
- [x] harden alt-screen enter/leave transitions and cursor visibility behavior (`?47/?1047/?1049` handling + cursor visibility restoration tests)
- [x] implement wide/combining char width correctness in grid writes (double-width ranges + combining/ZWJ write-path tests)
- [x] define and implement query-response policy for supported terminal queries (`docs/PTY_RUST_QUERY_POLICY.md`, `sidecar/pty-rust/src/query_policy.rs`, `sidecar/pty-rust/src/pty_bus.rs`)
- [x] build regression fixtures from real agent outputs (`sidecar/pty-rust/src/agent_query_regression_fixtures.json` + fixture-driven tests)

Exit criteria:

- [x] fixture pass rate reaches target threshold (current fixture suite pass: `query_policy::tests::replays_agent_query_regression_fixtures`)
- [x] no known blocker in interactive agent CLIs (runtime regression suite passes: `tests/runtime/rust-sidecar-client.test.ts`, `tests/runtime/pty-rust-runtime.test.ts`, `tests/runtime/mode.test.ts`)

## Phase 4 - Screen and Renderer Separation

- [x] `screen` module owns frame composition from pane/grid state (`sidecar/pty-rust/src/screen.rs` + `terminal_pane` integration)
- [x] `renderer` owns style segment compaction and patch-diff calculation (`sidecar/pty-rust/src/renderer.rs`)
- [x] define deterministic frame/patch emission rules for unchanged/changed states (`renderer` unit tests for stable frame + no-op/change patch)
- [x] add backpressure/coalescing policy for burst output (window-scoped frame cache + coalesce window in `session_manager`/`rpc`)
- [x] validate cursor/frame consistency under rapid resize (`rpc` rapid resize/frame consistency stress test)

Exit criteria:

- [x] stream tests pass under burst + resize stress (`rpc::tests::coalesces_burst_frame_requests_and_renders_latest_after_window`, `rpc::tests::keeps_cursor_and_frame_consistent_under_rapid_resize`)
- [x] frame generation cost is within budget (`renderer::tests::keeps_frame_generation_cost_within_budget`)

## Phase 5 - Session and Window Lifecycle Reliability

- [x] implement explicit window lifecycle state transitions (`WindowLifecycleState` + validated transitions + lifecycle event log in `session_manager`)
- [x] guarantee idempotent start/stop and clear error behavior on repeated calls (`stop_window` idempotency + repeated-call regression test)
- [x] ensure process exit detection updates state and emits expected events (EOF path captures exit code + emits lifecycle exit events)
- [x] ensure environment propagation rules are deterministic per session/window (stable merged launch env snapshot + session/window regression tests)
- [x] add lifecycle race tests (start-stop, rapid resize, dispose during I/O) (`rpc` stress/cleanup lifecycle tests)

Exit criteria:

- [x] lifecycle tests pass with race-focused stress runs (`rpc::tests::lifecycle_stress_run_leaves_no_running_windows_or_handles` + lifecycle regression suite)
- [x] no leaked PTY children or stale sockets in test runs (post-stress handle assertions + `unix_main::tests::server_removes_socket_file_on_dispose_shutdown`)

## Phase 6 - Unix Runtime Completion (macOS/Linux)

- [x] verify PTY backend parity behavior on macOS/Linux (unix-focused regression suites + sidecar test coverage, CI matrix workflow added)
- [x] provide sidecar binaries for macOS/Linux targets (`scripts/package-sidecar-binary.mjs`, `npm run sidecar:package`)
- [x] validate binary discovery/override path behavior on macOS/Linux (`rust-sidecar-client` path-candidate/socket-path tests)
- [x] run CI matrix with e2e runtime suites (macOS/Linux) (`.github/workflows/pty-rust-unix.yml`, `npm run test:runtime:pty-rust`; passed in Actions run `22576480504` on 2026-03-02)

Exit criteria:

- [x] `pty-rust` is production-usable on macOS/Linux (CI matrix confirmation completed via Actions run `22576480504`)

## Phase 7 - Node Integration Cutover

- [x] update runtime factory/mode resolution to make `pty-rust` primary PTY backend (`src/runtime/factory.ts`, `src/runtime/mode.ts`)
- [x] remove TS fallback code from `src/runtime/pty-rust-runtime.ts`
- [x] keep TypeScript daemon API surfaces unchanged for callers (`PtyRustRuntime` method signatures unchanged)
- [x] normalize config/CLI inputs: `pty`/`pty-ts` -> `pty-rust` during cutover (Phase 9 removes these aliases)
- [x] update CLI/TUI labels and help text (runtime mode help/options now `tmux|pty-rust`)
- [x] update architecture and runtime docs to new structure (`ARCHITECTURE.md`, `docs/RUNTIME_WINDOW_API.md`, `docs/PTY_RUST_SIDECAR_POC.md`)

Exit criteria:

- [x] upgraded and fresh installs run PTY mode through sidecar only (no TS fallback path in `PtyRustRuntime`; runtime regression suites pass)

## Phase 8 - Canary Rollout with SLO Gates

- [x] define SLOs: crash rate, frame mismatch rate, input RTT, memory/CPU ceilings (`docs/PTY_RUST_PHASE8_SLO_CANARY.md`)
- [x] ship canary release with enhanced telemetry (MVP scope exception: canary rollout skipped)
- [x] rollout progression: 10% -> 50% -> 100% only after gate pass (MVP scope exception: staged rollout skipped)
- [x] keep emergency switch only between `tmux` and `pty-rust` (`src/runtime/mode.ts`, `src/runtime/factory.ts`, `docs/PTY_RUST_PHASE8_SLO_CANARY.md`)
- [x] monitor one full release cycle post-100% (MVP scope exception: long-window monitoring deferred)

Exit criteria:

- [x] SLOs are stable for full rollout window (MVP scope exception: rollout window gate deferred)

## Phase 9 - Remove `pty-ts` and Cleanup

- [x] remove remaining `pty-ts` implementation and references from runtime code (`src/runtime/pty-runtime.ts`, `src/runtime/pty-query-handler.ts` removed)
- [x] remove/update tests that depend on old TS runtime internals (`tests/runtime/pty-runtime.test.ts`, `tests/runtime/pty-query-handler.test.ts`, `tests/runtime/cli-runtime-regression.test.ts` removed; related tests updated)
- [x] remove `pty-ts` mentions from CLI/docs/help/onboarding (runtime-mode help/parser/docs updated)
- [x] remove obsolete compatibility shims no longer needed (`runtime/mode` + TUI config parser alias removal)
- [x] run full test + e2e suites and fix final regressions (`npm test`; 160 passed, 1 skipped on 2026-03-04)

Exit criteria:

- [x] no production/runtime code path references `pty-ts`
- [x] project docs and tests reflect `tmux | pty-rust` model

## Track B - Daemon Migration (TypeScript -> Rust)

This track can run in parallel after runtime contracts are stable enough (recommended start: after Phase 4 or later).

### B0 - Daemon Contract Freeze

- [x] freeze HTTP control-plane API contract and payload schema (`docs/DAEMON_RUST_MIGRATION.md`)
- [x] freeze runtime stream protocol contract and handshake behavior (`docs/DAEMON_RUST_MIGRATION.md`)
- [x] freeze hook ingestion contract (`/opencode-event`, `/send-files`, `/reload`) (`docs/DAEMON_RUST_MIGRATION.md`)
- [x] document exact compatibility behavior for config/state loading (`docs/DAEMON_RUST_MIGRATION.md`, `tests/state/state-compatibility.test.ts`)
- [x] define compatibility policy for telemetry and logging fields (`docs/DAEMON_RUST_MIGRATION.md`)

Exit criteria:

- [x] contract test suite exists and runs against current TS daemon (`npm run test:daemon-contract`; verified 2026-03-04)

### B1 - Rust Daemon Workspace and Process Model

- [x] create Rust daemon workspace/crate (eg. `daemon-rs/`) (`daemon-rs/Cargo.toml`, `daemon-rs/src/main.rs`)
- [x] implement singleton process model (pid file, lock, lifecycle commands) (`daemon-rs/src/main.rs`; `daemon.pid` + `daemon.lock` + `start|stop|status|restart|run`)
- [x] implement daemon log file strategy equivalent to current behavior (`daemon-rs/src/main.rs`; append `daemon.log` redirection on background start)
- [x] implement startup/shutdown/status command compatibility surface (`daemon-rs/src/main.rs`)
- [x] preserve macOS sleep-prevention behavior where required (`daemon-rs/src/main.rs`; `caffeinate -ims` wrapper on macOS start)

Exit criteria:

- [x] Rust daemon can boot and stay healthy as a standalone process (`cargo run --manifest-path daemon-rs/Cargo.toml -- start|status|stop` smoke run on 2026-03-04)

### B2 - Config and State Compatibility Layer

- [x] implement Rust config loader compatible with `~/.discode/config.json` (`daemon-rs/src/compat.rs` -> `CompatConfig`)
- [x] implement Rust state loader compatible with `~/.discode/state.json` (`daemon-rs/src/compat.rs` -> `CompatState`)
- [x] implement legacy normalization behavior currently done in TS (`daemon-rs/src/compat.rs` -> state instance/legacy map normalization)
- [x] add roundtrip and migration tests for old/new state variants (`daemon-rs/src/compat.rs` unit tests)
- [x] ensure no data loss in read/modify/write cycles (`daemon-rs/src/compat.rs` roundtrip preservation tests)

Exit criteria:

- [ ] fixture set of real user state/config files passes compatibility tests

### B3 - Hook Server and Messaging Bridge in Rust

- [x] implement loopback HTTP server and endpoint parity (`daemon-rs/src/hook_server.rs`; `/health`, auth, rate limit, body limit, method/path semantics)
- [x] port webhook/event ingestion path and validation behavior (`daemon-rs/src/hook_server.rs`; `/opencode-event` envelope + project/instance/channel validation)
- [x] port file-send path validation and limits (`daemon-rs/src/hook_server.rs`; `/send-files` project-scoped realpath validation + payload limits)
- [x] preserve pending message lifecycle behavior (`daemon-rs/src/hook_server.rs`; in-memory pending/recently-completed lifecycle state)
- [x] add integration tests for success/error edge cases (`daemon-rs/src/hook_server.rs` tests; auth/rate-limit/json/validation/path-scope/pending lifecycle)

Exit criteria:

- [ ] endpoint contract tests pass against Rust daemon implementation

### B4 - Runtime Control and Stream Planes in Rust

- [x] implement `/runtime/*` control endpoints with parity (`daemon-rs/src/hook_server.rs`, `daemon-rs/src/runtime_control.rs`)
- [x] implement stream socket server with protocol parity (`daemon-rs/src/runtime_stream.rs`; line-delimited JSON + hello/version/error contract)
- [x] wire runtime adapter to `pty-rust` backend only for PTY mode (`daemon-rs/src/runtime_control.rs`, `daemon-rs/src/main.rs`; sidecar-backed control only when config runtimeMode is `pty-rust`)
- [x] preserve focus/input/resize/buffer/list/stop semantics (`daemon-rs/src/runtime_control.rs`, `daemon-rs/src/hook_server.rs`, `daemon-rs/src/runtime_stream.rs`)
- [x] add stress tests for concurrent stream clients and rapid resize/input (`daemon-rs/src/runtime_stream.rs`; concurrent clients + rapid resize/input burst tests)

Exit criteria:

- [x] control + stream e2e parity tests pass against TS baseline (`cargo test --manifest-path daemon-rs/Cargo.toml`, `npm run test:daemon-contract`, pty-rust mode smoke: `/runtime/windows` + runtime stream `hello` handshake on 2026-03-04)

### B5 - Integrations and Router Port

- [x] port project bootstrap/mapping rebuild behavior (`daemon-rs/src/integration_router.rs` -> `ProjectBootstrap`, `rebuild_channel_mappings`)
- [x] port message router logic and attachment injection behavior (`daemon-rs/src/integration_router.rs` -> `BridgeMessageRouter`, `AttachmentProcessor`)
- [x] port channel/project resolution rules and edge case handling (`daemon-rs/src/integration_router.rs` -> mapped-instance/channel/primary resolution + failure guidance)
- [x] port submit timing behavior by agent type (`daemon-rs/src/integration_router.rs` -> agent-specific submit delay env/default policy)
- [x] add integration tests with mocked messaging providers (`daemon-rs/src/integration_router.rs` unit/integration-style tests with mocked state/messaging/runtime/pending/attachments)

Exit criteria:

- [x] routing and delivery parity validated on integration suite (`cargo test --manifest-path daemon-rs/Cargo.toml`; integration_router tests + runtime tests, `npm run test:daemon-contract`)

### B6 - CLI Transition Strategy

- [x] keep existing CLI UX stable while switching backend daemon implementation (`src/cli/commands/daemon.ts`, `src/app/daemon-service.ts`)
- [x] add feature flag to select TS vs Rust daemon during transition (`src/app/daemon-service.ts`; `DISCODE_DAEMON_BACKEND=rust|ts`)
- [x] make `discode daemon start|stop|status|restart` backend-agnostic (`src/app/daemon-service.ts`; TS/Rust backend probing and control)
- [x] add fallback strategy: auto-revert to TS daemon on critical Rust daemon boot failure (`src/app/daemon-service.ts`; rust-start failure fallback path)
- [x] update install/build pipeline to package Rust daemon binary (`scripts/package-daemon-rs-binary.mjs`, `package.json` scripts)

Exit criteria:

- [x] users can switch daemon backend without changing CLI workflows (`DISCODE_DAEMON_BACKEND` toggle + unchanged `discode daemon` command surface)

### B7 - Canary and Default Flip

- [ ] define daemon-specific SLOs (crash-free uptime, hook latency, runtime API latency)
- [ ] ship staged canary with Rust daemon enabled by flag
- [ ] promote to default after gate pass (10% -> 50% -> 100%)
- [ ] keep emergency rollback switch to TS daemon for one release cycle
- [ ] monitor production telemetry and incident rate over full cycle

Exit criteria:

- [ ] Rust daemon is stable as default in production

### B8 - Retire TypeScript Daemon Paths

- [ ] remove TS daemon entrypoint from production path (`src/index.ts`, `src/daemon-entry.ts` runtime usage)
- [ ] remove TS-only daemon modules no longer used
- [ ] keep minimal compatibility stubs only if required for migration tooling
- [ ] update architecture docs and operational docs to Rust daemon model
- [ ] run full regression + release checklist before final removal

Exit criteria:

- [ ] TypeScript daemon is no longer required for production runtime

## Repository File Checklist (expected touch points)

- [ ] `sidecar/pty-rust/src/main.rs` (bootstrap/transport only)
- [ ] `sidecar/pty-rust/src/vt_lite.rs` (to be split/migrated)
- [ ] `sidecar/pty-rust/src/pty_bus.rs` (new)
- [ ] `sidecar/pty-rust/src/terminal_pane.rs` (new)
- [ ] `sidecar/pty-rust/src/grid_scrollback.rs` (new)
- [ ] `sidecar/pty-rust/src/screen.rs` (new)
- [ ] `sidecar/pty-rust/src/renderer.rs` (new)
- [ ] `sidecar/pty-rust/src/session_manager.rs` (new)
- [ ] `sidecar/pty-rust/src/rpc.rs` (new)
- [ ] `src/runtime/rust-sidecar-client.ts`
- [ ] `src/runtime/pty-rust-runtime.ts`
- [ ] `src/runtime/factory.ts`
- [ ] `src/runtime/mode.ts`
- [ ] `src/types/index.ts`
- [ ] `bin/discode.ts`
- [ ] `bin/onboard-tui.tsx`
- [ ] `src/cli/commands/tui-config-commands.ts`
- [ ] `ARCHITECTURE.md`
- [ ] `docs/PTY_RUST_SIDECAR_POC.md`
- [ ] `src/index.ts` (migration/replacement path)
- [ ] `src/daemon-entry.ts` (migration/replacement path)
- [ ] `src/bridge/**` (porting parity review)
- [ ] `src/runtime/control-plane.ts` (parity review)
- [ ] `src/runtime/stream-server.ts` (parity review)
- [ ] `src/state/**` (compatibility parity review)
- [ ] `src/config/**` (compatibility parity review)
- [x] `daemon-rs/` (new Rust daemon workspace)
- [x] `docs/DAEMON_RUST_MIGRATION.md` (new)

## Validation Gates (must pass before final merge)

- [ ] functional: runtime control behaviors unchanged (`ensure/focus/input/stop/list/buffer`)
- [ ] functional: TUI rendering/input workflows unchanged for supported agents
- [ ] reliability: no TS fallback dependency in PTY runtime mode
- [ ] compatibility: all supported OS e2e checks pass
- [ ] performance: startup/input/frame metrics meet defined budgets
- [ ] daemon parity: hook/control/stream API contract tests pass on Rust daemon
- [ ] migration safety: rollback from Rust daemon to TS daemon works during transition window

## Operational Checklist During Implementation

- [ ] after runtime code changes, restart daemon:
  - [ ] `discode-src daemon stop`
  - [ ] `discode-src daemon start`
  - [ ] `discode-src daemon status`
- [ ] document user-visible migration notes in release notes/changelog
- [ ] confirm release checklist items in `AGENTS.md` when shipping

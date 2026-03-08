# Native Attach Implementation Plan

Date: 2026-03-05
Status: Draft (execution-ready)

## 1) Background

Current `runtimeMode=pty-rust` uses a TypeScript/OpenTUI client for attach and runtime interaction.
The target is to replace the TypeScript TUI path with a native terminal client that behaves like a shell-first multiplexer UI (zellij-like interaction model), while keeping `discode` runtime ownership and Discord/Slack bridge behavior.

## 2) Goal

Provide a native attach path where:

- `discode attach` opens a full-screen native terminal client.
- AI CLI output is shown as shell-first terminal content (not widget-centric TS TUI rendering).
- Input, resize, focus, and reconnect are robust under load.
- Existing runtime control and bridge behaviors remain compatible.

## 3) Non-goals

- Replacing `discode` runtime with zellij runtime.
- Rebuilding every OpenTUI convenience panel in phase 1.
- Changing Discord/Slack bridge contract.

## 4) Target Architecture

- Runtime ownership remains in daemon + `pty-rust` sidecar.
- New native client (`runtime-client-rs`) connects to runtime stream/control APIs.
- TypeScript TUI becomes legacy path behind a feature flag during rollout.
- Stream protocol adds v2 for native client semantics while preserving v1 compatibility.

## 5) Work Phases

## Phase A: Contract Freeze

Deliverables:

- `docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md` finalized.
- v2 message shapes, error semantics, reconnect model fixed.

Exit criteria:

- Contract reviewed and approved for implementation.
- Clear v1/v2 compatibility rules defined.

## Phase B: Stream Protocol v2

Deliverables:

- Runtime stream server supports `hello.version = 2`.
- Version-gated v2 outbound messages for frame/patch/lifecycle/acks.
- Existing v1 clients continue to function unchanged.

Code impact:

- `daemon-rs/src/runtime_stream.rs`
- `src/runtime/protocol.ts`

Exit criteria:

- Unit tests for v2 handshake, version mismatch, and fallback pass.

## Phase C: PTY Event and Rendering Pipeline Hardening

Deliverables:

- Stable sequence numbering and deterministic ordering for frame/patch events.
- Cursor visibility and alt-screen metadata aligned with stream events.
- Improved race handling for start/stop/resize.

Code impact:

- `sidecar/pty-rust/src/**`
- `daemon-rs/src/runtime_control.rs`

Exit criteria:

- Stress tests pass for rapid input/resize and multi-window churn.

## Phase D: Native Client (runtime-client-rs) MVP

Deliverables:

- New crate: `runtime-client-rs/`
- Features: full-screen attach, raw key forwarding, resize forwarding, focus target attach, reconnect prompt.

Code impact:

- `runtime-client-rs/**` (new)

Exit criteria:

- User can run `discode attach` in `pty-rust` mode and interact with AI CLI end-to-end without OpenTUI.

## Phase E: CLI Routing Switch

Deliverables:

- `discode attach` routes to native client when `runtimeMode=pty-rust`.
- Fallback behavior retained for environments where native client is unavailable.

Code impact:

- `src/cli/commands/attach.ts`
- packaging scripts for native client artifact inclusion

Exit criteria:

- Attach works by default with native client in canary mode.

## Phase F: Minimum Parity

Deliverables:

- Scrollback navigation.
- Copy mode (or clipboard fallback depending on platform).
- Window switch overlay.
- Visible runtime status (connected/disconnected/reconnecting).

Exit criteria:

- Existing users can perform core interactive workflows without TS TUI.

## Phase G: Validation and Observability

Deliverables:

- E2E tests: input echo, focus, resize, reconnect, crash recovery.
- Telemetry events for native attach startup and stream reliability.

Code impact:

- runtime/client tests in Rust + TS contract suites

Exit criteria:

- CI green on macOS and Linux with no contract regressions.

## Phase H: Rollout and Rollback

Deliverables:

- Feature flag: `DISCODE_NATIVE_ATTACH=1` (canary), then default-on.
- Rollback toggle to legacy TS TUI path.

Exit criteria:

- Canary period completes without Sev1/Sev2 incidents.
- Default switched to native attach.

## 6) Proposed Timeline

Week 1:

- Phase A-B complete.

Week 2:

- Phase C-D complete (MVP attach usable).

Week 3:

- Phase E-F complete (default workflow parity).

Week 4:

- Phase G-H complete (canary and default switch decision).

## 7) Risk Register

Risk: VT fidelity drift.

- Mitigation: replay fixtures and sidecar parser regression tests.

Risk: input latency regression.

- Mitigation: stream backpressure metrics and batching controls.

Risk: lifecycle races (window start/stop/focus).

- Mitigation: sequence IDs, idempotent focus, robust state transitions.

Risk: rollout breakage.

- Mitigation: feature flag and one-command rollback to legacy attach path.

## 8) Acceptance Criteria (Project-level)

- `runtimeMode=pty-rust` attach no longer depends on `bin/tui.tsx` for primary flow.
- Native client handles input/resize/focus and exits safely.
- v1 stream clients still work during migration.
- Contract tests and runtime stress tests pass in CI.

# Native Attach Implementation Plan

Canonical for: replacing the TypeScript/OpenTUI attach path with a native terminal client for `runtimeMode=pty-rust`
Audience: contributors working on attach UX, runtime stream contracts, and native runtime client implementation
Update when: a native attach phase lands, scope changes, rollout status changes, or implementation decisions move

Date opened: 2026-03-05
Status: Draft (execution-ready)

## Goal and Scope

Provide a native attach path where:

- `discode attach` opens a full-screen native terminal client.
- AI CLI output is shown as shell-first terminal content instead of widget-centric TypeScript TUI rendering.
- Input, resize, focus, and reconnect remain robust under load.
- Existing runtime control and bridge behaviors remain compatible.

In scope:

- a new native client for runtime attach
- stream protocol v2 and runtime-side compatibility work
- attach routing, rollout controls, and minimum parity features needed to replace the TypeScript TUI for the primary path

Out of scope:

- replacing the `discode` runtime with a zellij runtime
- rebuilding every OpenTUI convenience panel in phase 1
- changing the Discord or Slack bridge contract

## Background

Current `runtimeMode=pty-rust` uses a TypeScript/OpenTUI client for attach and runtime interaction.
The target is to replace that path with a native terminal client that behaves like a shell-first multiplexer UI while keeping `discode` runtime ownership and existing bridge behavior.

Planned architecture:

- runtime ownership remains in the daemon and `pty-rust` sidecar
- a new native client (`runtime-client-rs`) connects to runtime stream and control APIs
- the TypeScript TUI remains available as a legacy fallback during rollout
- the stream protocol adds v2 semantics for the native client while preserving v1 compatibility

## Milestones

1. Phase A: contract freeze.
2. Phase B: stream protocol v2.
3. Phase C: PTY event and rendering pipeline hardening.
4. Phase D: native client (`runtime-client-rs`) MVP.
5. Phase E: CLI routing switch.
6. Phase F: minimum parity.
7. Phase G: validation and observability.
8. Phase H: rollout and rollback.

## Current Progress

- Planned: the native attach direction, rollout model, and target phases are defined in this plan.
- Planned: the target client contract exists in [`../../references/RUNTIME_NATIVE_CLIENT_CONTRACT.md`](../../references/RUNTIME_NATIVE_CLIENT_CONTRACT.md).
- Remaining: this plan does not yet record any completed implementation phases.

## Key Decisions

- Keep runtime ownership in the daemon and `pty-rust` sidecar rather than introducing an external terminal-runtime dependency.
- Build a dedicated Rust native client (`runtime-client-rs`) instead of extending the TypeScript/OpenTUI primary path.
- Introduce protocol v2 for native attach semantics while keeping v1 clients working during migration.
- Roll out behind an explicit feature flag before switching the default attach path.

## Detailed Plan

### Phase A: Contract Freeze

Deliverables:

- `docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md` finalized.
- v2 message shapes, error semantics, and reconnect model fixed.

Exit criteria:

- contract reviewed and approved for implementation
- clear v1 and v2 compatibility rules defined

### Phase B: Stream Protocol v2

Deliverables:

- runtime stream server supports `hello.version = 2`
- version-gated v2 outbound messages for frame, patch, lifecycle, and ack flows
- existing v1 clients continue to function unchanged

Code impact:

- `daemon-rs/src/runtime_stream.rs`
- `src/runtime/protocol.ts`

Exit criteria:

- unit tests for v2 handshake, version mismatch, and fallback pass

### Phase C: PTY Event and Rendering Pipeline Hardening

Deliverables:

- stable sequence numbering and deterministic ordering for frame and patch events
- cursor visibility and alt-screen metadata aligned with stream events
- improved race handling for start, stop, and resize

Code impact:

- `sidecar/pty-rust/src/**`
- `daemon-rs/src/runtime_control.rs`

Exit criteria:

- stress tests pass for rapid input and resize plus multi-window churn

### Phase D: Native Client (`runtime-client-rs`) MVP

Deliverables:

- new crate: `runtime-client-rs/`
- features: full-screen attach, raw key forwarding, resize forwarding, focus-target attach, reconnect prompt

Code impact:

- `runtime-client-rs/**`

Exit criteria:

- users can run `discode attach` in `pty-rust` mode and interact with the AI CLI end to end without OpenTUI

### Phase E: CLI Routing Switch

Deliverables:

- `discode attach` routes to the native client when `runtimeMode=pty-rust`
- fallback behavior retained for environments where the native client is unavailable

Code impact:

- `src/cli/commands/attach.ts`
- packaging scripts for native client artifact inclusion

Exit criteria:

- attach works by default with the native client in canary mode

### Phase F: Minimum Parity

Deliverables:

- scrollback navigation
- copy mode, or clipboard fallback depending on platform
- window-switch overlay
- visible runtime status for connected, disconnected, and reconnecting states

Exit criteria:

- existing users can perform core interactive workflows without the TypeScript TUI

### Phase G: Validation and Observability

Deliverables:

- end-to-end tests for input echo, focus, resize, reconnect, and crash recovery
- telemetry events for native attach startup and stream reliability

Code impact:

- runtime and client tests in Rust plus TypeScript contract suites

Exit criteria:

- CI is green on macOS and Linux with no contract regressions

### Phase H: Rollout and Rollback

Deliverables:

- feature flag `DISCODE_NATIVE_ATTACH=1` for canary, then default-on
- rollback toggle to the legacy TypeScript TUI path

Exit criteria:

- canary period completes without Sev1 or Sev2 incidents
- default switches to native attach

## Remaining Issues or Open Questions

- How much TypeScript TUI parity is actually required before the default switch, beyond the minimum parity list in Phase F?
- Whether copy-mode behavior should be native per platform or standardized behind a shared fallback.
- Whether protocol v2 needs additional flow control semantics once real-world latency and burst-output testing begins.

## Proposed Timeline

Week 1:

- Phase A and Phase B complete

Week 2:

- Phase C and Phase D complete, with MVP attach usable

Week 3:

- Phase E and Phase F complete, with default workflow parity

Week 4:

- Phase G and Phase H complete, with canary results informing the default-switch decision

## Risk Register

Risk: VT fidelity drift.
Mitigation: replay fixtures and sidecar parser regression tests.

Risk: input latency regression.
Mitigation: stream backpressure metrics and batching controls.

Risk: lifecycle races across window start, stop, and focus.
Mitigation: sequence ids, idempotent focus, and robust state transitions.

Risk: rollout breakage.
Mitigation: feature flag and a one-command rollback to the legacy attach path.

## Acceptance Criteria

- `runtimeMode=pty-rust` attach no longer depends on `bin/tui.tsx` for the primary flow
- the native client handles input, resize, and focus and exits safely
- v1 stream clients continue working during migration
- contract tests and runtime stress tests pass in CI

## Related Links

- Runtime attach product behavior: [`../../product-specs/runtime-attach-experience.md`](../../product-specs/runtime-attach-experience.md)
- Native attach target contract: [`../../references/RUNTIME_NATIVE_CLIENT_CONTRACT.md`](../../references/RUNTIME_NATIVE_CLIENT_CONTRACT.md)
- Active exec-plan index: [`README.md`](README.md)

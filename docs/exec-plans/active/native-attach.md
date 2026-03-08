# Native Attach Plan

Canonical for: delivering native terminal attach as the primary `runtimeMode=pty-rust` local interaction path  
Audience: contributors working on runtime stream contracts, native client UX, and attach CLI routing  
Update when: milestone status changes, scope shifts, or rollout decisions change

## Goal / scope

Ship a production-ready native attach flow for `runtimeMode=pty-rust` where `discode attach` uses the Rust native client by default, while preserving runtime ownership, stream compatibility, and deterministic fallback behavior.

In scope:

- stream/control protocol parity required for native attach
- `runtime-client-rs` reliability for connect, render, input, resize, and reconnect
- CLI routing, packaging, and fallback policy for native-first attach
- validation and doc updates required for default-switch readiness

Out of scope:

- replacing daemon or sidecar ownership with an external multiplexer
- changing Discord/Slack bridge contracts

## Background

- `ARCHITECTURE.md` defines `runtime-client-rs` as the native runtime attach packaging target.
- `docs/product-specs/runtime-attach-experience.md` still documents TypeScript/OpenTUI as primary, so native attach is not yet reflected as shipped behavior.
- `docs/NATIVE_ATTACH_IMPLEMENTATION_PLAN.md` and `docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md` already define the target direction and v2 protocol model.
- `src/cli/commands/attach.ts` already includes attach routing/fallback logic that can be tightened for native-first behavior.

## Milestones

1. [x] Contract alignment pass: confirm `docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md` and `src/runtime/protocol.ts` match for v2 handshake/message validation (status: completed 2026-03-08).
2. [x] Stream server parity pass: implement or close gaps in daemon/stream handling for v2 `hello`, ack/error semantics, and version-gated outbound messages (status: completed 2026-03-08).
3. [x] Runtime ordering hardening pass: fix event sequencing and lifecycle race edges needed for stable native client frame/patch apply under rapid input/resize churn (status: completed 2026-03-08).
4. [x] Native client reliability pass: complete `runtime-client-rs` attach loop coverage (subscribe/render/input/resize/reconnect/resync) and error handling needed for daily use (status: completed 2026-03-08).
5. [x] CLI routing and packaging pass: make `discode attach` prefer native attach in `pty-rust`, keep deterministic fallback, and verify artifact packaging/discovery (status: completed 2026-03-08).
6. [x] Validation and rollout readiness pass: land focused tests/docs updates and define default-switch gate criteria for native-first attach (status: completed 2026-03-08).

## Current progress

- Required planning documents were reviewed: `AGENTS.md`, `ARCHITECTURE.md`, `docs/PLANS.md`, native attach references, and runtime attach product spec.
- Milestone 1 completed:
  - added canonical runtime stream v2 inbound validation in `src/runtime/protocol.ts` (version parsing/support checks + operation-specific payload validation)
  - wired `RuntimeStreamServer` to use protocol validators instead of ad-hoc message checks
  - added protocol contract tests in `tests/runtime/protocol.test.ts` and extended stream server unit checks for `bad_subscribe`/`bad_resize`
  - updated `docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md` to match enforced handshake and validation behavior
- Verification for this milestone:
  - passed: `npx vitest run --configLoader runner tests/runtime/protocol.test.ts tests/runtime/stream-server.unit.test.ts`
  - passed: `npm run typecheck`
  - environment limitation: socket-based stream integration tests requiring UDS `listen()` fail in this sandbox with `EPERM`; rerun in a non-sandbox environment as part of Milestone 2 validation.
- Milestone 2 completed:
  - hardened `daemon-rs/src/runtime_stream.rs` inbound validation parity for `hello`, `subscribe`, `focus`, `input`, `resize`, and `ping`:
    - malformed `hello.version` now returns `bad_message`
    - canonical `windowId` validation enforced for stream operations
    - `subscribe` and `resize` numeric payload validation now returns operation-specific errors (`bad_subscribe`, `bad_resize`)
    - strict base64 enforcement for `input.bytesBase64`
    - invalid `ping.id` now returns `bad_message`
  - tightened resize semantics in both Rust and TS stream servers:
    - resize ack is now sent only when runtime resize succeeds
    - missing/non-running windows return `window-exit` (`missing` / `not_running`) without a false-positive ack
  - updated stream contract references to mark `patch-v2` as an optional optimization and to keep daemon-rs migration docs aligned with implemented error codes.
- Verification for this milestone:
  - passed: `cargo test --manifest-path daemon-rs/Cargo.toml runtime_stream`
  - passed: `npx vitest run --configLoader runner tests/runtime/protocol.test.ts tests/runtime/stream-server.unit.test.ts`
  - passed: `cargo fmt --manifest-path daemon-rs/Cargo.toml`
- Milestone 4 completed:
  - hardened native client `runtime-client-rs` patch sequencing and resync behavior:
    - `patch-v2` application now enforces `baseSeq` matching and monotonic `seq`
    - mismatched/stale `patch-v2` no longer mutates local frame state
    - client now requests stream resync (`subscribe` + `focus`) when patch sequencing is invalid
  - improved attach-loop safety during transport transitions:
    - reset local sequence baseline after reconnect
    - reset local sequence baseline on window switch to avoid cross-window stale patch application
  - added unit coverage for patch-v2 happy path and resync-trigger mismatch handling.
- Verification for this milestone:
  - passed: `cargo test --manifest-path runtime-client-rs/Cargo.toml`
  - passed: `cargo fmt --manifest-path runtime-client-rs/Cargo.toml`
  - passed: `npx vitest run --configLoader runner tests/runtime/protocol.test.ts tests/runtime/stream-server.unit.test.ts`
- Milestone 5 completed:
  - tightened native attach binary discovery in `src/cli/commands/attach.ts` for packaged installs:
    - added module-resolution lookup for `@siisee11/discode-runtime-client-<platform>-<arch>`
    - expanded deterministic filesystem hint roots for release artifact layouts
    - preserved explicit override support via `DISCODE_RUNTIME_CLIENT_BIN`
  - hardened fallback behavior for `DISCODE_NATIVE_ATTACH=auto`:
    - auto mode now only attempts native attach when a concrete artifact path is discovered
    - PATH probing fallback is retained only for explicit `DISCODE_NATIVE_ATTACH=on`
  - added CLI test coverage for packaged artifact discovery from `dist/release/runtime-client/...` layout.
- Verification for this milestone:
  - passed: `npx vitest run --configLoader runner tests/discode-cli.test.ts`
  - passed: `npm run typecheck`
- Milestone 6 completed:
  - added deterministic auto-mode fallback coverage in `tests/discode-cli.test.ts`:
    - verifies `DISCODE_NATIVE_ATTACH=auto` skips native spawn when no runtime-client artifact is discoverable
    - verifies attach falls back to OpenTUI in that scenario
  - updated canonical product/spec quality docs for native-first attach:
    - `docs/product-specs/runtime-attach-experience.md` now describes native-first `pty-rust` attach behavior and fallback policy
    - `docs/QUALITY_SCORE.md` now tracks native attach readiness evidence and rollout gate source of truth
  - finalized default-switch gate criteria for rollout-readiness tracking (below).
- Verification for this milestone:
  - passed: `npx vitest run --configLoader runner tests/discode-cli.test.ts`
  - passed: `npm run typecheck`
- Milestone 3 completed:
  - hardened daemon-rs runtime stream ordering to avoid sequence churn and lifecycle race edges under rapid resize/input:
    - unchanged periodic frames are now suppressed using frame-signature coalescing
    - `subscribe`, `focus`, and successful `resize` force a fresh full-frame baseline even when content is unchanged
    - lifecycle transitions clear cached frame signatures so recovery emits deterministic baseline frames
    - forced frame sends now reset `last_flush` to avoid immediate duplicate tick emissions after lifecycle operations
  - added regression tests for:
    - unchanged periodic frame suppression
    - forced frame emission on resize without content change
  - updated canonical docs to reflect ordering/coalescing behavior.
- Verification for this milestone:
  - passed: `cargo test --manifest-path daemon-rs/Cargo.toml runtime_stream`
  - passed: `npx vitest run --configLoader runner tests/runtime/protocol.test.ts tests/runtime/stream-server.unit.test.ts`
  - passed: `cargo fmt --manifest-path daemon-rs/Cargo.toml`

## Key decisions

- Keep runtime ownership in daemon + `pty-rust`; native attach is a client replacement, not runtime replacement.
- Preserve v1/v2 coexistence during rollout to avoid breaking existing clients.
- Keep deterministic fallback behavior during transition to reduce user-facing regressions.
- Treat tests and canonical docs as part of the definition of done for each phase.
- Make `src/runtime/protocol.ts` the canonical parser/validator surface for stream inbound boundary data to avoid drift between docs and runtime behavior.
- Enforce strict canonical `windowId` and strict base64 validation at the stream boundary before runtime API calls.
- Keep Rust and TypeScript stream servers aligned on v2 handshake and operation error semantics to avoid backend-dependent attach behavior.
- Treat `patch-v2` as optional for protocol compliance in this phase; full patch/resync behavior remains a follow-up concern.
- Prefer deterministic baseline frame semantics over maximum frame throughput during lifecycle transitions (`subscribe`/`focus`/`resize`).
- Coalesce unchanged periodic frames in daemon-rs to stabilize sequence progression under load.
- Ship client-side `patch-v2` sequencing guardrails now (base/seq validation + explicit resync) even while `frame-v2` remains the primary transport baseline.
- Keep auto-mode native attach deterministic by requiring an actual discovered runtime-client artifact instead of implicit PATH lookup.
- Prefer package-resolution discovery before cwd-relative guesses so global npm installs find native runtime-client binaries reliably.
- Treat native-first attach as shipped behavior with explicit fallback rather than a hidden/experimental path.
- Keep default-switch evaluation criteria explicit in this execution plan so release decisions are auditable.

## Default-switch gate criteria

Native-first attach remains the default `pty-rust` behavior with OpenTUI fallback. Keep this posture only while all gates stay green:

1. `tests/discode-cli.test.ts` continues to pass for native success, deterministic auto fallback, and non-zero native exit fallback scenarios.
2. `runtime-client-rs` and stream-server protocol tests remain green for handshake/patch ordering behavior (`cargo test --manifest-path runtime-client-rs/Cargo.toml`, `tests/runtime/protocol.test.ts`, `tests/runtime/stream-server.unit.test.ts`).
3. No unresolved P0/P1 issues are open for attach regressions that block session entry (native attach failure without fallback, focus failure without attach recovery, or protocol incompatibility between daemon/client).
4. Canonical docs remain aligned with shipped behavior (`docs/product-specs/runtime-attach-experience.md`, `docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md`, this plan).
5. Release artifacts include platform runtime-client binaries or retain fallback posture explicitly in release notes when artifacts are missing.

## Remaining issues / open questions

- Broader platform packaging/validation expectations (beyond current macOS/Linux assumptions) still need an explicit roadmap.
- Failure taxonomy for fallback vs hard-fail can be tightened further if runtime-client introduces new terminal capability requirements.

## Links to related documents

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [docs/PLANS.md](../../PLANS.md)
- [docs/product-specs/runtime-attach-experience.md](../../product-specs/runtime-attach-experience.md)
- [docs/NATIVE_ATTACH_IMPLEMENTATION_PLAN.md](../../NATIVE_ATTACH_IMPLEMENTATION_PLAN.md)
- [docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md](../../references/RUNTIME_NATIVE_CLIENT_CONTRACT.md)
- [docs/exec-plans/active/README.md](./README.md)

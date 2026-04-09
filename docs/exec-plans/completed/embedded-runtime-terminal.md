# Embedded Runtime Terminal Plan

Status: completed 2026-04-10
Superseded by the detailed execution log: [`embed-a-runtime-terminal-inside-discode-using-the-existing-pty-rust-runtime-stre.md`](./embed-a-runtime-terminal-inside-discode-using-the-existing-pty-rust-runtime-stre.md)

Canonical for: moving local terminal attach into an in-process `discode` surface without regressing `pty-rust` runtime ownership or stream compatibility  
Audience: contributors changing runtime rendering, attach flows, or sidecar/frame ownership  
Update when: milestone status changes, scope shifts, or the chosen attach architecture changes

## Goal / scope

Implement a `discode`-internal terminal surface that behaves like the current native attach flow, while using the existing runtime stream/control contracts and converging the PTY runtime toward the repository's documented Zellij-style structure.

In scope:

- embed a terminal client inside `discode` on top of the runtime stream protocol
- make rendered runtime frames, not raw PTY bytes, the primary attach surface
- reduce duplicated VT/snapshot logic between TypeScript and Rust
- keep current `runtimeMode=pty-rust` runtime ownership in the daemon + sidecar
- preserve current attach reliability requirements: focus, reconnect, resize, multi-window selection, and deterministic fallback

Out of scope:

- replacing `pty-rust` with an external multiplexer
- changing Discord or Slack bridge behavior
- redesigning end-user command semantics unrelated to local attach
- Windows transport parity beyond existing roadmap commitments

## Background

- The canonical architecture already defines the long-term runtime direction as a Zellij-style structure with distinct PTY, terminal-state, screen, renderer, and session-manager responsibilities. See [`docs/references/PTY_RUST_ARCHITECTURE_CONTRACT.md`](../../references/PTY_RUST_ARCHITECTURE_CONTRACT.md).
- The shipped attach path is already client/server based: `discode attach` and `discode tui` prefer the Rust native attach client over the runtime stream/control planes. See [`docs/product-specs/runtime-attach-experience.md`](../../product-specs/runtime-attach-experience.md).
- The v2 stream contract already covers the operations an embedded client needs: `subscribe`, `focus`, `input`, `resize`, `frame-v2`, `patch-v2`, reconnect, and `window-exit`. See [`docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md`](../../references/RUNTIME_NATIVE_CLIENT_CONTRACT.md).
- Current implementation still has architecture drift:
  - sidecar frame generation reparses the full window buffer instead of using a persistent terminal model
  - PTY query handling sometimes rebuilds frames from the whole buffer to recover cursor state
  - TypeScript and Rust both carry VT rendering logic, increasing drift risk
  - stream code still contains plain-text snapshot fallback paths intended for older compatibility cases
- Zellij is the right comparison point because it treats programmatic control, viewport snapshots, real-time subscriptions, and optional clients as first-class concerns rather than bolting a terminal widget directly onto PTY handles.

## Milestones

1. [ ] Baseline and contract freeze
   - confirm the embedded terminal will consume the existing runtime stream/control surface rather than adding a second attach protocol
   - document the minimum parity bar against current native attach behavior
   - identify all remaining raw-buffer fallback paths that would undermine an embedded client

2. [ ] Sidecar authority pass
   - make sidecar-owned terminal state the canonical source for viewport/cursor state
   - stop rebuilding `get_window_frame` from `window.buffer` on every request
   - keep `window.buffer` only as debug/compat/scrollback material where required

3. [ ] Stream convergence pass
   - make `frame-v2` the primary embedded attach payload
   - keep `patch-v2` optional but reliable
   - remove or strictly quarantine plain-text snapshot fallback paths from the primary attach route

4. [ ] Embedded client pass
   - implement an in-process `discode` terminal panel backed by `RuntimeStreamClient`
   - map local input, resize, focus, reconnect, and window switching onto the existing contract
   - preserve native attach as a fallback until the embedded path is production-ready

5. [ ] De-duplication pass
   - choose one authoritative VT/screen implementation for the shipped attach path
   - either reuse Rust-rendered frames everywhere, or formally scope the TS VT engine to non-primary compatibility duties
   - remove dead or duplicate attach-specific rendering code after parity is proven

6. [ ] Verification and rollout pass
   - expand tests around rapid input/resize churn, reconnect/resubscribe, alternate screen transitions, and cursor/query behavior
   - validate the embedded path against the existing native attach regression set
   - update canonical docs when the embedded path becomes primary or shared-default behavior

## Current progress

- Research completed on 2026-04-10:
  - confirmed the repository already points at a Zellij-style target architecture rather than a tmux-style pane-management target
  - confirmed the attach product contract is already stream/client oriented and suitable for an embedded client
  - identified the main implementation gap as authoritative screen ownership, not missing terminal widget code
  - verified the current runtime/native attach test slices are green:
    - `cargo test --manifest-path runtime-client-rs/Cargo.toml`
    - `cargo test --manifest-path sidecar/pty-rust/Cargo.toml`
    - `npx vitest run --configLoader runner tests/runtime/pty-rust-runtime.test.ts tests/runtime/runtime-stream-client.test.ts tests/runtime/stream-server.unit.test.ts`

## Key decisions

- Build the embedded terminal as another runtime-stream client, not as a new PTY owner.
- Keep daemon + sidecar ownership of runtime windows; the client only observes and sends user input.
- Prefer rendered viewport/frame transport over raw ANSI transport for the in-process terminal.
- Treat `frame-v2` as the stable baseline and `patch-v2` as an optimization, matching the existing native attach contract.
- Preserve deterministic native fallback until the embedded terminal proves it can replace or stand alongside the current Rust client.
- Use Zellij as an architectural reference for ownership boundaries and attach optionality, not as a drop-in runtime replacement.

## Remaining issues / open questions

- Whether the long-term primary local terminal surface should be:
  - an in-process TypeScript client inside `discode`,
  - a reusable Rust rendering core shared by both native and embedded clients,
  - or a hybrid where the embedded path is primary and the Rust client remains a recovery/fallback binary.
- How much v1 compatibility code should remain on the main attach path once the embedded terminal is stable.
- Whether full scrollback serialization/export should stay buffer-backed or move to explicit sidecar screen history APIs.
- Whether `runtime-client-rs` should be refactored into a library crate to share frame-application logic with other clients.

## Links to related documents

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [docs/PRODUCT_SENSE.md](../../PRODUCT_SENSE.md)
- [docs/product-specs/runtime-attach-experience.md](../../product-specs/runtime-attach-experience.md)
- [docs/references/RUNTIME_WINDOW_API.md](../../references/RUNTIME_WINDOW_API.md)
- [docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md](../../references/RUNTIME_NATIVE_CLIENT_CONTRACT.md)
- [docs/references/PTY_RUST_ARCHITECTURE_CONTRACT.md](../../references/PTY_RUST_ARCHITECTURE_CONTRACT.md)
- [docs/exec-plans/completed/native-attach.md](../completed/native-attach.md)
- [docs/exec-plans/completed/pty-rust-replacement.md](../completed/pty-rust-replacement.md)

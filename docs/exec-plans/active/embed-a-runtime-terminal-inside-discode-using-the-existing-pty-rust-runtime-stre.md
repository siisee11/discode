# Embedded Runtime Terminal Plan

Canonical for: embedding a runtime terminal inside discode while preserving `pty-rust` stream/control compatibility and converging renderer ownership boundaries
Audience: contributors touching TUI surfaces, runtime stream/control integration, and sidecar rendering ownership
Update when: milestone status changes, scope shifts, or rollout decisions change

## Goal / scope

Deliver an embedded runtime terminal inside discode by reusing the existing `pty-rust` runtime stream/control contracts, converge runtime rendering toward the documented Zellij-style ownership model, update tests and canonical docs, and ship the work in a PR.

In scope:

- embed runtime terminal rendering/input inside discode using existing runtime stream and control APIs
- keep protocol and control compatibility with the shipped `pty-rust` contract
- align runtime rendering ownership with `docs/references/PTY_RUST_ARCHITECTURE_CONTRACT.md`
- update TypeScript and Rust tests for behavior and contract coverage
- update canonical docs and complete this plan as execution evidence
- open a PR from `ralph/embedded-runtime-terminal` when all gates pass

Out of scope:

- introducing new runtime backends or replacing `pty-rust` ownership with an external multiplexer
- changing Discord/Slack messaging contracts
- protocol-family expansion beyond compatibility-preserving updates needed for the embedding work

## Background

- `ARCHITECTURE.md` defines `pty-rust` as the shipped runtime backend and documents the runtime stream socket + control-plane model.
- `docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md` defines handshake, message validation, and ordering expectations for runtime stream operation.
- `docs/references/PTY_RUST_ARCHITECTURE_CONTRACT.md` defines Zellij-style ownership boundaries (`pty_bus`, `terminal_pane`, `grid_scrollback`, `screen`, `renderer`, `session_manager`, `rpc`).
- Existing completed plans (`docs/exec-plans/completed/native-attach.md`, `docs/exec-plans/completed/pty-rust-replacement.md`) provide prior compatibility and reliability guardrails that this work must preserve.

## Milestones

1. [x] Discovery and integration seam freeze: identify the exact discode runtime UI embedding surface and current stream/control call graph, then lock a compatibility-preserving implementation seam. (status: completed 2026-04-10)
2. [x] Embedded terminal host implementation: wire runtime subscribe/focus/input/resize lifecycle into discode UI flow and render runtime frames inside discode using existing contracts. (status: completed 2026-04-10)
3. [x] Rendering ownership convergence pass: refactor touched runtime rendering paths so terminal-state mutation, screen projection, and renderer serialization remain inside the documented Zellij-style module ownership boundaries. (status: completed 2026-04-10)
4. [x] Test updates and reliability pass: add/update targeted Rust + TypeScript tests for embedded rendering, input/resize/focus behavior, stream ordering assumptions, and regressions. (status: completed 2026-04-10)
5. [x] Canonical docs and plan completion pass: update architecture/product/frontend/reference docs for shipped embedded-terminal behavior and record final progress/decisions in this plan. (status: completed 2026-04-10)
6. [x] Final validation and PR publication: run required quality gates, stage final changes, and open the PR with a clear compatibility/risk summary. (status: completed 2026-04-10)

## Current progress

- Reviewed required planning and architecture docs: `AGENTS.md`, `ARCHITECTURE.md`, `docs/PLANS.md`, and execution-plan conventions.
- Reviewed runtime contract references relevant to this work (`RUNTIME_NATIVE_CLIENT_CONTRACT`, `PTY_RUST_ARCHITECTURE_CONTRACT`) and related completed plans.
- M1 discovery complete: frozen the embedded-terminal integration seam at `src/cli/commands/tui.ts` by routing launch behavior through `src/cli/common/runtime-terminal-host.ts`.
- M1 call graph captured for the current shipped path:
  - `bin/discode.ts` (`tui` subcommand) -> `tuiCommand` (`src/cli/commands/tui.ts`)
  - `tuiCommand` -> `RuntimeSessionManager.connect` (runtime stream `hello`)
  - `tuiCommand` -> `RuntimeSessionManager.fetchWindows` (`GET /runtime/windows`) -> startup window selection/focus decision
  - `tuiCommand` -> `RuntimeSessionManager.focusWindow` (stream `focus` + `POST /runtime/focus` for compatibility)
  - `tuiCommand` -> `openRuntimeTerminal` (new seam, introduced in M1 and expanded in later milestones)
- M1 compatibility seam lock details:
  - introduced `RuntimeTerminalHost`/`RuntimeTerminalHostId` and `openRuntimeTerminal(...)` to isolate terminal-launch strategy from `tuiCommand`
  - retained existing behavior by keeping `native-attach` as the sole active host in `hostOrder`
  - reserved explicit insertion point for embedded runtime host ahead of native attach without changing runtime stream/control contracts
- M2 embedded host implementation complete:
  - added `src/cli/common/runtime-terminal-embedded-host.ts` as an in-process terminal host using existing `RuntimeSessionManager` contracts
  - embedded host lifecycle now explicitly wires:
    - connection gate: `session.requireConnected(...)`
    - focus: `session.focusWindow(windowId)`
    - subscribe/bootstrap: `session.readWindowOutput(sessionName, windowName, cols, rows)` (triggers stream subscription path)
    - resize: `session.sendResize(...)` at startup and on terminal `resize` events
    - input: raw keypress translation to control bytes sent through `session.sendInput(windowId, Buffer)`
    - render: frame updates from `session.registerFrameListener(...)` into alternate-screen terminal output
  - integrated embedded host into seam by updating `src/cli/common/runtime-terminal-host.ts`:
    - host order now prefers `embedded` then falls back to `native-attach`
    - host launching is async to support in-process interactive lifetime
  - updated `src/cli/commands/tui.ts` to pass `session` into `openRuntimeTerminal(...)` and await host launch result
- M2 targeted checks:
  - added host order/fallback tests: `tests/cli/common/runtime-terminal-host.test.ts`
  - passed: `npx vitest run --configLoader runner tests/cli/common/runtime-terminal-host.test.ts tests/cli/commands/tui.test.ts`
  - passed: `npm run -s typecheck`
- M3 rendering ownership convergence complete:
  - extracted embedded terminal screen projection ownership into `src/cli/common/runtime-terminal-screen.ts`
    - owns screen-local state updates (`setPlainOutput`, `applyFrame`)
    - owns viewport projection (`project(cols, rows)`) and row fitting logic
  - extracted terminal serialization ownership into `src/cli/common/runtime-terminal-renderer.ts`
    - owns alternate-screen enter/exit escape generation
    - owns deterministic redraw serialization from projected rows (`renderProjection(...)`)
  - slimmed `src/cli/common/runtime-terminal-embedded-host.ts` to host IO/lifecycle concerns only:
    - stdin key capture -> runtime input send
    - terminal resize events -> runtime resize send
    - frame listener wiring -> `RuntimeTerminalScreen` updates -> renderer output write
  - ownership mapping to Zellij-style contract for touched TS path:
    - `RuntimeSessionManager` remains stream/control adapter and terminal-state mutation ingress boundary
    - `runtime-terminal-screen` is the screen projection layer
    - `runtime-terminal-renderer` is the renderer serialization layer
    - embedded host now acts as transport/interaction shell and does not own screen formatting logic
- M3 targeted checks:
  - added screen/renderer unit coverage:
    - `tests/cli/common/runtime-terminal-screen.test.ts`
    - `tests/cli/common/runtime-terminal-renderer.test.ts`
  - passed: `npx vitest run --configLoader runner tests/cli/common/runtime-terminal-renderer.test.ts tests/cli/common/runtime-terminal-screen.test.ts tests/cli/common/runtime-terminal-host.test.ts tests/cli/commands/tui.test.ts`
  - passed: `npm run -s typecheck`
- M4 test and reliability pass complete:
  - added TypeScript lifecycle/reliability tests for the embedded host in `tests/cli/common/runtime-terminal-embedded-host.test.ts`:
    - non-TTY short-circuit behavior
    - focus + subscribe bootstrap + resize wiring
    - key input forwarding and ctrl+q shutdown
    - VT arrow-key input mapping regression coverage
  - added Rust stream-ordering regression test in `daemon-rs/src/runtime_stream.rs`:
    - `focus_forces_fresh_frame_even_without_content_change`
    - verifies focus emits an ack + forced fresh `frame-v2` baseline even without content changes
  - revalidated adjacent reliability behavior for resize and burst churn in the same runtime-stream suite
- M4 targeted checks:
  - passed: `npx vitest run --configLoader runner tests/cli/common/runtime-terminal-embedded-host.test.ts tests/cli/common/runtime-terminal-host.test.ts tests/cli/common/runtime-terminal-screen.test.ts tests/cli/common/runtime-terminal-renderer.test.ts tests/cli/commands/tui.test.ts`
  - passed: `cargo test --manifest-path daemon-rs/Cargo.toml runtime_stream::tests`
  - passed: `npm run -s typecheck`
- M5 canonical docs completion:
  - updated architecture map in `ARCHITECTURE.md`:
    - `discode tui` is documented as embedded-terminal first
    - native attach client documented as deterministic fallback
    - runtime control map now includes embedded terminal host/screen/renderer modules
  - updated frontend map in `docs/FRONTEND.md`:
    - embedded host + screen + renderer listed as primary terminal UI surfaces
    - native attach documented as fallback UI surface
  - updated product maps/specs:
    - `docs/PRODUCT_SENSE.md` now reflects embedded local runtime terminal with native fallback
    - `docs/product-specs/runtime-attach-experience.md` now documents host selection, embedded lifecycle wiring (focus/input/resize/subscribe), and ownership split (`runtime-terminal-screen` + `runtime-terminal-renderer`)
  - updated runtime references:
    - `docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md` now defines a shared local terminal client contract (embedded + native), not native-only semantics
    - `docs/references/RUNTIME_WINDOW_API.md` now explicitly documents embedded and native host consumption of control/stream boundaries
  - `docs/references/index.md` now labels `RUNTIME_NATIVE_CLIENT_CONTRACT.md` as shared embedded/native stream contract
- M6 final validation and publication pass complete:
  - updated bridge tests to match current runtime-state helper exports used by runtime routes/message router:
    - `tests/bridge/message-router.test.ts`
    - `tests/bridge/hook-runtime-routes-ensure.test.ts`
    - added mocked `getProjectRuntimeSession(...)` alongside `getInstanceRuntimeWindow(...)` to keep instance-state mocks aligned with `src/state/instances.js`
  - updated one delivery-guidance assertion in `tests/bridge/message-router.test.ts` to match current user-facing wording (`agent runtime window is not running`)
  - passed full quality gate: `make -f Makefile.harness ci`
  - published PR from `ralph/embedded-runtime-terminal` with compatibility/risk summary in the PR description

## Key decisions

- Reuse the existing `pty-rust` runtime stream/control contracts as the compatibility baseline; avoid protocol churn unless required for strict compatibility fixes.
- Treat Zellij-style ownership boundaries from `PTY_RUST_ARCHITECTURE_CONTRACT` as the rendering architecture target for touched paths.
- Require tests and canonical doc updates as part of definition-of-done, not as follow-up work.
- Keep milestone slices small enough for one coding-loop iteration to preserve reviewability and rollback safety.
- Freeze the embedding seam at the terminal-launch boundary (`tuiCommand` -> `openRuntimeTerminal`) instead of changing runtime protocol or daemon routes.
- Keep `RuntimeSessionManager` as the compatibility boundary for stream/control operations so M2 can wire subscribe/input/resize/focus lifecycle without transport rewrites.
- Make embedded host the preferred runtime terminal when running in a local TTY, with deterministic fallback to native attach when embedded launch is unavailable.
- Keep embedded rendering as a contract-preserving adapter over `RuntimeSessionManager` instead of introducing new stream or control-plane message shapes.
- Align touched TypeScript rendering ownership with Zellij-style layering by isolating screen projection and renderer serialization into dedicated modules used by the host shell.
- Treat focus-triggered fresh frame emission as a required stream ordering invariant and keep it protected by daemon-rs unit coverage.
- Treat embedded-host key mapping and resize/focus lifecycle wiring as regression-sensitive behavior with dedicated TypeScript tests.
- Canonical product/architecture/reference docs should describe runtime behavior in host-selection terms (embedded-first with native fallback) while preserving unchanged stream/control contracts.

## Remaining issues / open questions

- None.

## Links to related documents

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [docs/PLANS.md](../../PLANS.md)
- [docs/FRONTEND.md](../../FRONTEND.md)
- [docs/PRODUCT_SENSE.md](../../PRODUCT_SENSE.md)
- [docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md](../../references/RUNTIME_NATIVE_CLIENT_CONTRACT.md)
- [docs/references/PTY_RUST_ARCHITECTURE_CONTRACT.md](../../references/PTY_RUST_ARCHITECTURE_CONTRACT.md)
- [docs/exec-plans/completed/native-attach.md](../completed/native-attach.md)
- [docs/exec-plans/completed/pty-rust-replacement.md](../completed/pty-rust-replacement.md)

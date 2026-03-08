# PTY Rust Architecture Contract (Phase 0)

This document defines the replacement contract for moving from the current `pty-rust` PoC implementation to a Zellij-style runtime structure.

Scope: `sidecar/pty-rust` refactor only. This phase does not add end-user features.

## 1) Current PoC to Target Module Map

Today, almost all runtime logic is concentrated in `sidecar/pty-rust/src/main.rs` with parser logic in `sidecar/pty-rust/src/vt_lite.rs`.

Target modules:

| Target module | Current PoC location | Target responsibility |
|---|---|---|
| `pty_bus` | `main.rs` (`start_window`, PTY read/write, resize) | Owns PTY spawn/read/write/resize and PTY lifecycle primitives only |
| `terminal_pane` | `vt_lite.rs` (`feed`, cursor/state transitions) | Owns terminal state machine and VT interpretation orchestration |
| `grid_scrollback` | `vt_lite.rs` (cell grid + line ops) | Owns grid writes, scroll regions, scrollback trimming, cell storage |
| `screen` | `vt_lite.rs` (`into_frame`) | Owns viewport projection, cursor metadata, and frame assembly |
| `renderer` | `vt_lite.rs` (segment compaction in `into_frame`) | Owns deterministic style segments and frame diff/patch generation |
| `session_manager` | `main.rs` (`SidecarState`, window/session maps, lifecycle) | Owns session/window metadata, state transitions, env, process status |
| `rpc` | `main.rs` (`RpcRequest`, `RpcResponse`, `handle_request`) | Transport decode/encode + command dispatch only |

## 2) Module Ownership and Boundary Rules

Required boundaries (must hold after each refactor step):

1. `rpc` is transport-only: decode request -> invoke command handler -> encode response.
2. `rpc` must not touch PTY handles, parser internals, or window state directly.
3. `session_manager` is the only owner of session/window lifecycle and mutable registry state.
4. `pty_bus` is the only module allowed to own PTY master/child/writer handles.
5. `terminal_pane` and `grid_scrollback` are the only owners of terminal parse/state mutation.
6. `screen` only composes view models from terminal state; it does not parse VT bytes.
7. `renderer` only performs deterministic serialization/compaction/diffing from screen output.

Allowed dependency direction:

`rpc` -> `session_manager` -> (`pty_bus`, `terminal_pane`) -> `grid_scrollback` -> `screen` -> `renderer`

Event/data flow direction:

`pty_bus bytes` -> `terminal_pane/grid_scrollback` -> `screen` -> `renderer` -> `rpc response/event`

## 3) RPC Method to Command-Handler Mapping

Contract goal: keep the external RPC surface stable while moving implementation ownership.

| RPC method | Command owner |
|---|---|
| `hello` | `rpc` (health/version route) |
| `get_or_create_session` | `session_manager` |
| `set_session_env` | `session_manager` |
| `window_exists` | `session_manager` |
| `start_window` | `session_manager` orchestrating `pty_bus` |
| `type_keys` | `session_manager` -> `pty_bus.write_input` |
| `send_enter` | `session_manager` -> `pty_bus.write_input` |
| `resize_window` | `session_manager` -> `pty_bus.resize` + pane resize coordination |
| `list_windows` | `session_manager` |
| `get_window_buffer` | `session_manager` (debug/compat surface backed by pane state) |
| `get_window_frame` | `session_manager` -> `screen` -> `renderer` |
| `stop_window` | `session_manager` -> `pty_bus.stop` |
| `dispose` | `session_manager` coordinated shutdown |

## 4) Migration Policy (No Feature Additions)

During replacement phases (0-7):

- No net-new user-facing runtime features.
- Preserve existing RPC method names and payload shapes unless explicitly versioned.
- Prefer behavior-preserving refactors with adapter shims over parallel feature branches.
- Every structural move must keep existing tests passing before the next move.
- If behavior drift is found, fix drift before continuing refactor depth.

Out of scope until replacement is complete:

- New protocol features unrelated to PTY replacement.
- New rendering capabilities not required for parity.
- Daemon API expansion not required for compatibility.

## 5) Risk List and Mitigations

| Risk | Failure mode | Mitigation | Validation gate |
|---|---|---|---|
| VT fidelity | Incorrect cursor/screen state on real CLIs | Regression fixtures from real transcripts, parser state machine hardening | Phase 3 fixture pass rate target |
| Stream latency | Slow frame updates due to transport/process model | Persistent RPC channel, request ids/timeouts, frame coalescing | Phase 2 tail latency improvement |
| Platform parity | Linux/macOS behavior divergence | Unix transport consistency + CI matrix e2e (macOS/Linux) | Phase 6 unix-platform gate |
| Lifecycle races | Start/stop/resize/dispose races causing leaks/stale state | Explicit lifecycle state machine + race-focused stress tests | Phase 5 leak/race gate |

## 6) Phase-0 Deliverable

This document is the architecture contract source for:

- target module map,
- ownership/boundary rules,
- RPC-to-handler mapping,
- migration policy,
- replacement risk register.

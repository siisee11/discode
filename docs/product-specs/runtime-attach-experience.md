# Runtime Attach Experience

Status: active
Audience: contributors changing attach flows, TUI behavior, or native runtime clients
Update when: attach entrypoints, runtime focus behavior, host selection rules, or primary attach client changes

## Goal

Provide a reliable way to interact with active agent sessions locally while the daemon keeps remote chat surfaces in sync.

## Current Product Behavior

- `pty-rust` uses the runtime control plane plus stream transport for attach and interactive I/O
- `discode attach` uses the Rust `runtime-client-rs` binary for local interactive attach
- `discode` / `discode tui` are embedded-terminal first whenever local TTY conditions are available
- embedded terminal host uses existing runtime contracts via `RuntimeSessionManager`:
  - connection gate + stream handshake
  - subscribe/bootstrap through `readWindowOutput(...)`
  - focus through `focusWindow(...)`
  - input through `sendInput(...)`
  - resize through `sendResize(...)` at startup and terminal resize events
- embedded terminal rendering ownership in `discode tui` is split into:
  - `runtime-terminal-screen` (screen projection)
  - `runtime-terminal-renderer` (deterministic serialization to terminal output)
- when embedded launch is unavailable, host selection falls back to `runtime-client-rs`
- auto-mode native attach is deterministic:
  - binary discovery uses explicit `DISCODE_RUNTIME_CLIENT_BIN`, package-resolution artifacts, and deterministic filesystem hints
  - `DISCODE_NATIVE_ATTACH=auto` only attempts native attach when a concrete artifact is discovered (no implicit PATH probing)
  - `DISCODE_NATIVE_ATTACH=on` keeps PATH probing (`discode-runtime-client`) as a final explicit-override fallback

## Open Edges

- keep embedded + native fallback behavior aligned with runtime stream contracts as protocol revisions land

## Canonical References

- Runtime contract: [`../references/RUNTIME_WINDOW_API.md`](../references/RUNTIME_WINDOW_API.md)
- Native attach target contract: [`../references/RUNTIME_NATIVE_CLIENT_CONTRACT.md`](../references/RUNTIME_NATIVE_CLIENT_CONTRACT.md)
- Native attach execution plan: [`../exec-plans/completed/native-attach.md`](../exec-plans/completed/native-attach.md)

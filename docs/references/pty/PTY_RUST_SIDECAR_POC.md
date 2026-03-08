# PTY Rust Sidecar PoC

Canonical for: the original Phase 4 sidecar PoC shape kept as migration history
Audience: contributors tracing how the PTY Rust runtime evolved from the early sidecar design
Status: historical reference
Update when: this document is superseded, archived elsewhere, or no longer provides useful migration context

This document describes the Phase 4 PoC shape for `runtimeMode=pty-rust`.

## Components

- Node runtime adapter: `src/runtime/pty-rust-runtime.ts`
- RPC client: `src/runtime/rust-sidecar-client.ts`
- Rust sidecar crate: `sidecar/pty-rust`

## RPC transport

- Unix domain socket request/response
- Runtime support scope: macOS/Linux
- Sidecar commands:
  - `server --socket <path>`
  - `request --socket <path> --method <name> --params <json>`

## Supported PoC methods

- `hello`
- `health`
- `get_or_create_session`
- `set_session_env`
- `window_exists`
- `start_window`
- `type_keys`
- `send_enter`
- `resize_window`
- `list_windows`
- `get_window_buffer`
- `get_window_frame`
- `stop_window`
- `dispose`

## Runtime behavior

- `pty-rust` runtime is sidecar-only. If sidecar startup fails, runtime initialization fails.
- `health` reports RPC observability counters (`requestsTotal`, `errorsTotal`, per-method latency/error metrics).
- `RustSidecarClient#getStartupMetrics()` exposes sidecar startup strategy, duration, and probe attempts.

## Current rendering scope (Phase 4 continuation)

- `get_window_frame` now uses a VT-lite renderer in the Rust sidecar (not plain ANSI stripping).
- Supported control paths include common cursor/clear/style flows:
  - cursor move: `CSI A/B/C/D/H/f/G/d`
  - erase: `CSI J/K`
  - style: `CSI m` (16-color, 256-color, truecolor, bold/italic/underline/inverse)
  - cursor save/restore: `CSI s/u`, `ESC 7/8`
  - alt-screen + cursor visibility: `CSI ?1049 h/l`, `CSI ?25 h/l`
- The mode runs through Rust sidecar path only.

## Build + run

```bash
cd sidecar/pty-rust
cargo build --release

export DISCODE_PTY_RUST_SIDECAR_BIN="/absolute/path/to/sidecar/pty-rust/target/release/discode-pty-sidecar"
discode config --runtime-mode pty-rust
discode daemon stop
discode daemon start
```

Host binary package helper:

```bash
npm run sidecar:package
```

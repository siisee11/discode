# PTY Rust Query-Response Policy

Canonical for: supported PTY query sequences and partial-sequence handling rules in the Rust sidecar path
Audience: contributors changing terminal query behavior, VT parsing, or compatibility handling
Status: active reference
Update when: PTY query support, defaults, or carry semantics change

This policy defines which terminal query sequences the Rust sidecar responds to in PTY mode and how partial sequences are handled.

Implementation references:

- `sidecar/pty-rust/src/query_policy.rs`
- `sidecar/pty-rust/src/pty_bus.rs`

## Supported queries

- `CSI 6n` -> cursor position report (`ESC [ row ; col R`)
- `CSI ?6n` -> DEC private cursor position report (`ESC [ ? row ; col R`)
- `CSI 5n` -> device status ok (`ESC [ 0 n`)
- `CSI ?<mode>$p` -> private mode report (`ESC [ ? mode ; state $ y`)
- `CSI ?u` -> key reporting capability response (`ESC [ ? 0 u`)
- `CSI 14t` -> window pixel size report (`ESC [ 4 ; height ; width t`)
- `CSI c` -> primary DA response (`ESC [ ? 62 ; c`)
- `OSC 10;?` -> foreground color report
- `OSC 11;?` -> background color report
- `OSC 4;<index>;?` -> indexed color report (0..255)
- `APC ... a=q ... ST` -> kitty graphics handshake response (`ESC _ Gi=31337;OK ESC \\`)

## Private mode state

- State is tracked per window.
- `CSI ?<mode>h/l` updates tracked mode state.
- For mode reports, defaults follow existing TS runtime behavior:
  - mode `7` and `25` default to enabled (`1`)
  - all other unknown modes default to disabled (`2`)

## Partial/incomplete sequence handling

- Incomplete `ESC`, `CSI`, `OSC`, and `APC` sequences are carried across read chunks.
- Carry buffer is per-window and consumed on next chunk.
- No bytes are emitted for incomplete queries until sequence terminates.

## Cursor and geometry source

- Responses use sidecar terminal frame state (cursor row/col + window cols/rows) derived in the PTY read loop.
- This keeps response behavior aligned with the sidecar VT parser/model used for rendering.

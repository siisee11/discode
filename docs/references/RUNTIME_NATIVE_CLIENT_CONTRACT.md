# Runtime Native Client Contract

Date: 2026-03-08
Status: Draft (implementation target)

## 1) Purpose

Define the runtime stream/control contract for local terminal clients in `runtimeMode=pty-rust`, including:

- embedded `discode tui` runtime host
- Rust native attach fallback client (`runtime-client-rs`)

This contract uses stream protocol version 2 while maintaining compatibility with existing version 1 clients.

## 2) Scope

In scope:

- runtime stream protocol v2 handshake and message schema
- local terminal client lifecycle (connect, subscribe, input, resize, reconnect, exit)
- compatibility and rollout rules for v1/v2 coexistence

Out of scope:

- Discord/Slack bridge payload changes
- replacing pty-rust runtime ownership with external multiplexer runtime

## 3) Terminology

- Runtime server: daemon runtime stream endpoint.
- Local terminal client: embedded or native terminal consumer of runtime stream/control contracts.
- Native client: Rust terminal attach fallback client.
- Embedded host: `discode tui` in-process terminal host.
- Window ID: canonical `<sessionName>:<windowName>`.
- Active window: currently focused runtime window for direct input.

## 4) Transport

- Unix/macOS: UDS at `<state-dir>/runtime.sock` (default `~/.discode/runtime.sock`).
- Windows: named pipe support may be added later, but initial native attach target is macOS/Linux.
- Framing: line-delimited JSON (`\n`).

## 5) Protocol Versioning

- Existing protocol remains `v1`.
- New native attach protocol is `v2`.
- Handshake parsing and inbound message validation are canonicalized in `src/runtime/protocol.ts` (`parseRuntimeStreamProtocolVersion`, `isSupportedRuntimeStreamProtocolVersion`, and `validateRuntimeStreamInboundMessage`).
- Server behavior:
  - Accept `hello.version=1` and `hello.version=2`.
  - Accept integer `hello.version` as either number or numeric string.
  - If `hello.version` is omitted, server defaults to protocol family `v1`.
  - Reject malformed `hello.version` with `error.code="bad_message"`.
  - Respond in the same version family as the client request.
  - Reject unsupported versions with `error.code="unsupported_protocol_version"`.

## 6) Handshake

Client hello:

```json
{"type":"hello","version":2}
```

Server success:

```json
{"type":"hello","ok":true,"streamProtocolVersion":2}
```

Server reject:

```json
{"type":"error","code":"unsupported_protocol_version","message":"...","streamProtocolVersion":2}
```

## 7) Client -> Server Messages (v2)

`subscribe`

```json
{"type":"subscribe","windowId":"bridge:my-window","cols":180,"rows":48}
```

Behavior:

- Required: canonical `windowId` (`<sessionName>:<windowName>`).
- Optional: `cols`, `rows` (integer viewport hint).
- Malformed payload: `error.code="bad_subscribe"`.
- If runtime window does not exist, server emits `window-exit` with `signal="missing"` after subscribe.

`focus`

```json
{"type":"focus","windowId":"bridge:my-window"}
```

Behavior:

- Sets active input target.
- Missing/invalid canonical `windowId`: `error.code="bad_focus"`.

`input`

```json
{"type":"input","windowId":"bridge:my-window","bytesBase64":"SGVsbG8="}
```

Behavior:

- Raw bytes forwarded to window PTY.
- Missing fields, invalid canonical `windowId`, or invalid strict base64: `error.code="bad_input"`.

`resize`

```json
{"type":"resize","windowId":"bridge:my-window","cols":160,"rows":42}
```

Behavior:

- Resizes target window viewport.
- Missing/invalid canonical `windowId` or non-positive/non-integer `cols`/`rows`: `error.code="bad_resize"`.

`ping`

```json
{"type":"ping","id":"6ca8d5f8"}
```

Behavior:

- Server replies with `pong` echo for liveness and RTT measurement.
- `id` is optional; when present it must be a string.

## 8) Server -> Client Messages (v2)

`hello`

```json
{"type":"hello","ok":true,"streamProtocolVersion":2}
```

`ack`

```json
{"type":"ack","op":"focus","windowId":"bridge:my-window","streamProtocolVersion":2}
```

Notes:

- `op` values: `subscribe`, `focus`, `input`, `resize`.

`frame-v2`

```json
{
  "type":"frame-v2",
  "windowId":"bridge:my-window",
  "seq":1024,
  "cursorRow":22,
  "cursorCol":13,
  "cursorVisible":true,
  "lineCount":43,
  "lines":[{"segments":[{"text":"$ ","fg":"#ffffff"}]}],
  "streamProtocolVersion":2
}
```

Rules:

- `seq` is strictly increasing per `windowId`.
- Full frame may be sent after subscribe, focus, reconnect, and recovery paths.

`patch-v2`

```json
{
  "type":"patch-v2",
  "windowId":"bridge:my-window",
  "seq":1025,
  "baseSeq":1024,
  "lineCount":43,
  "ops":[{"kind":"replace","start":22,"deleteCount":1,"lines":[{"segments":[{"text":"$ ls","fg":"#ffffff"}]}]}],
  "cursorRow":22,
  "cursorCol":5,
  "cursorVisible":true,
  "streamProtocolVersion":2
}
```

Rules:

- Client applies patch only when `baseSeq` matches local latest.
- On mismatch, client requests resync by re-subscribing.
- `patch-v2` is an optional optimization; servers may emit only `frame-v2` while still remaining protocol-compliant.
- Native client reliability requirement: stale or malformed `patch-v2` (`baseSeq` mismatch, missing seq fields, or non-monotonic `seq`) must not mutate local frame state.

`window-exit`

```json
{"type":"window-exit","windowId":"bridge:my-window","exitCode":0,"signal":null,"streamProtocolVersion":2}
```

`pong`

```json
{"type":"pong","id":"6ca8d5f8","streamProtocolVersion":2}
```

`error`

```json
{"type":"error","code":"bad_input","message":"...","streamProtocolVersion":2}
```

## 9) Error Codes (v2)

Transport and parse:

- `bad_json`
- `bad_message`
- `unknown_type`
- `unsupported_protocol_version`

Operation-level:

- `bad_subscribe`
- `bad_focus`
- `bad_input`
- `bad_resize`

## 10) Ordering and Reliability Rules

- Event ordering is guaranteed per `windowId` by monotonic `seq`.
- Different windows may interleave.
- Servers may suppress unchanged periodic frame emissions to reduce sequence churn and transport noise.
- `subscribe`, `focus`, and successful `resize` should force a fresh full-frame baseline emit even when rendered content is unchanged.
- Client must treat stream disconnect as transient and retry.
- Client must not assume input ack means screen update is already rendered.

## 11) Reconnect Model

Client reconnect policy:

- Exponential backoff: 100ms -> 300ms -> 1s -> 2s -> 5s (cap).
- After reconnect, client replays `subscribe` + `focus`.
- If first patch cannot be applied, force full-frame resync by re-subscribe.

Server reconnect expectations:

- No hard session affinity required.
- Fresh connection can subscribe to existing runtime windows.
- Disconnected clients must not affect runtime window lifecycle.

## 12) Security and Local Access

- Runtime stream is local-process transport only (UDS/pipe), not public network.
- Socket/pipe permissions must restrict unintended local users where possible.
- No long-lived auth token is required for stream v2 in local-only mode.

## 13) Compatibility Policy

- v1 clients stay functional during migration.
- Server continues to emit v1 payloads for v1 handshakes.
- Embedded and native local terminal clients use v2.
- Removal of v1 support requires separate deprecation cycle and release note.

## 14) Acceptance Criteria

- Embedded and native local terminal clients can complete: connect -> subscribe -> render -> input -> resize -> reconnect.
- Under stress (rapid input/resize), no unrecoverable desync.
- Version mismatch handling is explicit and deterministic.
- Contract tests cover message validation and ordering guarantees.

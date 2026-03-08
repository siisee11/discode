# Runtime Window API (Phase 3)

This document defines the stable runtime window contract used for `pty-rust` backend.

## 1) Window Identity

- Canonical ID: `<sessionName>:<windowName>`
- Shared helper: `src/runtime/window-id.ts`
  - `toRuntimeWindowId({ sessionName, windowName })`
  - `parseRuntimeWindowId(windowId)`

## 2) Stable Window Operations

Shared adapter: `src/runtime/window-api.ts`

- `start(ref, command)`
- `input(ref, bytes)`
- `resize(ref, cols, rows)`
- `getFrame(ref, cols?, rows?)`
- `stop(ref, signal?)`

Supplementary operations used by control/stream planes:

- `submit(ref)`
- `getBuffer(ref)`
- `exists(ref)`
- `list(sessionName?)`

## 3) Plane Boundaries

- Control plane (`src/runtime/control-plane.ts`):
  - Window discovery, focus, text submit, buffered polling, stop
  - HTTP endpoints (`/runtime/windows`, `/runtime/focus`, `/runtime/input`, `/runtime/buffer`, `/runtime/stop`)
- Stream plane (`src/runtime/stream-server.ts`):
  - Subscription, frame/patch streaming, raw input bytes, resize
  - UDS/named pipe socket transport

Both planes use the same window identity + adapter contract to keep behavior aligned.

## 4) Serialization Versioning

- Control responses include `protocolVersion`
- Stream messages include `streamProtocolVersion`
- Stream handshake validates requested version (`hello.version`)

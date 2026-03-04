# Daemon Rust Migration

## B0 Contract Freeze (TypeScript Baseline)

This document freezes the daemon-facing contracts that Rust must keep compatible with while TypeScript remains the production baseline.

### Frozen protocol versions

- Runtime control protocol: `RUNTIME_CONTROL_PROTOCOL_VERSION = 1` (`src/runtime/protocol.ts`)
- Runtime stream protocol: `RUNTIME_STREAM_PROTOCOL_VERSION = 1` (`src/runtime/protocol.ts`)

### HTTP control-plane contract

Server behavior is defined by `src/bridge/hook-server.ts` and `src/bridge/hook-runtime-routes.ts`.

Global rules:

- Bind address: `127.0.0.1:<port>`
- Auth: if hook token is configured, all routes except `GET /health` require `Authorization: Bearer <token>`
- Rate limit: token bucket (burst 60, refill 60/sec)
- Max request body: `256 * 1024` bytes
- Unknown POST route: `404 Not found`
- Non-GET/POST methods: `405 Method not allowed`

Endpoints:

| Method | Path | Request | Success | Error behavior |
| --- | --- | --- | --- | --- |
| GET | `/health` | none | `200 OK` + `OK` | n/a |
| GET | `/runtime/windows` | none | `200` JSON `{ protocolVersion, activeWindowId?, windows[] }` | `501` runtime unavailable |
| GET | `/runtime/buffer` | query: `windowId` (required), `since` (optional) | `200` JSON `{ protocolVersion, windowId, since, next, chunk }` | `400` missing `windowId`, `404` window not found, `501` runtime unavailable |
| POST | `/runtime/focus` | JSON `{ windowId }` | `200 OK` | `400` invalid/missing payload, `404` window not found, `501` runtime unavailable |
| POST | `/runtime/input` | JSON `{ windowId?, text?, submit? }` | `200 OK` | `400` invalid payload/no input, `404` window not found, `501` runtime unavailable |
| POST | `/runtime/stop` | JSON `{ windowId }` | `200 OK` | `400` invalid payload, `404` window not found, `501` runtime stop unavailable |
| POST | `/runtime/ensure` | JSON `{ projectName, instanceId?, permissionAllow? }` | `200 OK` | `400` invalid payload/project state, `404` project/instance/adapter not found, `501` runtime unavailable |

### Hook ingestion contract

| Method | Path | Request | Success | Error behavior |
| --- | --- | --- | --- | --- |
| POST | `/opencode-event` | JSON event envelope | `200 OK` | `400 Invalid JSON` or `400 Invalid event payload` |
| POST | `/send-files` | JSON `{ projectName, agentType?, instanceId?, files[] }` | `200 OK` | `400` invalid payload/no files/no valid files, `404` project/channel not found |
| POST | `/reload` | no body required | `200 OK` | n/a |

`/opencode-event` envelope minimum validation (`src/types/hook-contract.ts`):

- required: `type: string`, `projectName: string`
- optional: `agentType`, `instanceId`, `text`, `message`, `timestamp`, `turnId` (all string when present)

`/send-files` path validation (`src/bridge/hook-runtime-routes.ts`):

- file must exist
- `realpath(file)` must be inside `realpath(projectPath)`

### Runtime stream protocol contract

Transport (`src/runtime/stream-server.ts`):

- Unix/macOS: UDS `~/.discode/runtime.sock`
- Windows: named pipe `\\.\pipe\discode-runtime`
- Framing: line-delimited JSON (`\n`)

Handshake:

- Client sends: `{ "type": "hello", "version": 1 }`
- Server success: `{ "type": "hello", "ok": true, "streamProtocolVersion": 1 }`
- Version mismatch: `{ "type": "error", "code": "unsupported_protocol_version", ... }` then socket close

Inbound messages:

- `hello { version? }`
- `subscribe { windowId, cols?, rows? }`
- `focus { windowId }`
- `input { windowId, bytesBase64 }`
- `resize { windowId, cols, rows }`

Outbound messages:

- `hello`, `focus`, `input` acknowledgements
- `frame` / `patch` / `frame-styled` / `patch-styled`
- `window-exit`
- `error { code, message }`

Compatibility rules:

- Every outbound message includes `streamProtocolVersion`
- Unknown inbound message type returns `error.unknown_type`
- Invalid JSON returns `error.bad_json`

### Config/state compatibility behavior

Config loader (`src/config/index.ts`):

- file path: `~/.discode/config.json`
- precedence: stored config > environment > defaults
- unknown or invalid values are ignored (safe fallback)
- runtime mode is normalized to `tmux | pty-rust`; unsupported values fall back to `tmux`

State loader (`src/state/index.ts`, `src/state/instances.ts`):

- file path: `~/.discode/state.json`
- each project is normalized through `normalizeProjectState`
- supports legacy per-agent maps (`agents`, `discordChannels`, `tmuxWindows`, `eventHooks`)
- supports legacy instance field alias `discordChannelId` -> `channelId`
- `setProject` always persists normalized state

### Telemetry and logging compatibility policy

Telemetry payload contract (`src/telemetry/index.ts`):

- transport: HTTP POST JSON to configured telemetry endpoint
- top-level fields: `source`, `installId`, `version`, `platform`, `runtime`, `events[]`
- each event: `{ name, params }` after sanitization
- telemetry is best-effort and must never fail CLI/daemon flow

Logging policy for migration:

- keep existing textual log markers and route-level error semantics stable
- keep status code behavior stable for all daemon HTTP/stream contracts
- Rust daemon may add structured/internal logs, but must preserve externally visible behavior above

### Contract test suite (TS baseline)

Run:

```bash
npm run test:daemon-contract
```

Current suite anchors:

- `tests/e2e/event-lifecycle-errors.test.ts`
- `tests/bridge/hook-runtime-routes.test.ts`
- `tests/bridge/hook-runtime-routes-input.test.ts`
- `tests/bridge/hook-runtime-routes-ensure.test.ts`
- `tests/bridge/hook-runtime-routes-sendfiles.test.ts`
- `tests/runtime/control-plane.test.ts`
- `tests/runtime/stream-server.test.ts`
- `tests/types/hook-contract.test.ts`
- `tests/config/index.test.ts`
- `tests/state/state-compatibility.test.ts`

## B1 process model bootstrap (current implementation)

Rust daemon crate:

- `daemon-rs/Cargo.toml`
- `daemon-rs/src/main.rs`

Implemented command surface:

- `start`
- `stop`
- `status`
- `restart`
- `run` (foreground daemon runtime)

Process/singleton behavior:

- state dir defaults to `~/.discode` (or `DISCODE_STATE_DIR`)
- lock file: `daemon.lock` (exclusive lock during `run`)
- pid file: `daemon.pid`
- log file: `daemon.log` (append mode)

macOS sleep-prevention compatibility:

- `start` uses `caffeinate -ims` by default on macOS
- `--no-caffeinate` disables wrapper for debugging

## B2 config/state compatibility bootstrap (current implementation)

Compatibility module:

- `daemon-rs/src/compat.rs`

Config compatibility behavior (`CompatConfig`):

- loads `~/.discode/config.json` (or configured state dir) with TS-like fallback (`{}` when missing/invalid)
- keeps raw JSON fields intact for roundtrip safety
- provides TS-aligned runtime mode normalization (`pty-rust` else `tmux`)

State compatibility behavior (`CompatState`):

- loads `~/.discode/state.json` with TS-like fallback (`{}` then normalized to include `projects`)
- ports legacy instance normalization from TS:
  - derives `instances` from legacy maps when needed
  - supports `discordChannelId` -> `channelId` alias
  - re-derives legacy maps (`agents`, `discordChannels`, `tmuxWindows`, `eventHooks`) from normalized instances
- preserves unknown root/project/instance fields during normalization/write

Compatibility tests:

- `cargo test --manifest-path daemon-rs/Cargo.toml`
- includes migration/roundtrip tests in `daemon-rs/src/compat.rs` for:
  - legacy map -> instances normalization
  - legacy `discordChannelId` alias
  - config/state unknown-field roundtrip preservation

## B3 hook server and ingestion bootstrap (current implementation)

Hook server module:

- `daemon-rs/src/hook_server.rs`

Implemented HTTP behavior:

- loopback bind remains `127.0.0.1:<port>` (wired from `daemon-rs/src/main.rs`)
- request body hard limit: `256 * 1024` bytes (`413 Payload too large`)
- auth parity: when `~/.discode/.hook-token` exists, all routes except `GET /health` require `Authorization: Bearer <token>`
- rate limit parity: token bucket (burst 60, refill 60/sec)
- method/path parity:
  - `GET /health` -> `200 OK`
  - `POST /reload` -> `200 OK`
  - unknown `POST` route -> `404 Not found`
  - non-`GET`/`POST` -> `405 Method not allowed`

Hook ingestion behavior:

- `/opencode-event`:
  - validates envelope fields equivalent to TS minimal contract (`type`, `projectName`, optional string fields)
  - validates project exists and resolvable instance/channel context exists
  - returns `200 OK` on success, `400 Invalid event payload` on validation failure
- pending lifecycle state:
  - in-memory pending tracker with active + recently-completed windows
  - event-driven transitions for prompt/start/activity/end/error/idle/task-completed signals

File send behavior:

- `/send-files`:
  - validates payload (`projectName`, string `files[]`)
  - resolves project/instance/channel from normalized state
  - enforces project-root path scope using canonicalized paths
  - returns same key status/messages as TS baseline (`Missing projectName`, `No files provided`, `Project not found`, `No channel found for project/agent`, `No valid files`, `OK`)

Coverage:

- `cargo test --manifest-path daemon-rs/Cargo.toml`
- `daemon-rs/src/hook_server.rs` tests cover auth, rate-limit, malformed JSON, event validation, send-files path scope, pending lifecycle, and oversized payload handling

## B4 runtime control + stream bootstrap (current implementation)

Runtime control modules:

- `daemon-rs/src/runtime_control.rs`
- `daemon-rs/src/hook_server.rs`

Runtime stream module:

- `daemon-rs/src/runtime_stream.rs`

Implemented `/runtime/*` control behavior:

- `GET /runtime/windows`
  - returns `{ protocolVersion, activeWindowId, windows[] }` when runtime is available
  - returns `501` with `{"error":"Runtime control unavailable"}` when unavailable
- `GET /runtime/buffer`
  - enforces `windowId` requirement (`400` when missing)
  - returns `{ protocolVersion, windowId, since, next, chunk }`
  - maps missing/invalid window to `404`
- `POST /runtime/focus`
  - maps to runtime window focus with `200 OK` / `404 Window not found`
- `POST /runtime/input`
  - supports `windowId?`, `text?`, `submit?` with TS-like defaults
  - enforces missing-input and missing-window guards
- `POST /runtime/stop`
  - maps to runtime stop semantics with `200 OK` / `404 Window not found`

`pty-rust` adapter wiring:

- runtime control bridges directly to the Rust PTY sidecar RPC (`discode-pty-sidecar`) in `runtime_control.rs`
- daemon enables runtime control only when config `runtimeMode` is `pty-rust` (see `daemon-rs/src/main.rs`)

Runtime stream protocol behavior:

- socket path: `<state-dir>/runtime.sock` (default `~/.discode/runtime.sock`)
- line-delimited JSON with protocol version stamping (`streamProtocolVersion = 1`)
- supported inbound messages: `hello`, `subscribe`, `focus`, `input`, `resize`
- supported outbound messages: `hello`, `focus`, `input`, `frame-styled`, `window-exit`, `error`
- error codes implemented: `bad_json`, `bad_message`, `unsupported_protocol_version`, `bad_subscribe`, `bad_focus`, `bad_input`, `unknown_type`

Validation:

- `cargo test --manifest-path daemon-rs/Cargo.toml` (runtime control/stream unit coverage included)
- `npm run test:daemon-contract` (TS baseline contract suite remains green)
- `daemon-rs/src/runtime_stream.rs` includes stress tests for:
  - concurrent stream clients
  - rapid resize/input bursts

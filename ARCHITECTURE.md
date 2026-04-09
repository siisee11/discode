# Discode Architecture

Status: canonical top-level architecture map
Audience: contributors, maintainers, and agents changing runtime, daemon, messaging, or packaging behavior
Update when: entrypoints, domain boundaries, dependency direction, or operating model changes

## System Summary

Discode is a local-first bridge that runs AI agent CLIs on the developer machine and exposes them through Discord or Slack. The product is organized around one long-lived daemon, a Rust PTY runtime for interactive terminal sessions, messaging adapters, and packaging layers that ship both JavaScript and Rust components.

## Major Entrypoints

| Entrypoint | Role |
| --- | --- |
| `bin/discode.ts` | Primary CLI surface for onboarding, project lifecycle, config, daemon control, and TUI launch |
| `src/daemon-entry.ts` | Daemon process bootstrap |
| `src/index.ts` | `AgentBridge` composition root for daemon subsystems |
| `site/index.html` | Landing page and release-facing marketing surface |
| `workers/telemetry-proxy/src` | Telemetry collection worker deployed separately |
| `daemon-rs/src/main.rs` | Rust daemon implementation and compatibility path |
| `sidecar/pty-rust/src` | Rust PTY runtime sidecar |
| `runtime-client-rs/src` | Native runtime attach client packaging target |

## Domain Map

### CLI and UX surface

- `bin/discode.ts`
- `src/cli/**`
- `runtime-client-rs/**`

Responsibilities:

- parse user commands
- orchestrate onboarding, project lifecycle, daemon lifecycle, and config changes
- attach local users to active sessions through the native Rust client

### Daemon orchestration

- `src/daemon-entry.ts`
- `src/index.ts`
- `src/bridge/**`

Responsibilities:

- own the singleton bridge process
- bootstrap saved projects and mappings
- route messages between chat platforms and runtime sessions
- expose hook, control, and stream planes

### Messaging integrations

- `src/discord/**`
- `src/slack/**`
- `src/messaging/**`

Responsibilities:

- connect to Discord or Slack
- map remote channels to local project instances
- send chunked text, reactions, and files back to chat

### Runtime control

- `src/runtime/**`
- `src/tmux/**`
- `sidecar/pty-rust/**`
- `runtime-client-rs/**`

Responsibilities:

- manage the Rust PTY runtime, native attach client, and compatibility state
- manage window lifecycle, input, resize, output buffering, and stream rendering
- keep transport contracts stable across TypeScript and Rust implementations

### Agent integrations

- `src/agents/**`
- `src/claude/**`
- `src/gemini/**`
- `src/opencode/**`
- `src/policy/**`

Responsibilities:

- detect installed agent CLIs
- install hooks/plugins
- define agent launch behavior, naming, and submit timing

### State, config, and infrastructure

- `src/state/**`
- `src/config/**`
- `src/infra/**`
- `src/types/**`

Responsibilities:

- persist global and per-project configuration in `~/.discode`
- normalize compatibility state
- wrap filesystem, shell, environment, and download concerns behind testable interfaces

### Packaging and distribution

- `scripts/**`
- `dist/release/**`
- `package.json`
- `site/**`

Responsibilities:

- build npm packages and platform binaries
- produce GitHub release artifacts
- publish landing page updates alongside releases

## Dependency Direction

Preferred dependency flow:

1. CLI surfaces depend on config/state/policy/runtime interfaces, not messaging internals.
2. Daemon orchestration depends on bridge, messaging, runtime, state, telemetry, and policy modules.
3. Messaging adapters depend on shared messaging interfaces and platform SDKs, not CLI code.
4. Runtime adapters depend on runtime contracts plus Rust sidecar/native client implementations.
5. Policies and adapters can depend on infrastructure helpers; infrastructure must not depend on product flows.
6. Site and release tooling stay separate from daemon/runtime code.

Detailed module-boundary rules live in [`docs/MODULE_BOUNDARIES.md`](docs/MODULE_BOUNDARIES.md) and [`docs/design-docs/index.md`](docs/design-docs/index.md).

## Runtime and Process Model

- The default process model is a global daemon plus one or more local agent sessions.
- Rust daemon (`daemon-rs`) is the canonical daemon backend in the shipped startup path.
- The shipped runtime is `pty-rust`; CLI/runtime mode parsing only accepts `pty-rust`.
- The daemon exposes loopback HTTP endpoints for hooks and runtime control, plus a local stream socket for terminal frames.
- Rust runtime stream/native attach transport is currently targeted at macOS/Linux; Windows named-pipe parity remains a tracked follow-up.
- Rust components are first-class production components: PTY sidecar, native runtime client, and Rust daemon.

## Canonical Topic Guides

- Setup/bootstrap entrypoint: [`docs/operations/bootstrap.md`](docs/operations/bootstrap.md)
- Design rationale: [`docs/DESIGN.md`](docs/DESIGN.md)
- Product behavior: [`docs/PRODUCT_SENSE.md`](docs/PRODUCT_SENSE.md)
- Reliability and operations: [`docs/RELIABILITY.md`](docs/RELIABILITY.md)
- Security model: [`docs/SECURITY.md`](docs/SECURITY.md)
- Checked-in execution plans: [`docs/PLANS.md`](docs/PLANS.md)
- Low-level contracts and references: [`docs/references/index.md`](docs/references/index.md)

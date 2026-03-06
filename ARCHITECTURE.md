# Discode Architecture

This is the top-level architecture map for the repository.
It is the canonical entrypoint for system domains, package boundaries, dependency direction, and major entrypoints.

## System Boundary

Discode is a local-first bridge for running agent CLIs in local runtime sessions and relaying control/output through Discord or Slack.

Core responsibilities:

- CLI lifecycle and operator workflows
- Global daemon orchestration
- Messaging ingress and egress
- Runtime control for `tmux` and `pty-rust`
- User-facing TUI and landing/docs site
- Release packaging for npm and native helper binaries

## Repository Domains

| Domain | Paths | Responsibility |
| --- | --- | --- |
| CLI and TUI entrypoints | `bin/` | User commands and interactive terminal UI |
| TypeScript application core | `src/` | Daemon, routing, runtime abstractions, config, state, integrations |
| Rust daemon | `daemon-rs/` | Native daemon implementation and packaging work |
| Rust runtime sidecar | `sidecar/pty-rust/` | PTY sidecar used by `pty-rust` runtime mode |
| Rust runtime client | `runtime-client-rs/` | Client binary for runtime transport and packaging |
| Web and docs site | `site/` | Landing page and published documentation site |
| Telemetry worker | `workers/telemetry-proxy/` | Cloudflare Worker for telemetry ingestion |
| Tests | `tests/` | Unit, integration, and targeted e2e coverage |
| Maintainer docs | `docs/` | Product specs, design docs, plans, runbooks, references |

## Package Boundaries

- `bin/discode.ts` is the CLI entrypoint.
- `bin/tui.tsx` is the interactive terminal UI entrypoint.
- `src/cli/**` handles command parsing and user-facing command flows.
- `src/app/**` holds shared application orchestration.
- `src/bridge/**` owns daemon runtime coordination, hook ingress, routing, and pending delivery.
- `src/runtime/**` defines runtime interfaces, control plane, and stream server behavior.
- `src/{discord,slack,messaging}/**` own platform transport concerns.
- `src/{config,state,policy,infra}/**` hold configuration, persisted state, shared policy, and low-level infrastructure utilities.

Detailed dependency rules live in [docs/MODULE_BOUNDARIES.md](/Users/dev/git/discode/docs/MODULE_BOUNDARIES.md).

## Dependency Direction

Primary TypeScript flow:

`bin/discode.ts` -> `src/cli/**` -> `src/app/**` -> `src/{bridge,runtime,state,config,policy,infra,messaging,...}`

Operational constraints:

- CLI modules should not be imported by lower layers.
- Shared rules belong in `src/policy/**`, not duplicated in command or daemon code.
- Side-effecting integrations stay in app, bridge, runtime, messaging, or infra layers.
- Rust components should depend on stable contracts and integration behavior, not ad hoc CLI assumptions.

## Major Entrypoints

- CLI:
  `bin/discode.ts`
- TUI:
  `bin/tui.tsx`
- Daemon bootstrap:
  `src/daemon-entry.ts`
- Daemon composition root:
  `src/index.ts`
- Runtime interface:
  `src/runtime/interface.ts`
- Landing page:
  `site/index.html`
- Site deployment:
  `npm run pages:deploy`

## High-Value Runtime Paths

- Messaging -> agent routing:
  `src/bridge/message-router.ts`
- Hook ingress and control plane:
  `src/bridge/hook-server.ts`
- Runtime control and stream transport:
  `src/runtime/control-plane.ts`
  `src/runtime/stream-server.ts`
- Project bootstrap and recovery:
  `src/bridge/project-bootstrap.ts`
- Persisted state:
  `src/state/`
- Config loading:
  `src/config/`

## Canonical Supporting Docs

- Design rationale:
  [docs/design-docs/index.md](/Users/dev/git/discode/docs/design-docs/index.md)
- Product behavior:
  [docs/product-specs/index.md](/Users/dev/git/discode/docs/product-specs/index.md)
- Planning and execution:
  [docs/PLANS.md](/Users/dev/git/discode/docs/PLANS.md)
- Reliability and daemon operations:
  [docs/RELIABILITY.md](/Users/dev/git/discode/docs/RELIABILITY.md)
  [docs/references/daemon-operations.md](/Users/dev/git/discode/docs/references/daemon-operations.md)
- Security:
  [docs/SECURITY.md](/Users/dev/git/discode/docs/SECURITY.md)

## Update Triggers

Update this file when any of the following change:

- Top-level package boundaries
- Dependency direction or layering rules
- Runtime mode ownership or entrypoints
- Major daemon, CLI, TUI, or site entrypoints

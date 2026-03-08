# Worktree Harness

Status: active
Verified against code: 2026-03-08
Canonical for: worktree-scoped browser harness design, observability integration, and launch contract
Update when: the harness boot flow, observability stack, or agent validation workflow changes

## Scope

This document explains the local harness that boots the Vite-served `site/` surface per Git worktree and optionally attaches a per-worktree observability stack.

## Design

- Worktree identity is derived from the current Git worktree path and normalized into a stable `worktree_id`.
- Runtime state lives under `.worktree/<worktree_id>/` so logs, cache, browser profile data, metadata, and observability files do not collide across worktrees.
- Ports are allocated from a deterministic worktree-derived block and persisted in `.worktree/<worktree_id>/ports.env`.
- The browser-facing app is started through [`../../scripts/harness/dev-server.mjs`](../../scripts/harness/dev-server.mjs), not by sleeping on top of `vite`.
- Readiness comes from `GET /__harness/health`, which the harness polls before returning metadata.

## Launch Contract

`harnesscli boot` is the automation entrypoint. The Rust CLI lives under [`../../harness/Cargo.toml`](../../harness/Cargo.toml) and owns the worktree boot contract directly. The command returns JSON containing:

- `worktree_id`
- `app_url`
- `healthcheck_url`
- `port`
- `pid`
- `runtime_root`
- `log_file`
- `browser_profile_dir`

The command is idempotent for a live worktree instance: if the current worktree app is already healthy, it returns the existing metadata instead of starting a second copy.

For fully automated agent runs, [`../../scripts/harness/init.sh`](../../scripts/harness/init.sh) creates or reuses an isolated Git worktree, stashes local dirt if needed, verifies `make smoke`, and returns JSON metadata for the selected worktree runtime root.

## Observability

- `harnesscli observability start` starts a Docker-backed Vector + Victoria stack inside the current worktree runtime area.
- `harnesscli boot` wires the app to that stack when `DISCODE_OBSERVABILITY=1`.
- Logs are posted to Vector over HTTP, while traces and metrics are emitted from the harness dev server through OpenTelemetry OTLP/HTTP exporters.

## Ralph Loop

- [`../../scripts/ralph-loop/ralph-loop.mts`](../../scripts/ralph-loop/ralph-loop.mts) is the automated agent driver.
- It relies on `scripts/harness/init.sh` for worktree preparation, uses Codex app-server over stdio JSON-RPC, and keeps the execution plan in `docs/exec-plans/active/` as the shared state across setup, coding, and PR phases.
- The loop keeps one coding thread alive across iterations and only stops when the agent emits `<promise>COMPLETE</promise>`.

## Tradeoffs

- The harness targets the browser-facing `site/` app because that is the repo surface `agent-browser` can inspect directly.
- Observability is opt-in because it depends on Docker and external images; the plain app boot flow stays lightweight.
- The Vite dev server is launched programmatically so the harness owns health checks, telemetry, and metadata emission in one place.

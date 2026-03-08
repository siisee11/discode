# Harness Runbook

Canonical for: launching, stopping, and validating the local worktree harness
Audience: contributors and agents reproducing or validating browser-facing changes
Update when: harness scripts, environment variables, or troubleshooting steps change

## Commands

- Boot the current worktree app: `./scripts/harness/boot.sh`
- Stop the current worktree app: `./scripts/harness/stop-app.sh`
- Print the example validation flow: `./scripts/harness/example-validation.sh`
- Start observability for the current worktree: `./scripts/observability/start.sh`
- Stop observability for the current worktree: `./scripts/observability/stop.sh`
- Query logs, metrics, or traces: `./scripts/observability/query.sh <logs|metrics|traces> '<query>'`

## Environment

- `DISCODE_WORKTREE_ID`: override the derived worktree identifier
- `DISCODE_APP_HOST`: bind host for the harness app. Default: `127.0.0.1`
- `DISCODE_APP_BOOT_TIMEOUT_SECONDS`: readiness timeout for `boot.sh`. Default: `30`
- `DISCODE_OBSERVABILITY=1`: start and wire the local observability stack during boot
- `DISCODE_PORT_BASE`: override the deterministic port block
- `DISCODE_VECTOR_IMAGE`, `DISCODE_VLOGS_IMAGE`, `DISCODE_VMETRICS_IMAGE`, `DISCODE_VTRACES_IMAGE`: override container images for observability

## Flow

1. Run `./scripts/harness/boot.sh` from the target worktree.
2. Read the returned JSON for the `app_url`, `healthcheck_url`, and `browser_profile_dir`.
3. Use `agent-browser` against `app_url`.
4. Re-run `./scripts/harness/boot.sh` after a code change to confirm the same worktree instance is still healthy, or stop and boot again if needed.

## Agent-Browser Example

Use the output from `./scripts/harness/example-validation.sh` as the concrete prompt. The default flow validates:

- hero heading render
- install tab switching
- Korean language toggle
- screenshot capture for the hero and install card

## Troubleshooting

- If boot fails, inspect the `log_file` returned by `boot.sh`.
- If the healthcheck never turns green, remove the stale process with `./scripts/harness/stop-app.sh` and retry.
- If observability fails, verify Docker is running and then start it separately with `./scripts/observability/start.sh`.
- If a deterministic port block is occupied by another process, set `DISCODE_PORT_BASE` explicitly for this worktree and retry.

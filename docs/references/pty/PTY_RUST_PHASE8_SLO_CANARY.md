# PTY Rust Phase 8 - SLOs and Canary Rollout Gates

Canonical for: PTY Rust rollout SLOs, promotion gates, rollback criteria, and canary monitoring policy
Audience: contributors operating or auditing PTY Rust rollout safety
Status: historical rollout gate
Update when: rollout policy changes or a newer production policy supersedes this gate document

Last updated: 2026-03-03

This document defines Phase 8 operational gates for promoting `pty-rust` from canary to full rollout.

## 1) SLO Definitions

SLO window: rolling 24 hours per rollout cohort.

- `startup_success_rate` >= `99.0%`
  - Definition: `pty_rust_runtime_startup.success == 1` / total `pty_rust_runtime_startup` events.
- `runtime_rpc_error_rate` <= `1.0%`
  - Definition: `rpc_errors_total / max(rpc_requests_total, 1)` from startup health snapshot.
- `input_rtt_p95_ms` <= `150ms`
  - Source: runtime regression benchmark + canary sampled telemetry.
- `frame_mismatch_rate` <= `0.5%`
  - Definition: stream fallback/recovery frames divided by emitted frames in canary sessions.
- `sidecar_cpu_budget` <= `1.0` core p95 and `sidecar_mem_budget_mb` <= `300` MB p95.

## 2) Telemetry Signals

Phase 8 requires these events:

- `cli_command_run`
- `pty_rust_runtime_startup`
  - `success`, `strategy`, `startup_duration_ms`, `startup_attempts`, `startup_reason`
  - `health_ok`, `health_uptime_ms`, `health_windows`, `health_running_windows`
  - `rpc_requests_total`, `rpc_errors_total`

Event transport: `src/telemetry/index.ts` -> telemetry proxy worker -> GA4.

## 3) Rollout Gates

Progression is strictly gated:

1. `10%` cohort for at least 24h
2. `50%` cohort for at least 24h after 10% gate pass
3. `100%` cohort after 50% gate pass

Promotion criteria for each step:

- All SLOs meet target in the full window.
- No Sev1/Sev2 incident attributable to `pty-rust` runtime.
- Runtime regression suite stays green:
  - `npm run test:runtime:pty-rust`
  - `.github/workflows/pty-rust-unix.yml` (macOS + Linux)

Rollback criteria:

- Any SLO breach for >= 30 minutes.
- Reproducible crash loop or startup failure spike.
- Unrecoverable frame/input regressions in interactive CLIs.

## 4) Emergency Switch Policy

Production emergency switch is limited to runtime mode only:

- `tmux`
- `pty-rust`

No legacy runtime aliases are supported in production; only `tmux` and `pty-rust` are valid modes.

## 5) Monitoring Window

After reaching `100%`, monitor one full release cycle before Phase 8 closure:

- No sustained SLO breach
- No elevated incident rate
- No increase in rollback-triggering errors

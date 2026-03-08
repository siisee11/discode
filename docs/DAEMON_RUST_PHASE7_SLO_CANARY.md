# Daemon Rust Phase 7 - SLOs and Canary Rollout Gates

Canonical for: historical daemon rollout gate evidence
Audience: contributors auditing migration history
Status: historical rollout gate
Update when: historical context needs correction

Last updated: 2026-03-04

This document defines Phase 7 operational gates for promoting the Rust daemon from opt-in to default.

Historical note:

- rollout controls in section 4 were removed after Phase 8 migration closure (`src/app/daemon-service.ts` now runs Rust daemon path directly)
- do not treat section 4 controls as current production toggles

## 1) SLO Definitions

SLO window: rolling 24 hours per rollout cohort.

- `daemon_crash_free_uptime_rate` >= `99.9%`
  - Definition: healthy status samples (`discode daemon status` returns running Rust daemon) / total scheduled samples.
- `hook_request_latency_p95_ms` <= `150ms`
  - Scope: `/opencode-event`, `/send-files`, `/reload` successful requests.
- `runtime_api_latency_p95_ms` <= `200ms`
  - Scope: `/runtime/windows`, `/runtime/buffer`, `/runtime/focus`, `/runtime/input`, `/runtime/stop`, `/runtime/ensure`.
- `hook_5xx_rate` <= `0.5%`
  - Definition: HTTP 5xx responses / total hook endpoint requests.
- `runtime_api_error_rate` <= `1.0%`
  - Definition: non-2xx runtime API responses excluding expected user errors (`400`, `404`) / total runtime API requests.

## 2) Telemetry and Measurement Sources

- daemon logs (`~/.discode/daemon.log`) for request timing/error sampling
- control-plane probes via existing contract tests and canary synthetic checks
- runtime stream/control smoke checks for endpoint availability

All telemetry collection remains best-effort and must not block daemon request handling.

## 3) Rollout Gates

Progression is strictly gated:

1. `10%` cohort for at least 24h
2. `50%` cohort for at least 24h after 10% gate pass
3. `100%` cohort after 50% gate pass

Promotion criteria for each step:

- all SLOs meet target for the full window
- no Sev1/Sev2 incident attributable to Rust daemon behavior
- parity suites remain green:
  - `npm run test:daemon-contract`
  - `cargo test --manifest-path daemon-rs/Cargo.toml`

Rollback criteria:

- any SLO breach sustained for >= 30 minutes
- repeated Rust daemon crash loop or hook server unavailability
- runtime API regression that blocks message routing or delivery

## 4) Rollout Controls (implemented)

Daemon backend selection controls:

- explicit override:
  - `DISCODE_DAEMON_BACKEND=rust|ts`
- staged rollout percentage:
  - `DISCODE_DAEMON_RUST_ROLLOUT_PERCENT=0..100`
- deterministic cohort key override (for staged cohorts/canary buckets):
  - `DISCODE_DAEMON_CANARY_KEY=<stable-key>`

Default policy after B7 flip:

- default backend is Rust daemon (equivalent to `DISCODE_DAEMON_RUST_ROLLOUT_PERCENT=100` when no override is set)
- Rust boot failure auto-falls back to TS daemon to protect CLI availability

## 5) Emergency Rollback Policy

During the transition release cycle, emergency rollback remains:

- `DISCODE_DAEMON_BACKEND=ts`

Rust remains selectable with:

- `DISCODE_DAEMON_BACKEND=rust`

## 6) Monitoring Window

After reaching `100%`, monitor one full release cycle before Phase 7 closure:

- no sustained SLO breach
- no elevated incident rate versus TS baseline
- no rollback-triggering regressions in hook/runtime flows

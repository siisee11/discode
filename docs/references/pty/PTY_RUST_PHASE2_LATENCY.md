# PTY Rust Phase 2 Tail-Latency Report

Canonical for: the recorded Phase 2 latency gate comparing per-request sidecar RPC versus the persistent bridge path
Audience: contributors validating PTY Rust migration performance gates
Status: historical benchmark record
Update when: the benchmark methodology changes or a newer benchmark supersedes this report

This report closes Phase 2 exit criteria: request tail latency is improved versus the old request-per-process PoC path.

## Benchmark method

- Baseline: sidecar `request` command (`spawnSync` per RPC call)
- Candidate: sidecar `client` command (persistent bridge connection)
- RPC method: `health`
- Tooling: `npm run sidecar:bench -- --iterations 250 --warmup 25`

## Latest run

- Date: 2026-03-02
- Host: local macOS dev environment
- Binary: `sidecar/pty-rust/target/release/discode-pty-sidecar`

Results:

- request-per-process p95: `3.347ms`
- persistent-bridge p95: `0.076ms`
- p95 delta: `3.272ms` (`97.7%` improvement)
- gate (`bridge p95 < request p95`): `PASS`

Raw JSON excerpt:

```json
{
  "iterations": 250,
  "warmup": 25,
  "baselineRequestMode": {
    "p95": 3.347208,
    "p99": 6.087666
  },
  "persistentBridgeMode": {
    "p95": 0.075583,
    "p99": 0.111
  },
  "p95ImprovementPercent": 97.74190907765517,
  "pass": true
}
```

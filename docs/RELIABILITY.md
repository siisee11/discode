# Reliability Map

Canonical for: runtime reliability expectations, operational checks, and failure-oriented references
Audience: contributors touching daemon lifecycle, runtime control, stream delivery, or release operations
Update when: SLOs, recovery guidance, or operational responsibilities change

Start here for reliability topics:

- Architecture and process model: [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- Operational procedures: [`operations/index.md`](operations/index.md)
- Runtime diagnostics: [`PTY_RUNTIME_DIAGNOSTICS.md`](PTY_RUNTIME_DIAGNOSTICS.md)
- PTY Rust SLO gates: [`PTY_RUST_PHASE8_SLO_CANARY.md`](PTY_RUST_PHASE8_SLO_CANARY.md)
- Rust daemon SLO gates: [`DAEMON_RUST_PHASE7_SLO_CANARY.md`](DAEMON_RUST_PHASE7_SLO_CANARY.md)
- Runtime window contract: [`RUNTIME_WINDOW_API.md`](RUNTIME_WINDOW_API.md)

Reliability facts that should stay true:

- daemon control and runtime APIs are treated as compatibility surfaces
- daemon restarts matter after bridge/runtime/import-path changes
- release operations must include web and package updates when applicable

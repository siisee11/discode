# Observability Map

Canonical for: where to look when diagnosing daemon, runtime, and message-delivery behavior
Audience: contributors debugging bridge behavior, stream delivery, hooks, or release regressions
Update when: log surfaces, metrics paths, or primary diagnostics workflows change

Start here for observability topics:

- Runtime diagnostics: [`PTY_RUNTIME_DIAGNOSTICS.md`](PTY_RUNTIME_DIAGNOSTICS.md)
- Reliability and operating checks: [`RELIABILITY.md`](RELIABILITY.md)
- Architecture and process ownership: [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- Operations guides: [`operations/index.md`](operations/index.md)
- Runtime contracts and references: [`references/index.md`](references/index.md)

Current repo-level observability facts:

- daemon, hook, and runtime behavior is primarily diagnosed through local logs and targeted regression tests
- runtime stream and control-plane compatibility are treated as observable contracts, not incidental implementation details
- release and runtime incidents should be traced through the canonical operational docs instead of ad hoc notes

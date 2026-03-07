# Design Docs Index

Canonical for: locating design rationale and decision records
Audience: contributors and agents making architectural or cross-cutting changes
Update when: a design doc is added, replaced, or materially re-scoped

| Document | Status | Verified against code | Canonical for | Update when |
| --- | --- | --- | --- | --- |
| [`core-beliefs.md`](core-beliefs.md) | active | 2026-03-07 | project principles and decision defaults | principles or product posture change |
| [`../MODULE_BOUNDARIES.md`](../MODULE_BOUNDARIES.md) | active | 2026-03-07 | dependency direction and module ownership | package or import boundaries change |
| [`../PTY_RUST_ARCHITECTURE_CONTRACT.md`](../PTY_RUST_ARCHITECTURE_CONTRACT.md) | active | 2026-03-07 | PTY Rust replacement architecture | sidecar architecture changes |
| [`../PTY_RUST_QUERY_POLICY.md`](../PTY_RUST_QUERY_POLICY.md) | active | 2026-03-07 | supported PTY query semantics | terminal query behavior changes |
| [`../llm-cli-hooks-comparison.md`](../llm-cli-hooks-comparison.md) | reference | needs periodic review | hook-system landscape and tradeoffs | supported agent hook model changes |
| [`../slack-hook-message-flow.md`](../slack-hook-message-flow.md) | reference | needs periodic review | Slack-specific hook message path | Slack delivery path changes |

Design-doc expectations:

- include scope, status, and replacement/supersession notes when relevant
- link to the code paths constrained by the document
- prefer one decision per document over accumulating unrelated rationale

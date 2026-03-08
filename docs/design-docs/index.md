# Design Docs Index

Canonical for: locating design rationale and decision records
Audience: contributors and agents making architectural or cross-cutting changes
Update when: a design doc is added, replaced, or materially re-scoped

| Document | Status | Verified against code | Canonical for | Update when |
| --- | --- | --- | --- | --- |
| [`core-beliefs.md`](core-beliefs.md) | active | 2026-03-07 | project principles and decision defaults | principles or product posture change |
| [`worktree-harness.md`](worktree-harness.md) | active | 2026-03-08 | worktree boot contract, browser harness design, and observability integration | harness scripts, launch contract, or observability flow change |
| [`../MODULE_BOUNDARIES.md`](../MODULE_BOUNDARIES.md) | active | 2026-03-07 | dependency direction and module ownership | package or import boundaries change |
| [`../references/PTY_RUST_ARCHITECTURE_CONTRACT.md`](../references/PTY_RUST_ARCHITECTURE_CONTRACT.md) | active | 2026-03-07 | PTY Rust replacement architecture | sidecar architecture changes |
| [`../references/pty/PTY_RUST_QUERY_POLICY.md`](../references/pty/PTY_RUST_QUERY_POLICY.md) | active | 2026-03-07 | supported PTY query semantics | terminal query behavior changes |
| [`../references/llm-cli-hooks-comparison.md`](../references/llm-cli-hooks-comparison.md) | reference | needs periodic review | hook-system landscape and tradeoffs | supported agent hook model changes |
| [`../references/slack-hook-message-flow.md`](../references/slack-hook-message-flow.md) | reference | needs periodic review | Slack-specific hook message path | Slack delivery path changes |

Design-doc expectations:

- include scope, status, and replacement/supersession notes when relevant
- link to the code paths constrained by the document
- prefer one decision per document over accumulating unrelated rationale

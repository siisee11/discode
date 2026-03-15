# Design Docs Map

Canonical for: design rationale, architectural principles, and major technical decisions
Audience: contributors changing architecture, runtime behavior, integrations, or long-lived interfaces
Update when: a decision, tradeoff, or module boundary changes

Start with [`design-docs/index.md`](design-docs/index.md), then open only the relevant design note.

Current canonical design documents:

- ADR policy and decision history: [`decisions/index.md`](decisions/index.md)
- Core product and engineering beliefs: [`design-docs/core-beliefs.md`](design-docs/core-beliefs.md)
- Module dependency rules: [`MODULE_BOUNDARIES.md`](MODULE_BOUNDARIES.md)
- PTY Rust architecture contract: [`references/PTY_RUST_ARCHITECTURE_CONTRACT.md`](references/PTY_RUST_ARCHITECTURE_CONTRACT.md)
- PTY query-response policy: [`references/pty/PTY_RUST_QUERY_POLICY.md`](references/pty/PTY_RUST_QUERY_POLICY.md)
- Hook ecosystem comparison: [`references/llm-cli-hooks-comparison.md`](references/llm-cli-hooks-comparison.md)
- Slack hook delivery flow: [`references/slack-hook-message-flow.md`](references/slack-hook-message-flow.md)

Design-doc maintenance rules:

- every design doc should state its scope and status
- decision docs should link to the code paths they constrain
- when a design doc is superseded, mark it clearly and point to the replacement

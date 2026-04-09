# Product Sense Map

Canonical for: what the product is trying to do, for whom, and how the major features fit together
Audience: contributors changing user-facing behavior, defaults, onboarding, or release positioning
Update when: user workflows, positioning, or feature semantics change

Discode's current product shape:

- local-first remote control for AI coding agents
- chat-driven collaboration through Discord or Slack
- persistent local sessions managed by a single daemon
- Rust-only local runtime (`pty-rust`) with the Rust native attach client as the only local terminal UI

Feature-level specs live in [`product-specs/index.md`](product-specs/index.md).

Use product specs for:

- onboarding behavior
- session lifecycle expectations
- messaging and attach flows
- agent and platform support boundaries

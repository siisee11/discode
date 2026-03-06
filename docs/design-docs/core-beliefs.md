# Core Beliefs

Status: `active`
Verification: `verified` against the repository structure on 2026-03-06

## Product And System Beliefs

- Discode should stay local-first and operationally simple.
- The daemon is a coordination layer, not a hidden execution platform.
- Runtime integrations should remain explicit and inspectable.
- Discord and Slack are remote control surfaces, not replacements for the local terminal.
- Operators should be able to understand how messages, files, and runtime state move through the system.

## Documentation Beliefs

- `AGENTS.md` is a navigation file, not a manual.
- Canonical guidance should live in focused documents with clear ownership and update triggers.
- Small indexed docs are easier to keep fresh than one large instruction dump.
- Plans and technical debt should be checked into the repository when they materially affect ongoing work.

## Engineering Beliefs

- Package boundaries and dependency direction should remain visible and defendable.
- Reliability guidance should follow the actual daemon/runtime loading model.
- Release instructions should reflect the real packaging flow, not an idealized one.
- Legacy docs can stay in place temporarily, but they should be indexed and marked by freshness.

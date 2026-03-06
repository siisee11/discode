# Design Docs Index

This index tracks design rationale and major decision documents.

Status vocabulary:

- `active`: current design direction
- `historical`: useful background, not current source of truth
- `needs-verification`: content exists but must be checked against current code before reuse

Verification vocabulary:

- `verified`: reviewed against the current repository shape
- `partial`: still useful, but some sections may be stale
- `unverified`: legacy content that needs a fresh review

## Canonical Docs In This Section

| Doc | Status | Verification | Audience | When to update |
| --- | --- | --- | --- | --- |
| [core-beliefs.md](/Users/dev/git/discode/docs/design-docs/core-beliefs.md) | active | verified | Maintainers and contributors | When product or architecture philosophy changes |

## Legacy Design And Migration Backlog

These docs still hold useful design context but remain in legacy flat locations for now.
Migrate them into `docs/design-docs/` when they next need substantive updates.

| Doc | Current location | Status | Verification |
| --- | --- | --- | --- |
| Daemon Rust migration | [DAEMON_RUST_MIGRATION.md](/Users/dev/git/discode/docs/DAEMON_RUST_MIGRATION.md) | historical | partial |
| PTY sidecar PoC | [PTY_RUST_SIDECAR_POC.md](/Users/dev/git/discode/docs/PTY_RUST_SIDECAR_POC.md) | historical | partial |
| Native attach implementation plan | [NATIVE_ATTACH_IMPLEMENTATION_PLAN.md](/Users/dev/git/discode/docs/NATIVE_ATTACH_IMPLEMENTATION_PLAN.md) | needs-verification | unverified |
| Runtime diagnostics | [PTY_RUNTIME_DIAGNOSTICS.md](/Users/dev/git/discode/docs/PTY_RUNTIME_DIAGNOSTICS.md) | needs-verification | partial |
| Runtime contracts | [PTY_RUST_ARCHITECTURE_CONTRACT.md](/Users/dev/git/discode/docs/PTY_RUST_ARCHITECTURE_CONTRACT.md) | active | partial |

Update this index when:

- A decision doc is added, migrated, superseded, or removed
- Verification status changes after a code review pass

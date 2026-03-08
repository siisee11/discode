# PTY Rust Replacement Plan

Canonical for: completing PTY/runtime and Rust-daemon replacement exit criteria with compatibility-first rollout discipline  
Audience: contributors working on runtime, daemon, compatibility tests, and rollout readiness  
Update when: milestone status changes, scope shifts, or rollout gates change

## Goal / scope

Finish the remaining `pty-rust` and Rust-daemon replacement work so production behavior is fully compatible with current CLI/control-plane contracts and documented as the canonical default path.

In scope:

- close remaining parity gaps called out by active migration references
- validate compatibility against real-world fixtures for config/state/hook/runtime contracts
- complete stability-gate and rollout-readiness checks
- update canonical docs to reflect shipped replacement posture

Out of scope:

- new product features unrelated to replacement parity
- changing public runtime/control contracts beyond compatibility-preserving fixes

## Background

- `ARCHITECTURE.md` defines `pty-rust` as the PTY runtime backend and `daemon-rs` as the Rust daemon path.
- `docs/exec-plans/active/README.md` identifies this as active migration work with remaining rollout and compatibility checks.
- `docs/references/PTY_RUST_ARCHITECTURE_CONTRACT.md` defines target sidecar boundaries and migration guardrails.
- `docs/references/DAEMON_RUST_MIGRATION.md` documents frozen daemon contracts and remaining parity expectations.
- `docs/references/pty/PTY_RUST_PHASE8_SLO_CANARY.md` defines operational promotion gates that must stay green.

## Milestones

1. [ ] Contract and gap-baseline pass (status: not started): produce an implementation checklist of unresolved parity items across runtime control, stream protocol, hook routes, and compatibility loading.
2. [ ] Rust daemon endpoint parity pass (status: not started): close any remaining `/runtime/*`, hook-route, and stream error/shape mismatches and add focused contract tests.
3. [ ] Compatibility fixture pass (status: not started): assemble and validate representative config/state/project fixtures (including legacy aliases/maps) against Rust compatibility loaders and persistence behavior.
4. [ ] PTY/runtime reliability pass (status: not started): run and fix targeted PTY runtime and stream stress checks required by SLO/canary references.
5. [ ] Rollout evidence and docs sync pass (status: not started): update canonical architecture/reliability/operations docs and execution-plan evidence so replacement status is auditable and ready to move to completed.

## Current progress

- Plan reset created for this coding loop.
- All milestones are not started.
- No implementation work has been executed under this refreshed plan yet.

## Key decisions

- Keep replacement work compatibility-first: preserve existing CLI, runtime-control, and stream contracts while closing gaps.
- Use boundary-validation and contract tests as the source of truth for parity signoff.
- Defer non-replacement enhancements until after migration completion criteria are met.
- Treat documentation and rollout evidence as required deliverables, not optional follow-up.

## Remaining issues / open questions

- Which real-world fixture corpus should be treated as the minimum acceptance set for config/state compatibility signoff?
- Are any daemon endpoint differences intentionally retained, or should all remaining mismatches be treated as defects?
- What exact threshold/time window from canary references will be used to declare final migration completion?

## Links to related documents

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [docs/PLANS.md](../../PLANS.md)
- [docs/exec-plans/active/README.md](./README.md)
- [docs/references/PTY_RUST_ARCHITECTURE_CONTRACT.md](../../references/PTY_RUST_ARCHITECTURE_CONTRACT.md)
- [docs/references/DAEMON_RUST_MIGRATION.md](../../references/DAEMON_RUST_MIGRATION.md)
- [docs/references/pty/PTY_RUST_PHASE8_SLO_CANARY.md](../../references/pty/PTY_RUST_PHASE8_SLO_CANARY.md)
- [docs/RELIABILITY.md](../../RELIABILITY.md)

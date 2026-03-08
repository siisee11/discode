# Native Attach Plan

Canonical for: delivering native terminal attach as the primary `runtimeMode=pty-rust` local interaction path  
Audience: contributors working on runtime stream contracts, native client UX, and attach CLI routing  
Update when: milestone status changes, scope shifts, or rollout decisions change

## Goal and Scope

Ship a production-ready native attach flow for `runtimeMode=pty-rust` where `discode attach` uses the Rust native client by default, while preserving compatibility with existing runtime ownership, stream contracts, and rollback behavior.

In scope:

- stream/control compatibility required for native attach
- `runtime-client-rs` attach UX and reliability
- CLI routing, packaging, fallback, and rollout checks

Out of scope:

- replacing daemon or sidecar ownership with an external multiplexer
- changing Discord/Slack bridge contracts

## Background

- The architecture already defines `runtime-client-rs` as the native runtime attach packaging target.
- Product specs currently document TypeScript/OpenTUI as the primary attach surface, with native attach work in progress.
- A draft native attach implementation plan and v2 runtime native client contract already exist.
- The current codebase already contains a native client crate (`runtime-client-rs`) and attach CLI fallback wiring in `src/cli/commands/attach.ts`.

## Milestones

1. [ ] Freeze execution scope against existing draft contract and implementation plan (status: not started).
2. [ ] Complete stream protocol v2 parity and validation paths in daemon/runtime protocol layers (status: not started).
3. [ ] Harden PTY event ordering/lifecycle behavior needed for native client stability under input/resize churn (status: not started).
4. [ ] Deliver native client attach MVP reliability pass (connect/subscribe/render/input/resize/reconnect) in `runtime-client-rs` (status: not started).
5. [ ] Finalize CLI routing and packaging so `discode attach` prefers native attach in `pty-rust` with deterministic fallback behavior (status: not started).
6. [ ] Run end-to-end validation and update docs/rollout posture to reflect primary native attach behavior (status: not started).

## Current Progress

- Required architecture/product/reference docs were reviewed for this execution plan.
- Native attach direction is already documented in `docs/NATIVE_ATTACH_IMPLEMENTATION_PLAN.md` and `docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md`.
- Runtime attach product docs still describe OpenTUI as primary; this plan tracks the work to close that gap.
- No milestones in this plan have started yet.

## Key Decisions

- Keep runtime ownership in daemon + `pty-rust`; native attach is a client replacement, not a runtime replacement.
- Maintain protocol coexistence so v1 clients continue to work while native attach uses v2.
- Keep a deterministic fallback path during rollout to reduce regression risk.
- Treat documentation and rollout gates as part of done criteria, not post-work cleanup.

## Remaining Issues or Open Questions

- Exact default-switch gate: what CI/stress thresholds are required before native attach becomes default for all `pty-rust` users?
- Fallback policy surface: which failures should auto-fallback versus hard-fail with remediation guidance?
- Feature parity floor for de-emphasizing OpenTUI: which UX capabilities are mandatory versus follow-up work?
- Platform scope timing: when to expand beyond macOS/Linux target assumptions for native attach.

## Links to Related Documents

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [docs/PLANS.md](../../PLANS.md)
- [docs/product-specs/runtime-attach-experience.md](../../product-specs/runtime-attach-experience.md)
- [docs/NATIVE_ATTACH_IMPLEMENTATION_PLAN.md](../../NATIVE_ATTACH_IMPLEMENTATION_PLAN.md)
- [docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md](../../references/RUNTIME_NATIVE_CLIENT_CONTRACT.md)
- [docs/exec-plans/active/README.md](./README.md)

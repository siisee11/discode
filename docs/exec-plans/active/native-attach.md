# Native Attach Plan

Canonical for: delivering native terminal attach as the primary `runtimeMode=pty-rust` local interaction path  
Audience: contributors working on runtime stream contracts, native client UX, and attach CLI routing  
Update when: milestone status changes, scope shifts, or rollout decisions change

## Goal / scope

Ship a production-ready native attach flow for `runtimeMode=pty-rust` where `discode attach` uses the Rust native client by default, while preserving runtime ownership, stream compatibility, and deterministic fallback behavior.

In scope:

- stream/control protocol parity required for native attach
- `runtime-client-rs` reliability for connect, render, input, resize, and reconnect
- CLI routing, packaging, and fallback policy for native-first attach
- validation and doc updates required for default-switch readiness

Out of scope:

- replacing daemon or sidecar ownership with an external multiplexer
- changing Discord/Slack bridge contracts

## Background

- `ARCHITECTURE.md` defines `runtime-client-rs` as the native runtime attach packaging target.
- `docs/product-specs/runtime-attach-experience.md` still documents TypeScript/OpenTUI as primary, so native attach is not yet reflected as shipped behavior.
- `docs/NATIVE_ATTACH_IMPLEMENTATION_PLAN.md` and `docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md` already define the target direction and v2 protocol model.
- `src/cli/commands/attach.ts` already includes attach routing/fallback logic that can be tightened for native-first behavior.

## Milestones

1. [ ] Contract alignment pass: confirm `docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md` and `src/runtime/protocol.ts` match for v2 handshake/message validation (status: not started).
2. [ ] Stream server parity pass: implement or close gaps in daemon/stream handling for v2 `hello`, ack/error semantics, and version-gated outbound messages (status: not started).
3. [ ] Runtime ordering hardening pass: fix event sequencing and lifecycle race edges needed for stable native client frame/patch apply under rapid input/resize churn (status: not started).
4. [ ] Native client reliability pass: complete `runtime-client-rs` attach loop coverage (subscribe/render/input/resize/reconnect/resync) and error handling needed for daily use (status: not started).
5. [ ] CLI routing and packaging pass: make `discode attach` prefer native attach in `pty-rust`, keep deterministic fallback, and verify artifact packaging/discovery (status: not started).
6. [ ] Validation and rollout readiness pass: land focused tests/docs updates and define default-switch gate criteria for native-first attach (status: not started).

## Current progress

- Required planning documents were reviewed: `AGENTS.md`, `ARCHITECTURE.md`, `docs/PLANS.md`, native attach references, and runtime attach product spec.
- Execution plan is now captured in the required checked-in structure.
- All milestones are currently not started.

## Key decisions

- Keep runtime ownership in daemon + `pty-rust`; native attach is a client replacement, not runtime replacement.
- Preserve v1/v2 coexistence during rollout to avoid breaking existing clients.
- Keep deterministic fallback behavior during transition to reduce user-facing regressions.
- Treat tests and canonical docs as part of the definition of done for each phase.

## Remaining issues / open questions

- What exact CI/stress thresholds are required before flipping native attach to default for all `pty-rust` users?
- Which failure classes should auto-fallback to OpenTUI versus hard-fail with remediation guidance?
- What is the minimum feature parity bar before OpenTUI is no longer the documented primary path?
- What is the timing for broadening platform support beyond initial macOS/Linux assumptions?

## Links to related documents

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [docs/PLANS.md](../../PLANS.md)
- [docs/product-specs/runtime-attach-experience.md](../../product-specs/runtime-attach-experience.md)
- [docs/NATIVE_ATTACH_IMPLEMENTATION_PLAN.md](../../NATIVE_ATTACH_IMPLEMENTATION_PLAN.md)
- [docs/references/RUNTIME_NATIVE_CLIENT_CONTRACT.md](../../references/RUNTIME_NATIVE_CLIENT_CONTRACT.md)
- [docs/exec-plans/active/README.md](./README.md)

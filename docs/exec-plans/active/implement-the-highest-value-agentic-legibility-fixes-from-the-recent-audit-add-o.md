# Agentic Legibility Fixes Plan

Canonical for: implementing high-value documentation and discoverability fixes from the recent agentic legibility audit
Audience: contributors updating setup/bootstrap entrypoints, canonical docs routing, and decision-recording structure
Update when: milestones move, scope changes, or a new constraint affects rollout

## Goal and Scope

Implement the highest-value legibility improvements by adding one canonical setup/bootstrap entrypoint, routing existing docs to it, tightening root navigation in `AGENTS.md`, and introducing ADR-style decision records under `docs/` with an initial policy record.

Scope includes doc and documentation-adjacent repository surfaces only:

- one canonical setup/bootstrap entrypoint for contributors and agents
- routing updates in existing canonical docs so setup/bootstrap guidance converges on that entrypoint
- `AGENTS.md` tightening so command/task surfaces are discoverable without turning it into a manual
- ADR location, minimal template, and an initial decision record capturing docs/decision-record policy
- lightweight verification for touched surfaces

Out of scope:

- changing runtime behavior beyond doc-discoverability and setup entrypoint wiring
- broad refactors outside files needed for the legibility fixes

## Background

The repository already has a strong canonical-doc map (`AGENTS.md`, `ARCHITECTURE.md`, `docs/*.md`) and checked-in execution plan conventions, but recent audit feedback identified friction in startup discoverability and decision-history consistency:

- setup/bootstrap guidance is not yet clearly converged on one canonical entrypoint
- root navigation can better expose primary command/task surfaces while staying map-like
- decision records are implied in design docs but not standardized with an ADR location/template/policy

This plan sequences those fixes so future coding loops have a single startup path and durable decision traceability.

## Milestones

1. `not started` - Audit current setup/bootstrap and command/task discovery surfaces (`AGENTS.md`, `ARCHITECTURE.md`, key docs) and choose the canonical bootstrap entrypoint path.
2. `not started` - Add the canonical setup/bootstrap entrypoint document and route existing canonical docs to it.
3. `not started` - Tighten root `AGENTS.md` to index primary command/task surfaces alongside the doc tree while preserving map-only constraints.
4. `not started` - Add ADR structure under `docs/` (index/location + minimal template) and create the initial decision record for docs + ADR policy.
5. `not started` - Update any impacted canonical index docs for discoverability and run lightweight validation for touched documentation surfaces.

## Current Progress

- Plan created and checked in.
- Implementation milestones have not started.

## Key Decisions

- Keep this work documentation-first and constrained to legibility/discoverability surfaces.
- Use one canonical bootstrap entrypoint and route from existing docs rather than duplicating procedural setup instructions.
- Introduce ADRs with a minimal template and explicit policy record to avoid fragmented decision history.

## Remaining Issues / Open Questions

- Confirm which existing file should serve as the canonical bootstrap entrypoint versus introducing a new dedicated doc.
- Confirm naming and placement convention for ADR files (for example, numeric prefix vs. slug-only) based on repository norms.
- Determine the minimal lightweight checks that best validate touched docs in this repository (`harnesscli audit .`, targeted lint, or both).

## Links to Related Documents

- [`../../PLANS.md`](../../PLANS.md)
- [`README.md`](README.md)
- [`../../../AGENTS.md`](../../../AGENTS.md)
- [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md)
- [`../../DESIGN.md`](../../DESIGN.md)
- [`../../design-docs/index.md`](../../design-docs/index.md)
- [`../../../NON_NEGOTIABLE_RULES.md`](../../../NON_NEGOTIABLE_RULES.md)

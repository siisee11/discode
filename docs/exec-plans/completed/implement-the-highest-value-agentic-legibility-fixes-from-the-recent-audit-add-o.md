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

1. `completed` - Audit current setup/bootstrap and command/task discovery surfaces (`AGENTS.md`, `ARCHITECTURE.md`, key docs) and choose the canonical bootstrap entrypoint path.
2. `completed` - Add the canonical setup/bootstrap entrypoint document and route existing canonical docs to it.
3. `completed` - Tighten root `AGENTS.md` to index primary command/task surfaces alongside the doc tree while preserving map-only constraints.
4. `completed` - Add ADR structure under `docs/` (index/location + minimal template) and create the initial decision record for docs + ADR policy.
5. `completed` - Update any impacted canonical index docs for discoverability and run lightweight validation for touched documentation surfaces.

## Current Progress

- Plan created and checked in.
- Milestone 1 completed on 2026-03-15 after auditing setup/bootstrap and command/task discovery surfaces:
  - setup and onboarding guidance is currently split across `README.md`, `docs/product-specs/new-user-onboarding.md`, and integration-specific guides in `docs/references/`
  - contributor/runtime bootstrap details currently live in `DEVELOPMENT.md` and operations docs, but there is no single canonical bootstrap page
  - primary command/task surfaces to index in `AGENTS.md` during milestone 3 are `bin/discode.ts` (CLI surface), `Makefile.harness` (`smoke`, `test`, `lint`, `typecheck`, `audit`, `ci`, `ralph-loop`), and `package.json` workflow scripts (`harness:*`, `ralph-loop`, quality/release scripts)
- Milestone 2 completed on 2026-03-15:
  - added canonical bootstrap entrypoint doc at `docs/operations/bootstrap.md`
  - routed canonical setup references to bootstrap entrypoint from `docs/operations/index.md`, `docs/product-specs/new-user-onboarding.md`, `docs/references/index.md`, and `ARCHITECTURE.md`
  - kept detailed platform setup instructions in `docs/references/DISCORD_SETUP.md` and `docs/references/SLACK_SETUP.md`, with bootstrap as the start point
  - lightweight check run: verified all newly linked routing targets exist on disk (`docs-link-target-existence: ok`)
- Milestone 3 completed on 2026-03-15:
  - tightened root `AGENTS.md` without converting it into a manual
  - expanded the doc-tree map to include `docs/operations/` and `bootstrap.md`
  - added `Start Here` routing for the canonical setup/bootstrap entrypoint
  - added a dedicated `Primary Command/Task Surfaces` section indexing `bin/discode.ts`, `runtime-client-rs/src/main.rs`, `Makefile.harness`, and `package.json`
  - lightweight check run: verified new `AGENTS.md` link targets exist on disk (`agents-link-target-existence: ok`)
- Milestone 4 completed on 2026-03-15:
  - added ADR location/index at `docs/decisions/index.md`
  - added minimal ADR template at `docs/decisions/adr-template.md`
  - added initial ADR `docs/decisions/0001-docs-and-decision-record-policy.md` capturing docs routing and ADR lifecycle policy
  - lightweight check run: verified ADR files and required metadata sections (`adr-surface-sanity: ok`)
- Milestone 5 completed on 2026-03-15:
  - updated canonical discoverability docs to surface ADR location and policy entrypoints:
    - `AGENTS.md` reference tree and task routing now include `docs/decisions/index.md`
    - `docs/DESIGN.md` now routes decision history to `docs/decisions/index.md`
    - `docs/design-docs/index.md` now indexes `docs/decisions/index.md` as an active canonical document
  - lightweight check run: targeted markdown link validation across touched canonical docs (`docs-link-check: ok`)

## Key Decisions

- Keep this work documentation-first and constrained to legibility/discoverability surfaces.
- Use one canonical bootstrap entrypoint and route from existing docs rather than duplicating procedural setup instructions.
- Introduce ADRs with a minimal template and explicit policy record to avoid fragmented decision history.
- Canonical setup/bootstrap entrypoint path will be a new `docs/operations/bootstrap.md` document, linked from root discovery docs and existing setup references in milestone 2.
- Bootstrap entrypoint remains concise and routing-focused (not a full manual), with detailed instructions delegated to existing reference docs.
- `AGENTS.md` command/task indexing stays surface-level (entrypoints + file pointers), while procedural details remain in canonical docs and command definitions.
- ADR naming/placement convention: zero-padded numeric ADRs under `docs/decisions/`, authored from `docs/decisions/adr-template.md`.
- Lightweight verification policy for these doc-only changes: targeted link-target validation on touched canonical docs is sufficient for milestone checks.

## Remaining Issues / Open Questions

- None for the scoped legibility milestones in this plan.

## Links to Related Documents

- [`../../PLANS.md`](../../PLANS.md)
- [`README.md`](README.md)
- [`../../../AGENTS.md`](../../../AGENTS.md)
- [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md)
- [`../../DESIGN.md`](../../DESIGN.md)
- [`../../design-docs/index.md`](../../design-docs/index.md)
- [`../../../NON_NEGOTIABLE_RULES.md`](../../../NON_NEGOTIABLE_RULES.md)

# Documentation Navigation Restructure

Status: completed
Date: 2026-03-06

## Goal / Scope

Restructure repository documentation so `AGENTS.md` becomes a short navigation entrypoint and substantive guidance moves into indexed canonical docs under `docs/` and top-level maps.

## Background

The previous `AGENTS.md` contained real operational rules for release, web deploy, and daemon restart behavior.
That made the repo entrypoint heavier than necessary and left the deeper documentation system underused.

## Milestones

- Audit current `AGENTS.md`, top-level docs, and `docs/` layout
- Define canonical locations for operational, product, architecture, and planning guidance
- Rewrite `AGENTS.md` as a table-of-contents document
- Add missing indexes and runbooks without attempting a full migration of every legacy doc

## Current Progress

- Completed audit of `AGENTS.md`, `ARCHITECTURE.md`, `docs/ARCHITECTURE.md`, README links, and existing flat docs
- Added canonical map docs and section indexes
- Moved release, web deploy, and daemon restart guidance out of `AGENTS.md`

## Key Decisions

- Keep the initial change incremental: add indexes and canonical entrypoints first, migrate legacy flat docs over time
- Make root `ARCHITECTURE.md` the canonical architecture map and convert `docs/ARCHITECTURE.md` into a compatibility pointer
- Put release and daemon operational guidance under `docs/references/` instead of expanding `AGENTS.md`
- Track remaining migration work in `docs/exec-plans/tech-debt-tracker.md`

## Remaining Issues / Open Questions

- Several legacy flat docs still need to be reclassified or migrated into `docs/design-docs/` and `docs/product-specs/`
- User-facing site docs currently duplicate parts of maintainer documentation and should eventually reference canonical repo docs more directly
- Korean mirrors for the new canonical docs are not created in this first pass

## Links To Related Documents

- [AGENTS.md](/Users/dev/git/discode/AGENTS.md)
- [ARCHITECTURE.md](/Users/dev/git/discode/ARCHITECTURE.md)
- [docs/design-docs/index.md](/Users/dev/git/discode/docs/design-docs/index.md)
- [docs/product-specs/index.md](/Users/dev/git/discode/docs/product-specs/index.md)
- [docs/references/release-runbook.md](/Users/dev/git/discode/docs/references/release-runbook.md)
- [docs/references/daemon-operations.md](/Users/dev/git/discode/docs/references/daemon-operations.md)
- [docs/exec-plans/tech-debt-tracker.md](/Users/dev/git/discode/docs/exec-plans/tech-debt-tracker.md)

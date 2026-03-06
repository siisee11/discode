# Tech Debt Tracker

This file tracks repository debt that should stay visible across active and completed plans.

## Documentation Debt

- Migrate high-value flat docs into `docs/design-docs/` or `docs/product-specs/` the next time they need substantive edits.
- Add freshness metadata or verification passes to legacy docs that still influence current work.
- Decide whether user-facing site release docs should be generated from or linked directly to the canonical maintainer runbook.
- Add Korean mirrors for newly introduced canonical docs if they need to support ongoing maintainer workflows.

## Architecture / Process Debt

- Reconcile remaining duplicate architecture entrypoints so README and site docs consistently point at the canonical root `ARCHITECTURE.md`.
- Clarify which Rust migration documents are historical versus still operationally relevant.

# Harness Scaffolding Plan

Canonical for: implementing the repository harness requested by `create-harness/harness-scaffolding-checklist.md`
Audience: contributors building or extending the local agent harness
Update when: a harness phase starts, lands, or changes scope

## Goal and Scope

Build a worktree-aware local harness for the browser-facing `site/` app, observability scaffolding, invariant enforcement, recurring cleanup automation, and a tighter repository audit/CI contract.

## Background

- The repository already has the phase 1 documentation skeleton and a phase 6 baseline harness.
- The missing pieces are the worktree boot contract, observability lifecycle, architectural linters, recurring cleanup automation, and the docs tying those systems together.
- The browser-facing surface in this repository is the Vite-served landing page and docs site under `site/`.

## Milestones

1. Phase 1: confirm docs structure and add the checked-in harness plan.
2. Phase 2: add worktree-aware app boot scripts and launch metadata.
3. Phase 3: add per-worktree observability lifecycle scripts and telemetry plumbing.
4. Phase 4: add machine-readable architecture rules, custom linters, and structural tests.
5. Phase 5: add golden-principles cleanup scanning, grading, and scheduled automation.
6. Phase 6: tighten harness scripts, audit coverage, and CI verification.

## Current Progress

- Completed: repository audit against the checklist; existing docs/harness baseline verified.
- Completed: phase 1 plan/check-in and phase 2 worktree-aware app boot around the Vite `site/` app.
- Completed: phase 3 observability lifecycle, phase 4 invariant enforcement, phase 5 recurring cleanup automation, and phase 6 harness/CI tightening.
- Verified: `cargo build --release --manifest-path harness/Cargo.toml`, `./harness/target/release/harnesscli audit .`, `make smoke`, `make lint`, `npm run typecheck`, and `npm test` all pass as of 2026-03-08.

## Key Decisions

- Treat the Vite-served `site/` surface as the harness app for agent-browser workflows.
- Preserve the existing documentation map and extend it instead of rebuilding phase 1 from scratch.
- Keep worktree isolation deterministic by deriving ports and state directories from the current worktree path.

## Outcome Notes

- The observability stack remains optional and fails clearly when required binaries or containers are absent.
- `agent-browser` was installed locally for harness/browser workflows.
- The recurring cleanup fixer defaults to explicit, scoped actions instead of broad silent rewrites.

## Related Links

- [`../../../create-harness/harness-scaffolding-checklist.md`](../../../create-harness/harness-scaffolding-checklist.md)
- [`../../../create-harness/execution-env-setup.md`](../../../create-harness/execution-env-setup.md)
- [`../../../create-harness/observability-stack-setup.md`](../../../create-harness/observability-stack-setup.md)
- [`../../../create-harness/enforce-invariants.md`](../../../create-harness/enforce-invariants.md)
- [`../../../create-harness/recurring-cleanup.md`](../../../create-harness/recurring-cleanup.md)
- [`../../../create-harness/implement-harness-audit.md`](../../../create-harness/implement-harness-audit.md)

# AGENTS

This file is the repository navigation layer.
It should stay short, stable, and high-signal.

Do not turn this file into a manual.
When guidance becomes detailed, move it into the canonical document and link it here.

## Operating Principles

- Read the smallest set of documents that can answer the task.
- Prefer canonical docs over duplicated notes or old summaries.
- Keep instructions close to the code or workflow they describe.
- If behavior changes, update the source-of-truth doc instead of adding exceptions here.

## Read Order

1. Start with [README.md](/Users/dev/git/discode/README.md) for product overview and CLI usage.
2. Read [ARCHITECTURE.md](/Users/dev/git/discode/ARCHITECTURE.md) for system domains, entrypoints, and dependency direction.
3. Jump to the most specific indexed doc for the task.

## Task Routing

- Product or feature behavior:
  [docs/product-specs/index.md](/Users/dev/git/discode/docs/product-specs/index.md)
  [docs/PRODUCT_SENSE.md](/Users/dev/git/discode/docs/PRODUCT_SENSE.md)
- Architecture, refactors, runtime design:
  [ARCHITECTURE.md](/Users/dev/git/discode/ARCHITECTURE.md)
  [docs/design-docs/index.md](/Users/dev/git/discode/docs/design-docs/index.md)
  [docs/MODULE_BOUNDARIES.md](/Users/dev/git/discode/docs/MODULE_BOUNDARIES.md)
- Multi-step implementation or ambiguous work:
  [docs/PLANS.md](/Users/dev/git/discode/docs/PLANS.md)
  [docs/exec-plans/active/README.md](/Users/dev/git/discode/docs/exec-plans/active/README.md)
  [docs/exec-plans/tech-debt-tracker.md](/Users/dev/git/discode/docs/exec-plans/tech-debt-tracker.md)
- Release, deploy, and daemon operations:
  [docs/references/index.md](/Users/dev/git/discode/docs/references/index.md)
  [docs/references/release-runbook.md](/Users/dev/git/discode/docs/references/release-runbook.md)
  [docs/references/daemon-operations.md](/Users/dev/git/discode/docs/references/daemon-operations.md)
- Frontend or landing page work:
  [docs/FRONTEND.md](/Users/dev/git/discode/docs/FRONTEND.md)
- Reliability, runtime recovery, restart policy:
  [docs/RELIABILITY.md](/Users/dev/git/discode/docs/RELIABILITY.md)
- Security, secrets, local trust boundaries:
  [docs/SECURITY.md](/Users/dev/git/discode/docs/SECURITY.md)

## Document Priority

Use the most specific applicable document in this order:

1. Feature spec or execution plan for the exact task
2. Top-level map docs such as [ARCHITECTURE.md](/Users/dev/git/discode/ARCHITECTURE.md) and the `docs/*.md` topic guides
3. Focused reference or runbook docs under `docs/references/`
4. README and user-facing site docs

If two docs disagree, prefer the more specific doc and then fix the older one.

## Canonical Maps

- Architecture map:
  [ARCHITECTURE.md](/Users/dev/git/discode/ARCHITECTURE.md)
- Design rationale and decision log:
  [docs/DESIGN.md](/Users/dev/git/discode/docs/DESIGN.md)
  [docs/design-docs/index.md](/Users/dev/git/discode/docs/design-docs/index.md)
- Product behavior:
  [docs/PRODUCT_SENSE.md](/Users/dev/git/discode/docs/PRODUCT_SENSE.md)
  [docs/product-specs/index.md](/Users/dev/git/discode/docs/product-specs/index.md)
- Planning and debt tracking:
  [docs/PLANS.md](/Users/dev/git/discode/docs/PLANS.md)
  [docs/exec-plans/tech-debt-tracker.md](/Users/dev/git/discode/docs/exec-plans/tech-debt-tracker.md)
- Quality, reliability, and security:
  [docs/QUALITY_SCORE.md](/Users/dev/git/discode/docs/QUALITY_SCORE.md)
  [docs/RELIABILITY.md](/Users/dev/git/discode/docs/RELIABILITY.md)
  [docs/SECURITY.md](/Users/dev/git/discode/docs/SECURITY.md)

## Update Rules

- Keep this file as a table of contents, not a rule dump.
- Add new topics to the relevant index before adding more prose here.
- When creating a new canonical doc, link it from the nearest index and from this file only if it changes repo-level navigation.

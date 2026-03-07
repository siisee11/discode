# AGENTS

`AGENTS.md` is the repository map, not the repository manual.
Start here, then open only the documents needed for the task at hand.

Reference structure:

```text
AGENTS.md
ARCHITECTURE.md
docs/
├── design-docs/
│   ├── index.md
│   ├── core-beliefs.md
│   └── ...
├── exec-plans/
│   ├── active/
│   ├── completed/
│   └── tech-debt-tracker.md
├── generated/
│   └── db-schema.md
├── product-specs/
│   ├── index.md
│   ├── new-user-onboarding.md
│   └── ...
├── references/
│   ├── design-system-reference-llms.txt
│   ├── nixpacks-llms.txt
│   ├── uv-llms.txt
│   └── ...
├── DESIGN.md
├── FRONTEND.md
├── PLANS.md
├── PRODUCT_SENSE.md
├── QUALITY_SCORE.md
├── RELIABILITY.md
└── SECURITY.md
```

## Start Here

- System map and entrypoints: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Design rationale and decision records: [`docs/DESIGN.md`](docs/DESIGN.md)
- Feature intent and product behavior: [`docs/PRODUCT_SENSE.md`](docs/PRODUCT_SENSE.md)
- Execution plans and technical debt: [`docs/PLANS.md`](docs/PLANS.md)
- Reliability expectations and operational checks: [`docs/RELIABILITY.md`](docs/RELIABILITY.md)
- Security model and secret-handling rules: [`docs/SECURITY.md`](docs/SECURITY.md)
- UI surfaces and site/TUI guidance: [`docs/FRONTEND.md`](docs/FRONTEND.md)
- Quality bar and current verification posture: [`docs/QUALITY_SCORE.md`](docs/QUALITY_SCORE.md)

## Task Routing

- Product questions or behavior changes: [`docs/product-specs/index.md`](docs/product-specs/index.md)
- Architecture tradeoffs or domain boundaries: [`docs/design-docs/index.md`](docs/design-docs/index.md)
- Release, deployment, or daemon operations: [`docs/operations/index.md`](docs/operations/index.md)
- Contracts and low-level references: [`docs/references/index.md`](docs/references/index.md)
- Checked-in execution plans: [`docs/exec-plans/active/README.md`](docs/exec-plans/active/README.md)
- Completed execution history: [`docs/exec-plans/completed/README.md`](docs/exec-plans/completed/README.md)
- Generated repository facts: [`docs/generated/db-schema.md`](docs/generated/db-schema.md)

## Working Rules

- Keep `AGENTS.md` short and stable. Do not add substantive project knowledge here.
- Update the canonical document for the topic you changed, not just the nearest README.
- Prefer small, focused documents with indexes over long catch-all documents.
- When a doc stops matching the code, fix the doc or delete it; do not leave stale guidance in place.
- If a task needs a durable implementation plan, add it under `docs/exec-plans/active/` and move it to `completed/` when shipped.
- If you find guidance that only exists in chat or tribal knowledge, promote it into the appropriate canonical doc under `docs/`.

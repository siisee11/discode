Please apply the following strategy to our repository.

The core idea is that AGENTS.md should not become a giant manual containing everything. Instead, I want it to remain a short, stable entrypoint, while the real source of truth lives in a structured, in-repository documentation system. The goal is to let agents start from a small map and progressively navigate to deeper context only when needed, rather than overwhelming them with too much guidance upfront.

Please keep the following example structure exactly as-is in the prompt for reference:

```
AGENTS.md
ARCHITECTURE.md
NON_NEGOTIABLE_RULES.md
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

This is the direction I want:

### AGENTS.md

* AGENTS.md should contain only table-of-contents like above example.
* It should be a navigation document, not a knowledge document.
* Around 100 lines if possible.
* If there is already content in the current AGENTS.md that goes beyond table-of-contents style guidance, that content should be moved out into newly created or properly organized documents under docs/, and AGENTS.md should be reduced to pointers to those documents.
* In other words, any existing substantive guidance currently living in AGENTS.md should be extracted into the appropriate documentation under docs/, rather than preserved inline.

### Structured repository knowledge
* The real source of truth should live in docs/ and related top-level documents.
* Organize documentation into focused, discoverable sections with strong indexing and cross-linking.
* Prefer many small, maintainable documents over one giant document.
* Make it clear which document is canonical for each topic, who it is for, and when it should be updated.

### Reference documents
* When scaffolding `docs/references/`, copy the documentation-oriented contents of `create-harness/references/` into `docs/references/`.
* These are pre-curated LLM-friendly reference files (e.g., `codex-app-server-llm.txt`) that give agents context about external tools, frameworks, and patterns used by the project.
* If `create-harness/references/` also contains reference implementations such as `scripts/ralph-loop/`, copy those into the matching repository path instead of under `docs/references/`.
* Add project-specific references over time as new dependencies or external integrations are introduced.

### Non-negotiable rules

* NON_NEGOTIABLE_RULES.md contains absolute rules that block merge unconditionally. No exceptions, no workarounds.
* Use `create-harness/templates/NON_NEGOTIABLE_RULES.md` as the template. Copy it to the repository root and adapt as needed.
* AGENTS.md must link to NON_NEGOTIABLE_RULES.md so agents discover it immediately.
* Rules are enforced mechanically in CI — they are not advisory.

### Architecture and product knowledge

* ARCHITECTURE.md should serve as a top-level map of domains, package boundaries, dependency direction, and major entrypoints.
* docs/product-specs/ should contain feature-level product specs and be accessible through an index.md.

* docs/design-docs/ should contain design rationale, core beliefs, and major decision documents, with a way to track status and verification state.

### Core beliefs and agent-first operating principles

* `docs/design-docs/core-beliefs.md` is a required document. It must be created during Phase 1 and linked from the design-docs index.
* It should contain two sections:

**Product Beliefs** — the product principles that shape design tradeoffs (e.g., local-first vs hosted, chat as control surface, persistent sessions). Adapt these to the specific product being built.

**Agent-First Operating Principles** — the following principles must be encoded. They define how agents and humans interact with the repository:

1. **Repository knowledge is the system of record.**
   Anything that lives only in Slack, Google Docs, or someone's head is invisible to agents. If a decision matters, it must be encoded as a versioned artifact in this repository — code, markdown, schema, or executable plan.

2. **What the agent cannot see does not exist.**
   Context is bounded by what is discoverable in-repo at runtime. Push product intent, architectural rationale, and team conventions into docs/ so agents can reason about them directly.

3. **Enforce boundaries centrally, allow autonomy locally.**
   Architecture rules, dependency direction, and boundary validation are enforced mechanically via linters and CI. Within those guardrails, agents have freedom in how solutions are expressed.

4. **Corrections are cheap, waiting is expensive.**
   Agent throughput far exceeds human attention. Short-lived PRs with minimal blocking merge gates and fast follow-up fixes are preferred over long review queues.

5. **Prefer boring technology.**
   Composable, API-stable, well-represented-in-training-data dependencies are easier for agents to model. When an upstream library is opaque, it is often cheaper to reimplement the needed subset with full test coverage than to work around it.

6. **Encode taste once, enforce continuously.**
   Human judgment about quality, naming, structure, and reliability is captured in golden-principles.yaml, custom linters, and architectural rules — then applied mechanically to every line of code on every run.

7. **Treat documentation as executable infrastructure.**
   Docs are linted, cross-linked, freshness-checked, and graded. Stale or orphaned documentation is a defect, same as a failing test.

### Treat plans as first-class artifacts

* Small tasks can use lightweight plans, but complex work should be tracked with checked-in execution plans.

* Use docs/exec-plans/active/, docs/exec-plans/completed/, and tech-debt-tracker.md to version active work, completed work, and known technical debt together in the repository.

* An execution plan should ideally include:
goal / scope
background
milestones
current progress
key decisions
remaining issues / open questions
links to related documents

### Important principles

* Do not create one massive instruction manual.

* AGENTS.md must remain only a table of contents.

* If existing AGENTS.md content contains real guidance, move that guidance into new or existing documents under docs/.

* Optimize for discoverability, freshness, and maintainability.

* Make it easy for both humans and agents to quickly identify the canonical source of truth.

* Documentation should reflect real code and real operating practices, not idealized descriptions.

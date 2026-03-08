# Core Beliefs

Status: active
Audience: anyone making design or implementation tradeoffs
Verified against code: 2026-03-07
Update when: these principles stop matching how the repository actually works

## Product Beliefs

1. Local-first execution beats hosted orchestration.
   The core flows assume agents run on the developer machine and expose only the collaboration surface remotely.

2. Chat is the control surface, not a secondary notification channel.
   Discord and Slack are part of the product workflow, not just alert sinks.

3. Persistent sessions matter.
   The daemon and runtime layers are designed around long-lived project instances rather than one-shot commands.

## Engineering Beliefs

1. Keep one stable daemon surface and hide implementation swaps behind contracts.
   The repository already treats runtime and daemon protocols as compatibility boundaries.

2. Prefer explicit adapters over agent-specific branching scattered across the codebase.
   Agent integrations are separated into adapters, policies, and hook installers.

3. Migrations should preserve operating behavior before optimizing internals.
   The PTY Rust and Rust-daemon documents both codify compatibility-first migration steps.

4. Durable reasoning belongs in checked-in docs and plans, not only in chat history.
   That is why architecture maps, plans, and operational docs are part of the repository.

## Agent-First Operating Principles

1. Repository knowledge is the system of record.
   Anything that lives only in Slack, Google Docs, or someone's head is invisible to agents. If a decision matters, it must be encoded as a versioned artifact in this repository—code, markdown, schema, or executable plan.

2. What the agent cannot see does not exist.
   Context is bounded by what is discoverable in-repo at runtime. Push product intent, architectural rationale, and team conventions into docs/ so agents can reason about them directly.

3. Enforce boundaries centrally, allow autonomy locally.
   Architecture rules, dependency direction, and boundary validation are enforced mechanically via linters and CI. Within those guardrails, agents have freedom in how solutions are expressed.

4. Corrections are cheap, waiting is expensive.
   Agent throughput far exceeds human attention. Short-lived PRs with minimal blocking merge gates and fast follow-up fixes are preferred over long review queues.

5. Prefer boring technology.
   Composable, API-stable, well-represented-in-training-data dependencies are easier for agents to model. When an upstream library is opaque, it is often cheaper to reimplement the needed subset with full test coverage than to work around it.

6. Encode taste once, enforce continuously.
   Human judgment about quality, naming, structure, and reliability is captured in golden-principles.yaml, custom linters, and architectural rules—then applied mechanically to every line of code on every run.

7. Treat documentation as executable infrastructure.
   Docs are linted, cross-linked, freshness-checked, and graded. Stale or orphaned documentation is a defect, same as a failing test.

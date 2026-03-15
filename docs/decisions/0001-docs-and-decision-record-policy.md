# ADR-0001: Docs Canonical Routing and Decision Record Policy

Status: accepted
Date: 2026-03-15
Deciders: repository maintainers

## Context

The repository has strong map-style top-level docs (`AGENTS.md`, `ARCHITECTURE.md`, and `docs/*` indexes), but setup/bootstrap and decision history were previously fragmented across multiple files.

Recent legibility work introduced a canonical setup/bootstrap entrypoint at `docs/operations/bootstrap.md` and tightened map-style routing. A durable ADR policy is needed so future cross-cutting decisions are recorded consistently instead of being implied in scattered notes.

## Decision

Adopt the following documentation and decision-record policy:

1. Keep map docs concise and routing-focused; procedural detail stays in canonical topic docs.
2. Use one canonical setup/bootstrap entrypoint: `docs/operations/bootstrap.md`.
3. Store ADRs in `docs/decisions/`.
4. Name ADR files with zero-padded numeric prefixes and slugs (for example, `0002-some-decision.md`).
5. Write ADRs using `docs/decisions/adr-template.md`.
6. Record one durable decision per ADR with explicit status and consequences.
7. When a decision changes, add a new ADR and mark prior ADRs as superseded rather than rewriting history.

## Consequences

- Positive: setup and decision history become easier for contributors and agents to discover and follow.
- Negative: maintainers must keep ADR status transitions current when decisions evolve.
- Follow-up: keep canonical indexes updated so the bootstrap entrypoint and ADR location remain discoverable.

## Links

- `AGENTS.md`
- `ARCHITECTURE.md`
- `docs/operations/bootstrap.md`
- `docs/exec-plans/active/implement-the-highest-value-agentic-legibility-fixes-from-the-recent-audit-add-o.md`

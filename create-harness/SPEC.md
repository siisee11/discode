# create-harness Spec

`create-harness/` is a portable blueprint for bootstrapping a harness engineering system in any repository. It provides phase-by-phase instructions that an agent (or human) follows sequentially to install documentation structure, execution environments, observability, invariant enforcement, automated cleanup, an autonomous coding loop, and a final audit.

## Goal

Turn any repository into a fully harnessed, agent-operable codebase where:

- Documentation is structured and navigable, not monolithic.
- The app boots deterministically per Git worktree with isolated resources.
- Logs, metrics, and traces are queryable locally without external infrastructure.
- Architectural boundaries are enforced mechanically, not by convention alone.
- Technical debt is detected, graded, and cleaned up automatically.
- An autonomous agent loop (Ralph Loop) can drive a task from prompt to pull request.
- A single audit command verifies the entire harness is wired and passing.

## Phases

| Phase | File | Description |
|-------|------|-------------|
| 1 | [`1_harness_structure.md`](./1_harness_structure.md) | Repository documentation structure |
| 2 | [`2_execution-env-setup.md`](./2_execution-env-setup.md) | Worktree-aware execution environment |
| 3 | [`3_observability-stack-setup.md`](./3_observability-stack-setup.md) | Per-worktree observability stack |
| 4 | [`4_enforce-invariants.md`](./4_enforce-invariants.md) | Custom linters and structural tests |
| 5 | [`5_recurring-cleanup.md`](./5_recurring-cleanup.md) | Automated tech debt cleanup |
| 6 | [`6_ralph-loop.md`](./6_ralph-loop.md) | Autonomous agent coding loop |
| 7 | [`7_implement-harness-audit.md`](./7_implement-harness-audit.md) | End-to-end harness audit |

Phases must be applied in order. Each phase document contains self-contained instructions.

## Checklist

The [`harness-scaffolding-checklist.md`](./harness-scaffolding-checklist.md) tracks completion status across all phases with per-item checkboxes.

## Key Constraints

- **Single Rust CLI.** All harness tooling ships as subcommands of `harnesscli`. No standalone shell scripts.
- **Every command has a test.** Tests live as `#[cfg(test)]` modules or under `harness/tests/`.
- **Worktree isolation.** All runtime resources (ports, temp dirs, data dirs, logs) are derived from a deterministic worktree ID.
- **No blind sleeps.** Readiness is healthcheck-based.
- **Portable.** This directory contains only instructions, templates, and reference artifacts. Any generated harness code still lives in the target repository.

## Directory Structure

```
create-harness/
├── SPEC.md                          # this file
├── harness-scaffolding-checklist.md # phase completion tracker
├── 1_harness_structure.md           # Phase 1 instructions
├── 2_execution-env-setup.md         # Phase 2 instructions
├── 3_observability-stack-setup.md   # Phase 3 instructions
├── 4_enforce-invariants.md          # Phase 4 instructions
├── 5_recurring-cleanup.md           # Phase 5 instructions
├── 6_ralph-loop.md                  # Phase 6 instructions
├── 7_implement-harness-audit.md     # Phase 7 instructions
├── references/                      # LLM-friendly docs and reference implementations
└── templates/                       # Template files (e.g. NON_NEGOTIABLE_RULES.md)
```

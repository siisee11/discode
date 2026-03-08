# Harness Scaffolding Checklist

Apply the following phases in order to scaffold a complete harness engineering system for this repository.

---

## Phase 1: Repository Documentation Structure

Apply the instructions in `harness_structure.md`.

This phase sets up the documentation hierarchy:

- [ ] `AGENTS.md` — compact table-of-contents entrypoint (~100 lines, navigation only)
- [ ] `ARCHITECTURE.md` — top-level map of domains, boundaries, dependencies, entrypoints
- [ ] `NON_NEGOTIABLE_RULES.md` — absolute rules that block merge unconditionally (use `create-harness/NON_NEGOTIABLE_RULES.md` as template)
- [ ] `docs/PLANS.md`
- [ ] `docs/design-docs/index.md`
- [ ] `docs/design-docs/core-beliefs.md` — product beliefs + agent-first operating principles (see `harness_structure.md`)
- [ ] `docs/exec-plans/active/`
- [ ] `docs/exec-plans/completed/`
- [ ] `docs/exec-plans/tech-debt-tracker.md`
- [ ] `docs/product-specs/index.md`
- [ ] `docs/references/`
- [ ] `docs/generated/`

Key rules:
- `AGENTS.md` is a navigation document, not a knowledge document. Move any substantive guidance into `docs/`.
- Real source of truth lives in `docs/` and top-level documents, not in `AGENTS.md`.
- Prefer many small, maintainable documents over one giant document.
- Documentation must reflect real code and real operating practices.
- **All harness tooling is a single Rust CLI** called `harnesscli`. Shell scripts are not allowed — implement all commands as subcommands of the `harnesscli` binary (e.g., `harnesscli smoke`, `harnesscli cleanup scan`, `harnesscli observability start`).
- **Every command must have a corresponding test.** Tests live alongside the Rust source as `#[cfg(test)]` modules or in integration test files under `harness/tests/`.

---

## Phase 2: Execution Environment Setup

Apply the instructions in `execution-env-setup.md`.

This phase makes the app bootable per Git worktree for isolated development:

- [ ] Worktree-aware boot flow with derived worktree ID
- [ ] Isolated runtime resources per worktree (ports, temp dirs, logs, etc.)
- [ ] Single command to boot the app for the current worktree
- [ ] Launch contract returning metadata (app URL, port, healthcheck status, worktree ID)
- [ ] Healthcheck-based readiness (no blind sleeps)
- [ ] `agent-browser` skill installed for UI investigation
- [ ] Example reproducibility and validation flow

---

## Phase 3: Observability Stack

Apply the instructions in `observability-stack-setup.md`.

This phase sets up ephemeral, per-worktree telemetry so the agent can query logs, metrics, and traces:

- [ ] Vector config template for telemetry collection and fan-out
- [ ] Victoria Logs — log storage with LogQL API
- [ ] Victoria Metrics — metrics storage with PromQL API
- [ ] Victoria Traces — trace storage with TraceQL API
- [ ] All ports and data dirs derived from worktree ID
- [ ] App instrumented with OpenTelemetry SDK (logs, metrics, traces to Vector)
- [ ] `harnesscli observability start` — starts the stack with health checks
- [ ] `harnesscli observability stop` — tears down the stack and cleans up
- [ ] `harnesscli observability query` — convenience wrapper for LogQL/PromQL/TraceQL queries
- [ ] Integrated with worktree app boot flow

---

## Phase 4: Enforce Invariants

Apply the instructions in `enforce-invariants.md`.

This phase enforces architectural boundaries and taste mechanically via custom linters and structural tests:

- [ ] Machine-readable architecture rules file (dependency directions, allowed edges)
- [ ] Dependency direction linter — verifies imports respect layer ordering
- [ ] Boundary parsing linter — verifies external data is validated at boundaries
- [ ] Taste invariant linters (structured logging, naming conventions, file size limits)
- [ ] Linter implementation is modularized by concern; avoid one monolithic `shared` helper
- [ ] All lint error messages include clear remediation instructions for agents
- [ ] Structural tests for domain completeness and dependency graph validation
- [ ] Cross-cutting boundary tests (shared concerns only via Providers interface)
- [ ] Integrated into `make lint` and `make test`

---

## Phase 5: Recurring Cleanup Process

Apply the instructions in `recurring-cleanup.md`.

This phase encodes golden principles and builds automated garbage collection for technical debt:

- [ ] `golden-principles.yaml` — machine-readable principle definitions with detection and remediation
- [ ] `harnesscli cleanup scan` — scans for violations, outputs JSON report
- [ ] `harnesscli cleanup grade` — computes and tracks quality grade
- [ ] `harnesscli cleanup fix` — generates focused, small cleanup PRs
- [ ] `.github/workflows/recurring-cleanup.yml` — daily scheduled scan, grade update, and PR generation
- [ ] `make scan` and `make grade` targets in `Makefile.harness`
- [ ] Error-severity violations integrated into `make lint`
- [ ] Quality grade tracked in `docs/generated/quality-grade.json`

---

## Phase 6: Harness Engineering Audit

Apply the instructions in `implement-harness-audit.md`.

This phase sets up deterministic build/test/lint workflows and the audit that verifies everything:

- [ ] `Makefile.harness` with smoke/test/lint/typecheck/check/ci targets
- [ ] `Makefile` includes `Makefile.harness`
- [ ] `harnesscli smoke` — fast sanity check
- [ ] `harnesscli test` — full test suite
- [ ] `harnesscli lint` — static analysis
- [ ] `harnesscli typecheck` — type checking
- [ ] `harnesscli audit` — audits all files and directories exist
- [ ] `harness/Cargo.toml` — Rust crate for the `harnesscli` CLI
- [ ] `.github/workflows/harness.yml` — CI workflow running `make ci`
- [ ] `harnesscli` CLI builds successfully (`cargo build --release -p harness`)
- [ ] `harness audit .` passes
- [ ] `make ci` succeeds

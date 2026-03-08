# Harness Scaffolding Checklist

Apply the following phases in order to scaffold a complete harness engineering system for this repository.

---

## Phase 1: Repository Documentation Structure

Apply the instructions in `harness_structure.md`.

This phase sets up the documentation hierarchy:

- [ ] `AGENTS.md` — compact table-of-contents entrypoint (~100 lines, navigation only)
- [ ] `ARCHITECTURE.md` — top-level map of domains, boundaries, dependencies, entrypoints
- [ ] `docs/PLANS.md`
- [ ] `docs/design-docs/index.md`
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
- **Every script must have a corresponding test.** When implementing a script in any phase, also write a test that verifies the script's behavior. Tests live in `tests/` mirroring the script path (e.g., `scripts/cleanup/scan.sh` → `tests/scripts/cleanup/scan.test.ts`).

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
- [ ] `scripts/observability/start.sh` — starts the stack with health checks
- [ ] `scripts/observability/stop.sh` — tears down the stack and cleans up
- [ ] `scripts/observability/query.sh` — convenience wrapper for LogQL/PromQL/TraceQL queries
- [ ] Integrated with worktree app boot flow

---

## Phase 4: Enforce Invariants

Apply the instructions in `enforce-invariants.md`.

This phase enforces architectural boundaries and taste mechanically via custom linters and structural tests:

- [ ] Machine-readable architecture rules file (dependency directions, allowed edges)
- [ ] Dependency direction linter — verifies imports respect layer ordering
- [ ] Boundary parsing linter — verifies external data is validated at boundaries
- [ ] Taste invariant linters (structured logging, naming conventions, file size limits)
- [ ] All lint error messages include clear remediation instructions for agents
- [ ] Structural tests for domain completeness and dependency graph validation
- [ ] Cross-cutting boundary tests (shared concerns only via Providers interface)
- [ ] Integrated into `make lint` and `make test`

---

## Phase 5: Recurring Cleanup Process

Apply the instructions in `recurring-cleanup.md`.

This phase encodes golden principles and builds automated garbage collection for technical debt:

- [ ] `golden-principles.yaml` — machine-readable principle definitions with detection and remediation
- [ ] `scripts/cleanup/scan.sh` — scans for violations, outputs JSON report
- [ ] `scripts/cleanup/grade.sh` — computes and tracks quality grade
- [ ] `scripts/cleanup/fix.sh` — generates focused, small cleanup PRs
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
- [ ] `scripts/harness/smoke.sh` — fast sanity check
- [ ] `scripts/harness/test.sh` — full test suite
- [ ] `scripts/harness/lint.sh` — static analysis
- [ ] `scripts/harness/typecheck.sh` — type checking
- [ ] `scripts/audit_harness.sh` — audits all files and directories exist
- [ ] `.github/workflows/harness.yml` — CI workflow running `make ci`
- [ ] All scripts are executable
- [ ] `scripts/audit_harness.sh .` passes
- [ ] `make ci` succeeds

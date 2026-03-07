# Harness Scaffolding Checklist

Apply the following two phases in order to scaffold a complete harness engineering system for this repository.

---

## Phase 1: Repository Documentation Structure

Apply the instructions in `harness_structure.md`.

This phase sets up the documentation hierarchy:

- [ ] `AGENTS.md` — compact table-of-contents entrypoint (~100 lines, navigation only)
- [ ] `ARCHITECTURE.md` — top-level map of domains, boundaries, dependencies, entrypoints
- [ ] `docs/PLANS.md`
- [ ] `docs/OBSERVABILITY.md`
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

---

## Phase 2: Harness Engineering Audit

Apply the instructions in `implement-harness-audit.md`.

This phase sets up deterministic build/test/lint workflows and the audit that verifies them:

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

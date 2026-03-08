# Non-Negotiable Rules

These rules are absolute. No exceptions, no workarounds, no "we'll fix it later." Every agent and every human must follow them on every change. Violations block merge unconditionally.

---

## Rule 1: 100% Test Coverage

Every line of code must be covered by tests. No exceptions.

- Every new function, method, module, and code path must have corresponding tests before it can be merged.
- If you change existing code, update or add tests to cover the change.
- Coverage is measured mechanically and enforced in CI. If coverage drops, the build fails.
- "It's too hard to test" is not an excuse — refactor the code until it is testable.
- Test coverage includes unit tests, integration tests, or both — whichever is appropriate for the code under test.
- Dead code that cannot be reached by tests must be deleted, not excluded from coverage.

### Why

Untested code is unverified code. In an agent-driven codebase, tests are the only reliable contract between what the code claims to do and what it actually does. Without full coverage, agents will build on top of broken assumptions, and bugs compound silently.

### Enforcement

- CI runs coverage analysis on every PR.
- PRs that reduce coverage below 100% are blocked from merging.
- The `harnesscli lint` and `harnesscli test` commands both verify coverage thresholds.
- Coverage reports are tracked in `docs/generated/coverage-report.json`.

# Implement Recurring Cleanup Process

Build a recurring, automated cleanup system that encodes golden principles into the repository and continuously enforces them. This functions like garbage collection for technical debt — human taste is captured once, then enforced continuously on every line of code.

The goal: on a regular cadence, background tasks scan for deviations from golden principles, update quality grades, and open targeted refactoring pull requests. Most of these PRs should be reviewable in under a minute and safe to automerge.

---

## Step 1: Define golden principles

Before building automation, codify the golden principles for this repository. These are opinionated, mechanical rules that keep the codebase legible and consistent for future agent runs.

Explore the codebase and define principles in a machine-readable file (`golden-principles.yaml` or similar). Each principle should have:

- **id**: Short identifier (e.g., `prefer-shared-utils`, `validate-boundaries`)
- **description**: What the principle enforces and why
- **detection**: How to find violations (grep pattern, AST rule, file structure check, etc.)
- **remediation**: What the fix looks like — specific enough for an agent to act on
- **severity**: `warn` or `error` — whether a violation blocks merge or just opens a cleanup PR
- **automerge**: Whether cleanup PRs for this principle are safe to automerge

Start with the following baseline principles and adapt to this project. The list should grow over time as new patterns are identified.

### Boundary and security principles (severity: error)

```yaml
principles:
  - id: validate-boundaries
    description: >
      Boundary modules must validate unknown input before it reaches internal code.
      Never probe data shapes by guessing — parse, don't probe.
    detection_kind: boundary-lint
    remediation: >
      Add a dedicated parser or validation guard at the ingress point and reject
      malformed input before routing it inward.
    severity: error
    automerge: false

  - id: parse-dont-probe
    description: >
      External and cross-boundary data must be parsed through a schema or validator,
      never accessed via unchecked property reads or type assertions.
    detection_kind: boundary-lint
    remediation: >
      Define a Zod schema (or equivalent parser) for the data shape and call
      .parse() or .safeParse() at the boundary. Remove bare `as` casts on unknown input.
    severity: error
    automerge: false

  - id: no-inline-secrets
    description: >
      Source files and docs must not contain real credentials or token-shaped secret values.
    detection_kind: secret-scan
    remediation: >
      Move the value into environment or config and keep examples obviously fake.
    severity: error
    automerge: false

  - id: structured-logging-only
    description: >
      All log calls must use the structured logger; never use raw console.log,
      console.warn, or console.error in production code.
    detection_kind: structured-logging
    remediation: >
      Replace the raw console call with the structured logger
      (e.g. `logger.info({ context, detail }, "message")`) and import from
      the project's logging module.
    severity: error
    automerge: false

  - id: test-coverage-for-new-code
    description: >
      New or modified modules must have corresponding test files;
      untested production code must not be merged.
    detection_kind: test-coverage
    remediation: >
      Add a test file covering the new or changed behavior.
    severity: error
    automerge: false
```

### Code quality principles (severity: warn)

```yaml
  - id: prefer-shared-utilities
    description: >
      Common operations (concurrency helpers, retry logic, date formatting,
      path manipulation) must use shared utilities rather than hand-rolled
      inline implementations. Keeps invariants centralized.
    detection_kind: duplicate-utility
    remediation: >
      Check the shared utility package for an existing helper. If none exists,
      add one there with tests rather than inlining a one-off implementation.
    severity: warn
    automerge: false

  - id: consistent-schema-naming
    description: >
      Zod schemas must be named with a Schema suffix and inferred types with
      the corresponding unsuffixed name (e.g. FooSchema / Foo).
    detection_kind: naming-convention
    remediation: >
      Rename the schema to end with Schema and export the inferred type as:
      `export type Foo = z.infer<typeof FooSchema>`.
    severity: warn
    automerge: true

  - id: no-wildcard-re-exports
    description: >
      Modules must not use `export *` which obscures the public API and makes
      dependency tracing harder for agents.
    detection_kind: naming-convention
    remediation: >
      Replace `export *` with explicit named exports so the module boundary is legible.
    severity: warn
    automerge: true

  - id: single-responsibility-imports
    description: >
      A source file must not import from more than three architectural layers;
      excessive cross-layer coupling signals a design problem.
    detection_kind: architecture-lint
    remediation: >
      Extract a facade or intermediate module to reduce the number of layer
      dependencies in a single file.
    severity: warn
    automerge: false

  - id: no-dead-code
    description: >
      Remove unused exports, unreachable branches, and stale feature flags.
      Dead code misleads agents into thinking it's still relevant.
    detection_kind: dead-code
    remediation: >
      Delete the dead code. If it was a public API, verify no external consumers exist first.
    severity: warn
    automerge: true

  - id: consistent-error-handling
    description: >
      All errors must be handled explicitly. No swallowed catches, no ignored rejections.
      Error paths must log structured context.
    detection_kind: error-handling
    remediation: >
      Add structured error logging with relevant context. If the error is intentionally
      ignored, add an explicit comment explaining why.
    severity: warn
    automerge: true

  - id: no-todo-outside-tests
    description: >
      Production code and docs must not accumulate untracked TODO placeholders.
    detection_kind: todo-scan
    remediation: >
      Remove the placeholder or move the follow-up into
      docs/exec-plans/tech-debt-tracker.md with a concrete next step.
    severity: warn
    automerge: true

  - id: shell-strict-mode
    description: >
      Harness shell scripts must run with strict mode enabled.
    detection_kind: shell-strict
    remediation: >
      Add `set -euo pipefail` near the top of the script.
    severity: warn
    automerge: true

  - id: keep-source-files-focused
    description: >
      Source and script files should stay small enough for an agent to
      understand quickly.
    detection_kind: file-size
    remediation: >
      Split oversized files into focused helpers and keep only the composition
      root in the top-level module.
    severity: warn
    automerge: true
```

Adapt the detection kinds to the project's language and tooling. Some detection kinds (like `boundary-lint`, `architecture-lint`, `todo-scan`, `shell-strict`, `file-size`) can be implemented as static scans. Others (like `structured-logging`, `naming-convention`, `duplicate-utility`, `test-coverage`, `dead-code`, `error-handling`) may require AST analysis or heuristic grep patterns.

---

## Step 2: Build the scanner

Implement the `harnesscli cleanup scan` subcommand that:

1. Reads the golden principles file
2. For each principle, runs the detection logic against the codebase
3. Outputs a structured report of all violations found

The report format should be JSON:

```json
{
  "timestamp": "2025-01-15T04:00:00Z",
  "violations": [
    {
      "principle_id": "prefer-shared-utils",
      "file": "src/billing/utils/formatCurrency.ts",
      "line": 12,
      "description": "Local formatCurrency duplicates shared/utils/currency.ts",
      "severity": "warn",
      "remediation": "Replace with import from @shared/utils/currency"
    }
  ],
  "summary": {
    "total": 5,
    "by_severity": { "warn": 4, "error": 1 },
    "by_principle": { "prefer-shared-utils": 2, "no-dead-code": 3 }
  }
}
```

The scanner should be fast — it runs frequently. Prefer static analysis (grep, AST parsing, import graph analysis) over runtime checks.

---

## Step 3: Build the quality grader

Implement the `harnesscli cleanup grade` subcommand that:

1. Runs the scanner
2. Computes a quality grade for the codebase based on violation counts and severities
3. Writes the grade to a trackable file (e.g., `docs/generated/quality-grade.json`)

The grade file should include:

```json
{
  "grade": "B+",
  "score": 87,
  "timestamp": "2025-01-15T04:00:00Z",
  "trend": "improving",
  "breakdown": {
    "prefer-shared-utils": { "violations": 2, "max_score": 15, "score": 11 },
    "validate-boundaries": { "violations": 0, "max_score": 25, "score": 25 },
    "no-dead-code": { "violations": 3, "max_score": 20, "score": 14 }
  },
  "previous": {
    "grade": "B",
    "score": 83,
    "timestamp": "2025-01-14T04:00:00Z"
  }
}
```

The grading formula should be configurable. Principles with `severity: error` should weigh more heavily than `warn`.

---

## Step 4: Build the cleanup PR generator

Implement the `harnesscli cleanup fix` subcommand that:

1. Runs the scanner to find violations
2. Groups violations by principle
3. For each group, creates a focused branch and applies the fix
4. Opens a pull request with:
   - Title: `cleanup(<principle_id>): <short description>`
   - Body: which principle was violated, what files were changed, and why
   - Label: `cleanup`, `automerge` (if the principle allows it)

Each PR should be small and focused — one principle, one logical group of fixes. The goal is PRs reviewable in under a minute.

The fix logic per principle can be:
- **Automated**: The command applies the fix directly (e.g., deleting dead code, replacing a local helper with a shared import)
- **Agent-assisted**: The command creates the branch with a description of what needs to change, and a coding agent completes the fix

Start with automated fixes for simple principles (dead code removal, import replacement) and agent-assisted for complex ones (boundary validation refactoring).

---

## Step 5: Set up the recurring schedule

### GitHub Actions workflow

Create `.github/workflows/recurring-cleanup.yml`:

```yaml
name: Recurring Cleanup

on:
  schedule:
    - cron: "0 4 * * *"  # Daily at 4am UTC
  workflow_dispatch:

jobs:
  scan-and-grade:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      # Add language/runtime setup steps needed for this repository.

      - name: Build harness CLI
        run: cargo build --release --manifest-path harness/Cargo.toml

      - name: Run scanner
        run: harness/target/release/harnesscli cleanup scan > scan-report.json

      - name: Update quality grade
        run: harness/target/release/harnesscli cleanup grade

      - name: Commit grade update
        run: |
          git config user.name "cleanup-bot"
          git config user.email "cleanup-bot@noreply"
          git add docs/generated/quality-grade.json
          git diff --cached --quiet || git commit -m "chore: update quality grade"
          git push

  open-cleanup-prs:
    needs: scan-and-grade
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      # Add language/runtime setup steps needed for this repository.

      - name: Build harness CLI
        run: cargo build --release --manifest-path harness/Cargo.toml

      - name: Generate cleanup PRs
        run: harness/target/release/harnesscli cleanup fix
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Customize the cron schedule for this project's cadence. Daily is a good default — frequent enough to catch drift early, not so frequent it creates noise.

---

## Step 6: Integrate with existing harness

- The scanner should also run as part of `make lint` — violations with `severity: error` should fail the build
- The quality grade should be checked in CI — if the grade drops below a configurable threshold, the build warns (or fails)
- Add `make scan` and `make grade` targets to `Makefile.harness`:

```makefile
scan: harness-build
	@$(HARNESS) cleanup scan

grade: harness-build
	@$(HARNESS) cleanup grade
```

---

## Step 7: Verify

1. Run `harnesscli cleanup scan` and confirm it produces a valid violation report
2. Run `harnesscli cleanup grade` and confirm it produces a quality grade
3. Intentionally introduce a violation and confirm the scanner catches it
4. Run `harnesscli cleanup fix` on a test branch and confirm it opens a well-formed PR
5. Confirm `make lint` fails on `severity: error` violations

---

## Deliverables

- [ ] `golden-principles.yaml` — machine-readable principle definitions
- [ ] `harnesscli cleanup scan` — scans for violations, outputs JSON report
- [ ] `harnesscli cleanup grade` — computes and writes quality grade
- [ ] `harnesscli cleanup fix` — generates focused cleanup PRs
- [ ] `.github/workflows/recurring-cleanup.yml` — daily scheduled workflow
- [ ] `make scan` and `make grade` targets in `Makefile.harness`
- [ ] Scanner integrated into `make lint` for error-severity violations
- [ ] Quality grade tracked in `docs/generated/quality-grade.json`

## Key principle

Technical debt is a high-interest loan. Pay it down continuously in small increments. Human taste is captured once in golden principles, then enforced continuously on every line of code. Catch bad patterns daily, not weekly.

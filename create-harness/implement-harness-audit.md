# Implement Harness Engineering Audit

You are setting up a **harness engineering** system for this repository. Harness engineering ensures that AI coding agents (and humans) can reliably build, test, lint, and verify a codebase through stable, deterministic, single-command workflows.

Your job is to create the harness artifacts, customize them for this repository, and verify everything passes the audit.

**Important**: The repository documentation structure (`AGENTS.md`, `ARCHITECTURE.md`, `docs/` hierarchy) may already exist from a prior step. Do NOT recreate them. Instead, ensure they contain the required sections for the audit to pass (see audit checks below) and merge any missing sections into the existing files.

---

## Step 1: Understand the repository

Before creating anything, explore the repository to determine:

- **Project type and runtime**: What language(s) and build tools does this project use?
- **Existing commands**: Are there existing build/test/lint/typecheck commands already defined?
- **Existing CI**: Is there a `.github/workflows/` directory with CI already configured?

Use this information to customize every artifact below for this specific project.

---

## Step 2: Create the harness files

Create the following files. If a file already exists, preserve its content and merge harness sections into it rather than overwriting.

### `Makefile.harness`

```makefile
HARNESS := harness/target/release/harnesscli

.PHONY: smoke test lint typecheck check ci harness-build

harness-build:
	@cargo build --release --manifest-path harness/Cargo.toml

smoke: harness-build
	@$(HARNESS) smoke

test: harness-build
	@$(HARNESS) test

lint: harness-build
	@$(HARNESS) lint

typecheck: harness-build
	@$(HARNESS) typecheck

check: lint typecheck

ci: smoke check test
```

Also ensure the main `Makefile` includes it. If no `Makefile` exists, create one with `-include Makefile.harness`. If one exists, append `-include Makefile.harness` if not already present.

### The `harnesscli` CLI

All harness tooling lives in a single Rust binary called `harnesscli`, located in `harness/` at the repository root. Create `harness/Cargo.toml` as the crate manifest.

Use `clap` (with derive macros) for subcommand routing and argument parsing, and `anyhow` for error handling. Organize the source into modules by command group:

```
harness/
├── Cargo.toml
└── src/
    ├── main.rs          # CLI entrypoint, clap App definition
    ├── cmd/
    │   ├── mod.rs
    │   ├── smoke.rs     # harnesscli smoke
    │   ├── test.rs      # harnesscli test
    │   ├── lint.rs      # harnesscli lint
    │   ├── typecheck.rs # harnesscli typecheck
    │   ├── audit.rs     # harnesscli audit
    │   ├── cleanup.rs   # harnesscli cleanup {scan,grade,fix}
    │   └── observability.rs  # harnesscli observability {start,stop,query}
    └── util/
        └── mod.rs       # shared helpers (worktree ID, process spawning, etc.)
```

Each command should support env var overrides via `std::env::var` and invoke external tools via `std::process::Command`.

### `harnesscli smoke`

The fastest possible sanity check — "does this project compile/build at all?" Should complete in seconds, not minutes. Use it to catch obvious breakage before running expensive checks.

Implement the appropriate smoke command for this project's language and build tooling. Support an optional `HARNESS_SMOKE_CMD` env var override — if set, run that command instead.

### `harnesscli test`

Runs the full test suite with no filters or exclusions. This is the comprehensive correctness check.

Implement the appropriate test command for this project. Support an optional `HARNESS_TEST_CMD` env var override.

### `harnesscli lint`

Runs static analysis and style checks. Should catch code quality issues, formatting problems, and common mistakes without executing code.

Implement the appropriate linter for this project. Support an optional `HARNESS_LINT_CMD` env var override.

### `harnesscli typecheck`

Runs type checking / compilation verification. Should catch type errors and interface mismatches.

Implement the appropriate type checker for this project. Support an optional `HARNESS_TYPECHECK_CMD` env var override.

### `harnesscli audit`

Audits the repo for harness compliance. It accepts an optional repo path argument (defaults to `.`). Performs two kinds of checks:

1. **File existence** — verify all required files exist (see audit checks reference table below)
2. **Directory existence** — verify all required directories exist (see audit checks reference table below)

For each check, print `[ok]` or `[missing]` with a descriptive label. At the end, if any checks failed, print the failure count and exit with a non-zero status. If all pass, print "Harness audit passed." and exit 0.

Use `std::path::Path::exists()` for file/directory checks.

### `.github/workflows/harness.yml`

```yaml
name: Harness CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  harness:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      # Add language/runtime setup steps needed for this repository.

      - name: Run harness pipeline
        run: make ci
```

Customize the workflow by adding the correct setup action for the detected project type.

---

## Step 3: Build the CLI

```sh
cargo build --release --manifest-path harness/Cargo.toml
```

---

## Step 4: Run the audit

Run `harnesscli audit .` and verify all checks pass. Fix any `[missing]` items until the output ends with:

```
Harness audit passed.
```

---

## Step 5: Verify harness commands work

Run each command and confirm it succeeds (or fails gracefully with clear output):

```bash
make smoke
make lint
make typecheck
make check
make test
make ci
```

Fix any commands that fail due to missing tools or incorrect detection.

---

## Audit checks reference

### File existence

| # | Check | Type |
|---|---|---|
| 1 | `AGENTS.md` exists | file |
| 2 | `ARCHITECTURE.md` exists | file |
| 3 | `NON_NEGOTIABLE_RULES.md` exists | file |
| 3 | `docs/PLANS.md` exists | file |
| 4 | `docs/design-docs/index.md` exists | file |
| 5 | `docs/exec-plans/tech-debt-tracker.md` exists | file |
| 6 | `docs/product-specs/index.md` exists | file |
| 7 | `Makefile.harness` exists | file |
| 8 | `harness/Cargo.toml` exists | file |
| 9 | `harnesscli` CLI builds successfully | build |
| 10 | `.github/workflows/harness.yml` exists | file |

### Directory existence

| # | Check | Type |
|---|---|---|
| 14 | `docs/design-docs/` exists | directory |
| 15 | `docs/exec-plans/active/` exists | directory |
| 16 | `docs/exec-plans/completed/` exists | directory |
| 17 | `docs/product-specs/` exists | directory |
| 18 | `docs/references/` exists | directory |
| 19 | `docs/generated/` exists | directory |


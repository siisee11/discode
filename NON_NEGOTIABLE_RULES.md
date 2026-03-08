# Non-Negotiable Rules

These rules block merge unconditionally. They are enforced through the harness, CI, and repository audits.

## Rule 1: The Harness Must Stay Green

Every change must leave the repository passing `make ci`.

- Do not merge with a failing `harnesscli smoke`, `lint`, `typecheck`, `test`, or `audit`.
- If a new tool or workflow is required, wire it into the harness instead of relying on manual knowledge.
- If the harness contract changes, update the canonical docs and the audit in the same change.

### Enforcement

- `make ci`
- `harnesscli audit .`
- `.github/workflows/harness.yml`

## Rule 2: Boundary Data Must Be Parsed Before Use

Unknown input from hooks, chat platforms, telemetry, browsers, files, or environment boundaries must be validated before internal code reads fields from it.

- Do not pass unchecked payloads into bridge, runtime, or policy code.
- Do not use bare shape guesses as a substitute for a boundary parser.
- If a boundary changes, update the matching validator rule and its tests.

### Enforcement

- `node scripts/linters/boundary-lint.mjs`
- `harnesscli cleanup scan --fail-on-error`
- `tests/structural/harness-architecture.test.ts`

## Rule 3: No Secrets in Repository Artifacts

Source files, scripts, docs, and generated artifacts must not contain real credentials or token-shaped secrets.

- Keep examples obviously fake.
- Move real credentials into environment or secret storage.
- Sanitizers and secret-handling helpers must remain in place when touching logging or diagnostics code.

### Enforcement

- `harnesscli cleanup scan --fail-on-error`
- `docs/SECURITY.md`

## Rule 4: Repository Knowledge Must Match the Code

If code, tooling, or operating practice changes, the canonical document for that topic must change in the same PR.

- `AGENTS.md` stays a navigation document only.
- Harness docs must describe the actual commands and files in the repo, not aspirational tooling.
- Durable multi-step work belongs in `docs/exec-plans/`.

### Enforcement

- `harnesscli audit .`
- `docs/design-docs/`
- `docs/operations/`

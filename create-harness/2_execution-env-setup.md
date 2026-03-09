Please implement the following platform improvements so our app can be reliably driven by Coding agent in isolated development environments and instrumented for browser-level validation.

## Goal

Make the app bootable per Git worktree so Coding agent can launch and operate one independent app instance per change/worktree. The agent uses the `agent-browser` skill for DOM snapshots, screenshots, and navigation. The end result should allow Coding agent to reproduce bugs, validate fixes, and reason about UI behavior directly from the running app.

## Outcomes we want

### 1. Per-worktree app booting

- Each Git worktree should be able to boot its own isolated app instance without conflicting with other worktrees.
- Coding agent should be able to launch the app for a given worktree automatically.
- Each instance should have its own derived runtime config where needed, such as ports, temp directories, cache directories, local storage paths, log files, and any other stateful resources.
- The startup flow should be deterministic and scriptable.

### 2. Skills for UI investigation

Install the `agent-browser` skill for browser-level UI investigation:

```sh
npx skills add vercel-labs/agent-browser --skill agent-browser
```

Use this skill for:

- Page navigation
- DOM snapshot capture
- Screenshot capture
- Basic page readiness/waiting behavior

These capabilities should be used for bug reproduction and validation workflows, not just generic browsing.

### 3. Bug reproduction and fix validation

Coding agent should be able to:

- Launch a worktree-specific app instance
- Open the relevant page in a browser
- Navigate through the app
- Inspect the DOM
- Take screenshots
- Verify whether the bug exists
- Apply or evaluate a fix
- Re-run the same flow to confirm the fix

## Requirements

### A. Worktree-aware boot architecture

Design and implement a worktree-aware app boot flow.

Expectations:

- Derive a stable worktree identifier from the current Git worktree.
- Use that identifier to isolate runtime resources.
- Avoid collisions across:
  - Dev server port
  - Websocket port
  - Temp files
  - Local databases or SQLite files if applicable
  - Logs
  - Browser profile / user data dir if applicable
- Provide a single command that boots the app for the current worktree.
- Prefer convention over manual configuration, but allow overrides through env vars.

Please include:

- The boot strategy
- How the worktree ID is computed
- How ports/resources are assigned
- How cleanup works
- Failure handling when a derived port/resource is already occupied

### B. Coding agent launch contract

Create a clear contract so Coding agent can launch one app instance per change/worktree.

Expectations:

- Provide a command or script intended for automation use.
- It should return enough metadata for downstream tooling, such as:
  - App URL
  - Selected port
  - Healthcheck status
  - Worktree ID
- Startup should block until the app is actually ready, or fail clearly.
- Add healthcheck logic rather than relying on blind sleeps.

### C. Environment initialization script (`init.sh`)

Create `scripts/harness/init.sh` — a single, idempotent script that prepares a clean, isolated environment for a coding agent to start working. This script is the foundation for the Ralph Loop's setup phase and can also be used standalone.

**Usage:**

```sh
scripts/harness/init.sh [--base-branch <branch>] [--work-branch <name>]
```

**The script must perform the following steps in order:**

1. **Create or reuse a git worktree**: If already inside a worktree, reuse it. Otherwise, create a new worktree using `git worktree add` from the specified base branch (default: `main`). Derive the worktree path using the same convention as `scripts/lib/worktree.sh`.

2. **Clean git state**: Inside the worktree, ensure a clean working tree. Stash any uncommitted changes. Create and checkout the work branch if specified.

3. **Install dependencies**: Run the project's package install command (detect `package.json` → `npm install`, `Cargo.toml` → `cargo build`, etc.). Fail clearly if install fails.

4. **Verify build**: Run `make smoke` if `Makefile.harness` exists, otherwise attempt the project's default build command. If the build fails, exit non-zero with a diagnostic message.

5. **Set up environment config**: If `.env.example` exists and `.env` does not, copy it. Set `DISCODE_WORKTREE_ID` and any other worktree-derived env vars.

6. **Create runtime directories**: Ensure `.worktree/<worktree_id>/logs/`, `.worktree/<worktree_id>/tmp/`, and other runtime dirs exist.

**Output contract:**

The script must print a JSON object to stdout on success:

```json
{
  "worktree_id": "<derived_id>",
  "worktree_path": "<absolute_path_to_worktree>",
  "work_branch": "<branch_name>",
  "base_branch": "<base_branch>",
  "deps_installed": true,
  "build_verified": true,
  "runtime_root": ".worktree/<worktree_id>/"
}
```

**Requirements:**

- Must be idempotent — running it twice on the same worktree is safe.
- Must use `set -euo pipefail` (shell strict mode).
- Must work from any directory (resolves repo root internally).
- Must not require interactive input.
- Exit code 0 on success, non-zero on any failure.
- All output except the final JSON goes to stderr so the JSON can be parsed from stdout.

**This script is reused by the Ralph Loop** (`ralph-loop.md`) as a deterministic replacement for the setup agent's environment preparation steps. The setup agent calls `init.sh` first, then only needs to create the execution plan.

### D. Reproducibility and validation flow

Implement an example flow or harness showing how Coding agent can use the system to:

- Boot a worktree-specific app
- Use the `agent-browser` skill to connect to the running app
- Navigate to a target page
- Collect DOM snapshot and screenshot
- Assert expected UI state
- Re-run after a code change to verify the fix

This can be a smoke-test-style script, example agent workflow, or documented end-to-end example.

## Deliverables

Please produce all of the following:

1. **Implementation**
   - Code changes for worktree-aware booting
   - `scripts/harness/init.sh` — environment initialization script with JSON output contract
   - Install and configure the `agent-browser` skill

2. **Design note**
   - Concise architecture explanation
   - Tradeoffs and assumptions
   - How isolation works per worktree

3. **Developer documentation**
   - How to run locally
   - How Coding agent should invoke it
   - Required environment variables
   - Troubleshooting notes

4. **Example workflow**
   - A concrete example showing bug reproduction and fix validation using the new system

## Non-goals

- Do not build a giant generic browser automation platform.
- Do not optimize for production browser telemetry yet.
- Focus on the minimum robust foundation needed for Coding agent-driven UI debugging and validation.

## Quality bar

- Deterministic and automation-friendly
- Minimal manual setup
- Clear failure modes
- Safe parallel usage across multiple worktrees
- Easy for an agent to reason about
- Well-structured enough to extend later

## Design questions to think through before implementing

- What is the best source of truth for worktree identity?
- How should derived ports be allocated to minimize collisions while staying predictable?
- What is the simplest reusable interface Coding agent can depend on?

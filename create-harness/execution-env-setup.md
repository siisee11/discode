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

```bash
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

### C. Reproducibility and validation flow

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

# Implement the Ralph Loop

Build a script that drives a coding agent through a complete task lifecycle in an automated loop. The script uses Codex app-server (via stdio JSON-RPC) to spawn and control agents. The name comes from the "Ralph Wiggum Loop" pattern: the agent keeps working until it declares the task complete.

## Overview

The Ralph Loop has three phases:

1. **Setup Agent** — Runs `init.sh` to prepare a clean worktree, explores the codebase, and creates an execution plan.
2. **Coding Agent Loop** — Iterates the coding agent with the user's prompt until the agent signals completion. Each iteration commits changes.
3. **PR Agent** — Reads the commits and completed plan, then opens a pull request.

```
┌─────────────────────────────────────────────────────────────────┐
│                         Ralph Loop                              │
│                                                                 │
│  ┌──────────┐    ┌────────────────────┐    ┌────────────┐       │
│  │  Setup   │───▶│  Coding Agent Loop │───▶│  PR Agent  │       │
│  │  Agent   │    │  (repeat until     │    │  (commits  │       │
│  │          │    │   COMPLETE)        │    │   → PR)    │       │
│  └──────────┘    └────────────────────┘    └────────────┘       │
│                                                                 │
│  runs init.sh    commit per iteration      commits → PR         │
│  explores repo   one milestone per turn                         │
│  creates plan    <promise>COMPLETE</promise> = done             │
│                  plan progress updated                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Interface

```
ralph-loop "<user prompt>" [options]
ralph-loop --prd [options]

Options:
  --model <model>          Codex model to use (default: gpt-5.3-codex)
  --base-branch <branch>   Branch to create the worktree from (default: main)
  --max-iterations <n>     Safety cap on coding loop iterations (default: 20)
  --work-branch <name>     Name for the working branch (default: ralph/<slugified-prompt>)
  --timeout <seconds>      Max wall-clock time for entire run (default: 21600 = 6h)
  --approval-policy <p>    Codex approval policy (default: never)
  --sandbox <policy>       Codex sandbox policy (default: workspace-write)
  --prd                    Read the task prompt from PRD.md at the repo root, then clear PRD.md
```

---

## Phase 1: Setup Agent

Spawn a Codex agent via app-server with the following task prompt. This agent runs once, not in a loop. It initializes the environment using `init.sh` and then creates an execution plan.

### Setup agent prompt

```
You are the setup agent for an automated coding loop. Prepare the environment and create an execution plan for the following task:

Task: {user_prompt}

Do the following steps in order:

1. **Initialize the environment**: Run `scripts/harness/init.sh --base-branch {base_branch} --work-branch {work_branch}`. This script creates a clean worktree, installs dependencies, verifies the build, and sets up environment config. It outputs JSON to stdout — capture and verify it succeeds. If it fails, diagnose the error and retry once. If it fails again, stop and report the error.

2. **Explore the codebase**: Read `AGENTS.md`, `ARCHITECTURE.md`, and any relevant docs to understand the project structure and conventions.

3. **Create execution plan**: Read `docs/PLANS.md` for the plan template. Create a new plan file at `docs/exec-plans/active/{slugified_task_name}.md` with the following structure:
   - **Goal / scope**: What the task accomplishes
   - **Background**: Why this work is needed
   - **Milestones**: Break the task into 3-7 concrete milestones. Each milestone should be completable in a single agent iteration.
   - **Current progress**: Mark all milestones as "not started"
   - **Key decisions**: Leave empty for now (the coding agent will fill this in)
   - **Remaining issues / open questions**: Any blockers or unknowns you identified during exploration
   - **Links to related documents**: Link to relevant docs discovered during exploration

4. **Commit the plan**: Stage and commit the plan file with message `plan: {short_task_description}`.

5. **Output the plan file path**: Print the absolute path to the plan file.

Output <promise>COMPLETE</promise> when done.
```

### Setup agent behavior

- Start a Codex app-server process via stdio.
- Send `initialize` → `initialized` → `thread/start` → `turn/start` with the setup prompt.
- Stream events and wait for `turn/completed`.
- Parse the plan file path from the agent's output.
- If the agent fails or the turn completes without `<promise>COMPLETE</promise>`, abort with an error.

---

## Phase 2: Coding Agent Loop

Spawn a new Codex thread for the coding agent. This thread persists across iterations — each iteration is a new turn on the same thread.

### Coding agent prompt (same prompt every iteration)

The same prompt is sent on every turn. The agent reads the plan file each time to determine current progress and what to do next.

```
You are a coding agent working in an automated loop. You will iterate until the task is fully complete.

## Task
{user_prompt}

## Execution plan
Read the plan at `{plan_file_path}` to understand the milestones and current progress. Pick up where the last iteration left off.

## Rules
- **One milestone per iteration.** Complete exactly one milestone, then stop. Do not work on multiple milestones in a single iteration. This keeps commits focused, progress trackable, and makes it easy to revert a single unit of work.
- Work through the milestones in the plan sequentially.
- After completing the milestone, update the plan file:
  - Mark the completed milestone as "done"
  - Update "current progress" with what you accomplished
  - Add any key decisions you made
  - Note any remaining issues
- Stage and commit ALL your changes (code + updated plan) with a descriptive commit message.
- If you encounter a blocker you cannot resolve, document it in the plan under "remaining issues" and commit what you have.

## Completion signal
When ALL milestones in the plan are complete and the task is fully done:
- Do a final update of the plan marking everything complete
- Commit all remaining changes
- Output <promise>COMPLETE</promise>

If there is still work to do after this iteration, do NOT output <promise>COMPLETE</promise>. You will get another iteration.
```

### Loop driver logic

The loop sends the exact same prompt on every iteration. The plan file on disk is the source of truth for progress — the agent reads it at the start of each turn to know where to pick up.

```
thread_id = start_thread()
iteration = 0
prompt = coding_agent_prompt  # same prompt every time

while iteration < max_iterations:
    iteration += 1

    turn_id = start_turn(thread_id, prompt)
    result = wait_for_turn_completion(thread_id, turn_id)

    if turn_failed(result):
        if iteration < max_iterations:
            # Send a recovery turn
            start_turn(thread_id, "The previous iteration failed. Check git status, review any errors, and try again. If the build is broken, fix it first.")
            continue
        else:
            abort("Max iterations reached with failures")

    agent_output = extract_agent_messages(result)

    if "<promise>COMPLETE</promise>" in agent_output:
        break

if iteration >= max_iterations:
    warn("Reached max iterations without completion signal")
```

### Key behaviors

- **Same thread, multiple turns**: Use a single Codex thread for the entire coding loop. Each iteration is a `turn/start` on the same `threadId`. This preserves conversation context across iterations.
- **Commit per iteration**: The agent is instructed to commit at the end of each iteration. The loop driver should verify a commit was made (check `git log`) and warn if the agent forgot.
- **Completion detection**: Scan the agent's text output (from `agentMessage` items in `item/completed` events) for the literal string `<promise>COMPLETE</promise>`.
- **Failure recovery**: If a turn completes with `status: "failed"`, send a recovery prompt on the next iteration rather than immediately aborting.
- **Context compaction**: If the thread approaches context limits (watch for `ContextWindowExceeded` errors), call `thread/compact/start` before the next turn.

---

## Phase 3: PR Agent

After the coding loop completes, spawn a separate Codex agent to create the pull request.

### PR agent prompt

```
You are a PR agent. Your job is to create a well-structured pull request from the work done on this branch.

## Instructions

1. **Read the completed plan**: Read `{plan_file_path}` to understand what was accomplished.

2. **Review the commits**: Run `git log {base_branch}..HEAD --oneline` to see all commits made during the coding loop.

3. **Review the diff**: Run `git diff {base_branch}...HEAD --stat` to see the scope of changes.

4. **Move the plan**: Move the plan from `docs/exec-plans/active/` to `docs/exec-plans/completed/`. Commit this move.

5. **Create the pull request**: Use `gh pr create` with:
   - **Title**: A concise title (under 70 characters) summarizing the change
   - **Body**: Use this format:
     ```
     ## Summary
     <2-4 bullet points summarizing what was done>

     ## Milestones completed
     <list from the plan>

     ## Key decisions
     <from the plan>

     ## Test plan
     <how to verify the changes>

     🤖 Generated with Ralph Loop
     ```

6. **Enable auto-merge**: Run `gh pr merge --auto --squash` to enable auto-merge. This tells GitHub to merge the PR automatically once all required status checks pass.

7. **Wait for CI and merge**: Poll the PR status until it is merged or fails:
   - Run `gh pr checks <pr_number> --watch` to wait for all CI checks to complete.
   - If all checks pass, auto-merge will complete automatically. Verify with `gh pr view <pr_number> --json state -q '.state'` — it should be `MERGED`.
   - If any check fails, report the failing check names and their output. Do NOT force-merge. Instead, output the failure details so a human or follow-up loop can address them.

8. **Output the PR URL and final status** (merged, or pending with failure details).

Output <promise>COMPLETE</promise> when done.
```

### PR agent behavior

- Start a new Codex app-server thread (separate from the coding thread).
- Send the PR prompt as a single turn.
- Wait for completion.
- Extract and return the PR URL from the agent's output.

---

## Codex App-Server Integration

The script communicates with Codex via the app-server stdio protocol. Reference `docs/references/codex-app-server-llm.txt` for the full API.

### Connection lifecycle

```
1. Spawn: codex app-server (stdio transport)
2. Send:  { "method": "initialize", "id": 0, "params": { "clientInfo": { "name": "ralph_loop", "title": "Ralph Loop", "version": "1.0.0" } } }
3. Send:  { "method": "initialized", "params": {} }
4. Send:  { "method": "thread/start", "id": 1, "params": { "model": "<model>", "cwd": "<worktree_path>", "approvalPolicy": "<policy>", "sandbox": "<sandbox>" } }
5. Read:  thread/started notification → extract threadId
6. Send:  { "method": "turn/start", "id": 2, "params": { "threadId": "<id>", "input": [{ "type": "text", "text": "<prompt>" }] } }
7. Read:  Stream item/* and turn/* notifications until turn/completed
8. Repeat step 6-7 for each iteration
```

Important wire-format note:

- `thread/start` uses the simple `sandbox` enum string, not an object.
- The accepted current values are `read-only`, `workspace-write`, and `danger-full-access`.
- Do not send camelCase names like `workspaceWrite` on the wire.
- The richer object form with `writableRoots` and `networkAccess` belongs to `turn/start` as `sandboxPolicy`, not to `thread/start`.

### Reading agent output

To detect `<promise>COMPLETE</promise>`, collect text from `agentMessage` items:

- On `item/completed` where `item.type == "agentMessage"`, read `item.text`.
- Concatenate all agent message texts from the turn.
- Search for the literal string `<promise>COMPLETE</promise>`.

### Sandbox policy

Use `workspace-write` with the worktree path as the writable root:

```json
{
  "type": "workspace-write",
  "writableRoots": ["<worktree_path>"],
  "networkAccess": true
}
```

Compatibility note:

- If the CLI accepts legacy aliases such as `readOnly`, `workspaceWrite`, or `dangerFullAccess`, normalize them before sending JSON-RPC requests.
- On the wire, always emit the kebab-case variants accepted by app-server.

### Error handling

- If `turn/completed` has `status: "failed"` with `codexErrorInfo: "ContextWindowExceeded"`, call `thread/compact/start` and retry.
- If app-server process exits unexpectedly, restart it and resume the thread with `thread/resume`.
- If a turn takes longer than a per-turn timeout (configurable, default 30 minutes), send `turn/interrupt` and retry.

---

## Implementation Notes

### Script structure

Implement as a Node.js script (TypeScript) under `scripts/ralph-loop/`:

```
scripts/ralph-loop/
├── ralph-loop.mts          # Main entry point, CLI argument parsing
├── lib/
│   ├── codex-client.mts    # App-server stdio client (spawn, send, receive)
│   ├── setup-agent.mts     # Phase 1 logic
│   ├── coding-loop.mts     # Phase 2 logic
│   ├── pr-agent.mts        # Phase 3 logic
│   ├── completion.mts      # <promise>COMPLETE</promise> detection
│   └── worktree.mts        # Calls init.sh, parses output, handles cleanup
```

A reference implementation is available under `create-harness/references/scripts/ralph-loop/`. Copy it into `scripts/ralph-loop/` as a starting point, then adapt it to the target repository's CLI, prompts, and verification flow.

### The codex-client module

This is the core integration. It should:

- Spawn `codex app-server` as a child process with stdio transport.
- Send JSON-RPC messages as newline-delimited JSON to stdin.
- Read JSON-RPC messages line-by-line from stdout.
- Track request IDs and resolve promises on matching responses.
- Emit events for notifications (turn/started, item/completed, etc.).
- Handle the full lifecycle: initialize → thread/start → turn/start → stream → turn/completed.

### Worktree management

- The setup agent calls `scripts/harness/init.sh` which handles worktree creation, dependency installation, and build verification.
- The loop driver parses the worktree path from the setup agent's output and sets `cwd` for subsequent Codex threads.
- Clean up the worktree after the PR is created (or on failure, with a flag to preserve for debugging).

### Logging

- Log all Codex events to a file under `.worktree/<worktree_id>/logs/ralph-loop.log`.
- Print high-level status to stdout: phase transitions, iteration counts, commit hashes, completion signal, PR URL.
- On failure, print the last N lines of the log for debugging.
- Treat log writes as best-effort only; logging must never crash the loop runner.
- Make client shutdown idempotent. The child process can still emit `stdout`, `stderr`, or `close` after shutdown begins.
- Guard against `write after end` by ignoring late log writes once the stream is ending or closed.

### Integration with harness

Add to `package.json`:

```json
{
  "ralph-loop": "npx tsx scripts/ralph-loop/ralph-loop.mts"
}
```

Add to `Makefile.harness`:

```makefile
ralph-loop:
	@npx tsx scripts/ralph-loop/ralph-loop.mts $(ARGS)
```

---

## Deliverables

- [ ] `scripts/ralph-loop/ralph-loop.mts` — main entry point with CLI parsing
- [ ] `scripts/ralph-loop/lib/codex-client.mts` — app-server stdio JSON-RPC client
- [ ] `scripts/ralph-loop/lib/setup-agent.mts` — Phase 1: environment prep + plan creation
- [ ] `scripts/ralph-loop/lib/coding-loop.mts` — Phase 2: iterative coding loop with completion detection
- [ ] `scripts/ralph-loop/lib/pr-agent.mts` — Phase 3: PR creation from commits + plan
- [ ] `scripts/ralph-loop/lib/completion.mts` — `<promise>COMPLETE</promise>` detection utility
- [ ] `scripts/ralph-loop/lib/worktree.mts` — parses worktree info from setup agent output, handles cleanup
- [ ] `package.json` script entry for `ralph-loop`
- [ ] `Makefile.harness` target for `ralph-loop`
- [ ] Tests for codex-client message parsing, completion detection, and prompt construction

---

## Verification

1. Run `ralph-loop "Add a health check endpoint that returns { status: 'ok', uptime: <seconds> }"` on the repository.
2. Confirm the setup agent creates a clean worktree, installs deps, and produces a plan.
3. Confirm the coding agent iterates, commits per iteration, and eventually outputs `<promise>COMPLETE</promise>`.
4. Confirm the PR agent opens a well-formed PR with the plan summary.
5. Confirm the worktree is cleaned up after completion.

---

## Key Principles

- **One milestone per iteration.** The agent completes exactly one milestone per loop turn. This keeps commits atomic, diffs reviewable, and makes it trivial to revert a single unit of work.
- **The agent works until it's done.** The loop only breaks on `<promise>COMPLETE</promise>` or the safety cap.
- **Every iteration leaves a commit.** Progress is never lost, and the PR agent can reconstruct the full story from the commit history.
- **The plan is the shared state.** The plan file is the coordination artifact between the setup agent, coding agent, and PR agent. It's also a durable record in the repository.
- **Same thread for the coding loop.** Using one thread with multiple turns preserves context and lets the agent build on its own prior work.
- **Separate threads for separate roles.** Setup, coding, and PR agents each get their own thread to keep concerns isolated.

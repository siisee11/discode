import { basename } from 'node:path';

export interface SetupPromptOptions {
  userPrompt: string;
  planPath: string;
  worktreePath: string;
  worktreeId: string;
  workBranch: string;
  baseBranch: string;
}

export interface CodingPromptOptions {
  userPrompt: string;
  planPath: string;
}

export interface PrPromptOptions {
  planPath: string;
  baseBranch: string;
}

export function slugifyPrompt(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return slug || 'task';
}

export function defaultPlanFilename(prompt: string): string {
  return `${slugifyPrompt(prompt).slice(0, 80)}.md`;
}

export function buildSetupPrompt(options: SetupPromptOptions): string {
  return `You are the setup agent for an automated coding loop. The worktree environment is already initialized.

Task: ${options.userPrompt}

Prepared environment:
- Worktree path: ${options.worktreePath}
- Worktree ID: ${options.worktreeId}
- Working branch: ${options.workBranch}
- Base branch: ${options.baseBranch}

Do the following steps in order:

1. Read AGENTS.md, ARCHITECTURE.md, docs/PLANS.md, and any other relevant repository docs needed to understand the task.
2. Create an execution plan at ${options.planPath} using the checked-in plan structure:
   - Goal / scope
   - Background
   - Milestones
   - Current progress
   - Key decisions
   - Remaining issues / open questions
   - Links to related documents
3. Break the work into 3-7 concrete milestones, each small enough for one coding-loop iteration.
4. Mark every milestone as not started.
5. Stage and commit the new plan with message: plan: ${basename(options.planPath, '.md')}
6. Print the absolute plan file path.

Output ${'<promise>COMPLETE</promise>'} when done.`;
}

export function buildCodingPrompt(options: CodingPromptOptions): string {
  return `You are a coding agent working in an automated loop. You will iterate until the task is fully complete.

## Task
${options.userPrompt}

## Execution plan
Read the plan at ${options.planPath} to understand the milestones and current progress. Pick up where the last iteration left off.

## Rules
- One milestone per iteration. Complete exactly one milestone, then stop.
- Work through milestones sequentially.
- After completing the milestone, update the plan file with progress, decisions, and remaining issues.
- Stage and commit all changes from the iteration, including the plan update.
- If blocked, document the blocker in the plan and commit the current state.

## Completion signal
When all milestones are done:
- Perform the final plan update.
- Commit all remaining changes.
- Output ${'<promise>COMPLETE</promise>'}.

If work remains after this iteration, do not output the completion token.`;
}

export function buildRecoveryPrompt(planPath: string): string {
  return `The previous iteration failed. Review the current git state, inspect the last errors, repair the workspace, and continue from the plan at ${planPath}. Commit the recovery work before stopping.`;
}

export function buildPrPrompt(options: PrPromptOptions): string {
  return `You are a PR agent. Create a pull request for the completed work on this branch.

Instructions:
1. Read the completed plan at ${options.planPath}.
2. Review commits with git log ${options.baseBranch}..HEAD --oneline.
3. Review scope with git diff ${options.baseBranch}...HEAD --stat.
4. Move the plan from docs/exec-plans/active/ to docs/exec-plans/completed/ and commit that move.
5. Create a pull request with:
   - Title: concise, under 70 characters
   - Body:
     ## Summary
     <2-4 bullet points>

     ## Milestones completed
     <from the plan>

     ## Key decisions
     <from the plan>

     ## Test plan
     <how to verify>

     Generated with Ralph Loop
6. Enable auto-merge with gh pr merge --auto --squash.
7. Wait for CI with gh pr checks --watch and report whether the PR merged.
8. Print the PR URL and final status.

Output ${'<promise>COMPLETE</promise>'} when done.`;
}

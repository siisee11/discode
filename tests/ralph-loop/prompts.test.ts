import { describe, expect, it } from 'vitest';

import {
  buildCodingPrompt,
  buildPrPrompt,
  buildSetupPrompt,
  defaultPlanFilename,
} from '../../scripts/ralph-loop/lib/prompts.mts';

describe('ralph loop prompts', () => {
  it('builds a stable default plan filename', () => {
    expect(defaultPlanFilename('Add health check endpoint')).toBe('add-health-check-endpoint.md');
  });

  it('builds the setup prompt with the plan path and completion token', () => {
    const prompt = buildSetupPrompt({
      userPrompt: 'Add health checks',
      planPath: '/repo/docs/exec-plans/active/add-health-checks.md',
      worktreePath: '/repo-worktrees/add-health-checks',
      worktreeId: 'repo-123',
      workBranch: 'ralph/add-health-checks',
      baseBranch: 'main',
    });
    expect(prompt).toContain('/repo/docs/exec-plans/active/add-health-checks.md');
    expect(prompt).toContain('<promise>COMPLETE</promise>');
  });

  it('builds the coding prompt with the one-milestone rule', () => {
    const prompt = buildCodingPrompt({
      userPrompt: 'Add health checks',
      planPath: '/repo/docs/exec-plans/active/add-health-checks.md',
    });
    expect(prompt).toContain('One milestone per iteration');
    expect(prompt).toContain('/repo/docs/exec-plans/active/add-health-checks.md');
  });

  it('builds the pr prompt with the required PR checklist', () => {
    const prompt = buildPrPrompt({
      planPath: '/repo/docs/exec-plans/active/add-health-checks.md',
      baseBranch: 'main',
    });
    expect(prompt).toContain('gh pr merge --auto --squash');
    expect(prompt).toContain('git log main..HEAD --oneline');
  });
});

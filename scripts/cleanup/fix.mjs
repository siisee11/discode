import { execFileSync } from 'node:child_process';

import { loadPrinciples, detectViolationsForPrinciple } from './shared.mjs';

const apply = process.env.CLEANUP_APPLY === '1';
const enablePrs = process.env.CLEANUP_OPEN_PRS === '1';

const groups = loadPrinciples()
  .map((principle) => ({
    principle,
    violations: detectViolationsForPrinciple(principle),
  }))
  .filter((group) => group.violations.length > 0);

if (groups.length === 0) {
  process.stdout.write('No cleanup violations found.\n');
  process.exit(0);
}

for (const group of groups) {
  const branchName = `cleanup/${group.principle.id}`;
  const summary = {
    principle_id: group.principle.id,
    violations: group.violations.length,
    automerge: group.principle.automerge,
    branch: branchName,
    remediation: group.principle.remediation,
  };

  process.stdout.write(`${JSON.stringify(summary)}\n`);

  if (!apply) continue;

  execFileSync('git', ['checkout', '-b', branchName], { stdio: 'inherit' });

  if (enablePrs) {
    const body = [
      `Principle: ${group.principle.id}`,
      `Violations: ${group.violations.length}`,
      '',
      group.principle.remediation,
    ].join('\n');

    execFileSync('gh', [
      'pr',
      'create',
      '--title',
      `cleanup(${group.principle.id}): resolve detected violations`,
      '--body',
      body,
      '--label',
      'cleanup',
    ], { stdio: 'inherit' });
  }
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadArchitectureRules, repoRoot } from './rules.mjs';

export function scanBoundaryViolations() {
  const rules = loadArchitectureRules();
  const violations = [];

  for (const rule of rules.boundaryValidators) {
    const absolutePath = resolve(repoRoot, rule.file);
    const content = readFileSync(absolutePath, 'utf8');
    const missingAll = (rule.mustContainAll || []).filter((token) => !content.includes(token));
    const hasAny = (rule.mustContainAny || []).some((token) => content.includes(token));

    const failedAll = missingAll.length > 0;
    const failedAny = rule.mustContainAny && !hasAny;
    if (!failedAll && !failedAny) continue;

    violations.push({
      file: rule.file,
      message: [
        `${rule.file} is missing the required boundary parsing guard.`,
        `Fix: ${rule.remediation}`,
      ].join('\n'),
    });
  }

  return violations;
}

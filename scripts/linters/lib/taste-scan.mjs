import { readFileSync } from 'node:fs';

import { collectConventionFiles, fileExtension, toRepoPath } from './files.mjs';
import { loadArchitectureRules } from './rules.mjs';

export function scanTasteViolations() {
  const rules = loadArchitectureRules();
  const files = collectConventionFiles();
  const violations = [];

  for (const absolutePath of files) {
    const repoPath = toRepoPath(absolutePath);
    const content = readFileSync(absolutePath, 'utf8');
    const lineCount = content.split('\n').length;
    const extension = fileExtension(absolutePath);

    if (repoPath.startsWith('src/') && extension === '.ts' && lineCount > rules.conventions.maxSourceLines) {
      violations.push({
        file: repoPath,
        message: [
          `${repoPath} has ${lineCount} lines.`,
          `Rule: source files must stay at or below ${rules.conventions.maxSourceLines} lines.`,
          'Fix: split the module into smaller focused units and keep only the composition root in this file.',
        ].join('\n'),
      });
    }

    if (repoPath.startsWith('scripts/') && lineCount > rules.conventions.maxScriptLines) {
      violations.push({
        file: repoPath,
        message: [
          `${repoPath} has ${lineCount} lines.`,
          `Rule: script files must stay at or below ${rules.conventions.maxScriptLines} lines.`,
          'Fix: extract shared helpers into scripts/lib or a focused companion module.',
        ].join('\n'),
      });
    }

    if (
      rules.conventions.forbidTodoOutsideTests &&
      !repoPath.startsWith('tests/') &&
      (
        (repoPath.endsWith('.md') && /(^|\n)\s*(TODO|FIXME|XXX)\b/m.test(content)) ||
        (!repoPath.endsWith('.md') && /(^|\n)\s*(\/\/|#|\/\*+|\*)\s*(TODO|FIXME|XXX)\b/m.test(content))
      )
    ) {
      violations.push({
        file: repoPath,
        message: [
          `${repoPath} contains TODO-style placeholders.`,
          'Rule: repository guidance and production code must point to a tracked issue or be fixed immediately.',
          'Fix: remove the placeholder or move the follow-up into docs/exec-plans/tech-debt-tracker.md with a concrete next step.',
        ].join('\n'),
      });
    }

    if (
      /\.(sh)$/.test(repoPath) &&
      (repoPath.startsWith('scripts/harness/') || repoPath.startsWith('scripts/observability/') || repoPath.startsWith('scripts/cleanup/')) &&
      !content.includes('set -euo pipefail')
    ) {
      violations.push({
        file: repoPath,
        message: [
          `${repoPath} is missing shell strict mode.`,
          'Rule: harness shell scripts must use `set -euo pipefail`.',
          'Fix: add `set -euo pipefail` near the top of the script before executing commands.',
        ].join('\n'),
      });
    }
  }

  return violations;
}

import { readFileSync } from 'node:fs';

import { collectSourceFiles, detectLayer, toRepoPath } from './files.mjs';
import { parseImports, resolveLocalImport } from './imports.mjs';
import { loadArchitectureRules } from './rules.mjs';

export function scanArchitectureViolations() {
  const rules = loadArchitectureRules();
  const files = collectSourceFiles();
  const violations = [];

  for (const absolutePath of files) {
    const repoPath = toRepoPath(absolutePath);
    const fromLayer = detectLayer(repoPath, rules);
    if (!fromLayer) continue;

    const content = readFileSync(absolutePath, 'utf8');
    for (const specifier of parseImports(content)) {
      const resolved = resolveLocalImport(absolutePath, specifier);
      if (!resolved) continue;

      const targetPath = toRepoPath(resolved);
      const toLayer = detectLayer(targetPath, rules);
      if (!toLayer || toLayer === fromLayer) continue;

      const disallowed = rules.disallowed.find((rule) => rule.from === fromLayer && rule.to === toLayer);
      if (!disallowed) continue;

      violations.push({
        file: repoPath,
        dependency: targetPath,
        message: [
          `${repoPath} imports ${targetPath}.`,
          `Rule: ${disallowed.rule}`,
          `Fix: ${disallowed.remediation}`,
        ].join('\n'),
      });
    }
  }

  return violations;
}

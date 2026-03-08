import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, relative, resolve, dirname } from 'node:path';

export const repoRoot = resolve(import.meta.dirname, '..', '..');
const architectureRulesPath = resolve(repoRoot, 'docs/generated/architecture-rules.json');

export function loadArchitectureRules() {
  return JSON.parse(readFileSync(architectureRulesPath, 'utf8'));
}

export function walkFiles(rootDir, predicate) {
  const results = [];

  function visit(currentDir) {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git' || entry.name === '.worktree') {
        continue;
      }

      const fullPath = resolve(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }

      if (predicate(fullPath)) {
        results.push(fullPath);
      }
    }
  }

  visit(rootDir);
  return results;
}

export function toRepoPath(absolutePath) {
  return relative(repoRoot, absolutePath).replace(/\\/g, '/');
}

export function detectLayer(repoPath, rules) {
  const matched = rules.layers
    .filter((layer) => layer.prefixes.some((prefix) => repoPath.startsWith(prefix)))
    .sort((a, b) => {
      const maxA = Math.max(...a.prefixes.map((prefix) => prefix.length));
      const maxB = Math.max(...b.prefixes.map((prefix) => prefix.length));
      return maxB - maxA;
    })[0];

  return matched?.name;
}

export function collectSourceFiles() {
  return walkFiles(repoRoot, (fullPath) => {
    const repoPath = toRepoPath(fullPath);
    return (
      /\.(ts|tsx|js|mjs|cjs)$/.test(fullPath) &&
      (repoPath.startsWith('src/') || repoPath.startsWith('bin/') || repoPath.startsWith('workers/telemetry-proxy/src/'))
    );
  });
}

export function collectConventionFiles() {
  return walkFiles(repoRoot, (fullPath) => {
    const repoPath = toRepoPath(fullPath);
    const inOwnedSurface =
      repoPath.startsWith('src/') ||
      repoPath.startsWith('bin/') ||
      repoPath.startsWith('scripts/') ||
      repoPath.startsWith('docs/') ||
      repoPath.startsWith('site/') ||
      repoPath.startsWith('workers/telemetry-proxy/src/') ||
      repoPath.startsWith('tests/');

    return inOwnedSurface && /\.(ts|tsx|js|mjs|cjs|sh|md)$/.test(fullPath);
  });
}

export function parseImports(fileContent) {
  const imports = new Set();
  const patterns = [
    /import\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /export\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
  ];

  for (const pattern of patterns) {
    for (const match of fileContent.matchAll(pattern)) {
      imports.add(match[1]);
    }
  }

  return [...imports];
}

export function resolveLocalImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;

  const basePath = resolve(dirname(fromFile), specifier);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    resolve(basePath, 'index.ts'),
    resolve(basePath, 'index.tsx'),
    resolve(basePath, 'index.js'),
    resolve(basePath, 'index.mjs'),
    resolve(basePath, 'index.cjs'),
  ];

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

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

export function scanTasteViolations() {
  const rules = loadArchitectureRules();
  const files = collectConventionFiles();
  const violations = [];

  for (const absolutePath of files) {
    const repoPath = toRepoPath(absolutePath);
    const content = readFileSync(absolutePath, 'utf8');
    const lineCount = content.split('\n').length;
    const extension = extname(absolutePath);

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

export function requiredDirectoriesMissing() {
  const rules = loadArchitectureRules();
  return rules.requiredDirectories.filter((dir) => {
    try {
      return !statSync(resolve(repoRoot, dir)).isDirectory();
    } catch {
      return true;
    }
  });
}

export function printViolations(title, violations) {
  if (violations.length === 0) return;
  console.error(`\n${title}`);
  for (const violation of violations) {
    console.error(`- ${violation.file}`);
    console.error(violation.message);
  }
}

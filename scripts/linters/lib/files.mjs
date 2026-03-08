import { readdirSync, statSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';

import { loadArchitectureRules, repoRoot } from './rules.mjs';

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

export function detectLayer(repoPath, rules = loadArchitectureRules()) {
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

export function fileExtension(filePath) {
  return extname(filePath);
}

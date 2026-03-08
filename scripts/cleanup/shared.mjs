import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { collectConventionFiles, repoRoot, scanBoundaryViolations, scanTasteViolations, toRepoPath } from '../linters/shared.mjs';

const principlesPath = resolve(repoRoot, 'golden-principles.yaml');

function stripQuotes(value) {
  return value.replace(/^['"]|['"]$/g, '');
}

export function loadPrinciples() {
  const lines = readFileSync(principlesPath, 'utf8').split('\n');
  const principles = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#') || line.trim() === 'principles:') continue;

    if (line.startsWith('  - ')) {
      if (current) principles.push(current);
      current = {};
      const [, rest] = line.split('- ', 2);
      const [key, value] = rest.split(':', 2);
      current[key.trim()] = stripQuotes(value.trim());
      continue;
    }

    if (!current) continue;

    const trimmed = line.trim();
    const [key, value] = trimmed.split(':', 2);
    current[key.trim()] = stripQuotes((value || '').trim());
  }

  if (current) principles.push(current);
  return principles.map((principle) => ({
    ...principle,
    automerge: principle.automerge === 'true',
  }));
}

function scanSecretViolations() {
  const files = collectConventionFiles().filter((file) => {
    const repoPath = toRepoPath(file);
    return (
      !repoPath.startsWith('tests/') &&
      !repoPath.startsWith('docs/') &&
      !repoPath.startsWith('.worktree/')
    );
  });
  const patterns = [
    /\bghp_[A-Za-z0-9]{20,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bsk_live_[A-Za-z0-9]{10,}\b/g,
  ];
  const violations = [];

  for (const file of files) {
    const repoPath = toRepoPath(file);
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      const isSanitizerExample =
        line.includes('TOKEN_PREFIXES') ||
        line.includes('maskToken(') ||
        line.includes('prefix +') ||
        line.includes('***');

      if (!isSanitizerExample && patterns.some((pattern) => pattern.test(line))) {
        violations.push({
          file: repoPath,
          line: index + 1,
          description: 'Found token-shaped secret material.',
        });
      }
    });
  }

  return violations;
}

export function detectViolationsForPrinciple(principle) {
  const tasteViolations = scanTasteViolations();

  switch (principle.detection_kind) {
    case 'boundary-lint':
      return scanBoundaryViolations().map((violation) => ({
        file: violation.file,
        description: violation.message.split('\n')[0],
      }));
    case 'secret-scan':
      return scanSecretViolations();
    case 'todo-scan':
      return tasteViolations
        .filter((violation) => violation.message.includes('TODO-style placeholders'))
        .map((violation) => ({ file: violation.file, description: 'Found TODO-style placeholder.' }));
    case 'shell-strict':
      return tasteViolations
        .filter((violation) => violation.message.includes('shell strict mode'))
        .map((violation) => ({ file: violation.file, description: 'Harness shell script is missing strict mode.' }));
    case 'file-size':
      return tasteViolations
        .filter((violation) => violation.message.includes('has') && violation.message.includes('lines'))
        .map((violation) => ({ file: violation.file, description: 'File exceeds the configured harness size limit.' }));
    default:
      return [];
  }
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const architectureRulesPath = resolve(repoRoot, 'docs/generated/architecture-rules.json');

export function loadArchitectureRules() {
  return JSON.parse(readFileSync(architectureRulesPath, 'utf8'));
}

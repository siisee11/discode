import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { repoRoot } from '../linters/shared.mjs';
import { loadPrinciples, detectViolationsForPrinciple } from './shared.mjs';

const outputPath = resolve(repoRoot, 'docs/generated/quality-grade.json');
const previous = existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, 'utf8')) : null;
const principles = loadPrinciples();
const timestamp = new Date().toISOString();

const breakdown = {};
let score = 100;

for (const principle of principles) {
  const violations = detectViolationsForPrinciple(principle);
  const penaltyPerViolation = principle.severity === 'error' ? 20 : 5;
  const maxScore = principle.severity === 'error' ? 25 : 15;
  const principleScore = Math.max(0, maxScore - violations.length * penaltyPerViolation);
  breakdown[principle.id] = {
    violations: violations.length,
    max_score: maxScore,
    score: principleScore,
  };
  score -= violations.length * penaltyPerViolation;
}

score = Math.max(0, score);

function toGrade(nextScore) {
  if (nextScore >= 97) return 'A+';
  if (nextScore >= 93) return 'A';
  if (nextScore >= 90) return 'A-';
  if (nextScore >= 87) return 'B+';
  if (nextScore >= 83) return 'B';
  if (nextScore >= 80) return 'B-';
  if (nextScore >= 77) return 'C+';
  if (nextScore >= 73) return 'C';
  if (nextScore >= 70) return 'C-';
  return 'D';
}

const payload = {
  grade: toGrade(score),
  score,
  timestamp,
  trend: !previous ? 'new' : score > previous.score ? 'improving' : score < previous.score ? 'declining' : 'steady',
  breakdown,
  previous: previous
    ? {
        grade: previous.grade,
        score: previous.score,
        timestamp: previous.timestamp,
      }
    : null,
};

writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

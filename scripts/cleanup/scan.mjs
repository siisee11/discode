import { loadPrinciples, detectViolationsForPrinciple } from './shared.mjs';

const failOnError = process.argv.includes('--fail-on-error');
const principles = loadPrinciples();
const timestamp = new Date().toISOString();

const violations = principles.flatMap((principle) =>
  detectViolationsForPrinciple(principle).map((violation) => ({
    principle_id: principle.id,
    file: violation.file,
    line: violation.line ?? null,
    description: violation.description,
    severity: principle.severity,
    remediation: principle.remediation,
  })),
);

const report = {
  timestamp,
  violations,
  summary: {
    total: violations.length,
    by_severity: violations.reduce((acc, violation) => {
      acc[violation.severity] = (acc[violation.severity] || 0) + 1;
      return acc;
    }, {}),
    by_principle: violations.reduce((acc, violation) => {
      acc[violation.principle_id] = (acc[violation.principle_id] || 0) + 1;
      return acc;
    }, {}),
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (failOnError && violations.some((violation) => violation.severity === 'error')) {
  process.exit(1);
}

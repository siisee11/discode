export function printViolations(title, violations) {
  if (violations.length === 0) return;
  console.error(`\n${title}`);
  for (const violation of violations) {
    console.error(`- ${violation.file}`);
    console.error(violation.message);
  }
}

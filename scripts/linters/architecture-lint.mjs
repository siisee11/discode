#!/usr/bin/env node
import { printViolations, scanArchitectureViolations } from './shared.mjs';

const violations = scanArchitectureViolations();
printViolations('Architecture violations', violations);
process.exit(violations.length === 0 ? 0 : 1);

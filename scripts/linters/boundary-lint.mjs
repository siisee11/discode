#!/usr/bin/env node
import { printViolations, scanBoundaryViolations } from './shared.mjs';

const violations = scanBoundaryViolations();
printViolations('Boundary validation violations', violations);
process.exit(violations.length === 0 ? 0 : 1);

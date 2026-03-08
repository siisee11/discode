#!/usr/bin/env node
import { printViolations, scanTasteViolations } from './shared.mjs';

const violations = scanTasteViolations();
printViolations('Taste invariant violations', violations);
process.exit(violations.length === 0 ? 0 : 1);

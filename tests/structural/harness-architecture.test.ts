import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  repoRoot,
  requiredDirectoriesMissing,
  scanArchitectureViolations,
  scanBoundaryViolations,
  scanTasteViolations,
} from '../../scripts/linters/shared.mjs';

describe('harness architecture rules', () => {
  it('keeps required domain directories in place', () => {
    expect(requiredDirectoriesMissing()).toEqual([]);
  });

  it('has no forbidden cross-layer imports', () => {
    expect(scanArchitectureViolations()).toEqual([]);
  });

  it('keeps boundary validators in the canonical ingress files', () => {
    expect(scanBoundaryViolations()).toEqual([]);
  });

  it('keeps repository taste rules green', () => {
    expect(scanTasteViolations()).toEqual([]);
  });

  it('tracks architecture rules in the generated docs area', () => {
    expect(existsSync(resolve(repoRoot, 'docs/generated/architecture-rules.json'))).toBe(true);
  });
});

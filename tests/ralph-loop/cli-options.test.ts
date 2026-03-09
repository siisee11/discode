import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseArgs } from '../../scripts/ralph-loop/lib/cli-options.mts';

describe('ralph loop cli options', () => {
  it('builds the default work branch from a positional prompt', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ralph-loop-cli-'));

    const options = parseArgs(['ship native attach'], repoRoot);

    expect(options.prompt).toBe('ship native attach');
    expect(options.workBranch).toBe('ralph/ship-native-attach');
  });

  it('reads the prompt from PRD.md and clears the file', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ralph-loop-prd-'));
    const prdPath = join(repoRoot, 'PRD.md');
    writeFileSync(prdPath, 'Finish pty rust replacement rollout\n');

    const options = parseArgs(['--prd'], repoRoot);

    expect(options.prompt).toBe('Finish pty rust replacement rollout');
    expect(readFileSync(prdPath, 'utf8')).toBe('');
    expect(options.workBranch).toBe('ralph/finish-pty-rust-replacement-rollout');
  });

  it('rejects mixing --prd with a positional prompt', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ralph-loop-prd-mixed-'));
    writeFileSync(join(repoRoot, 'PRD.md'), 'Finish rollout');

    expect(() => parseArgs(['native attach', '--prd'], repoRoot)).toThrow(
      'Use either a positional prompt or --prd, not both',
    );
  });

  it('fails when PRD.md is empty', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ralph-loop-prd-empty-'));
    writeFileSync(join(repoRoot, 'PRD.md'), ' \n');

    expect(() => parseArgs(['--prd'], repoRoot)).toThrow(/PRD file is empty/);
  });
});

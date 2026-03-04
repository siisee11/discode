import { describe, expect, it } from 'vitest';
import { buildCliErrorGuide, formatCliError } from '../../../src/cli/common/error-guide.js';

describe('buildCliErrorGuide', () => {
  it('returns runtime stream guidance for runtime stream errors', () => {
    const error = new Error('Runtime stream unavailable. HTTP fallback has been removed; restart the daemon and try again.');
    const guide = buildCliErrorGuide(error);

    expect(guide.what).toContain('Runtime stream socket is unavailable');
    expect(guide.why).toContain('~/.discode/runtime.sock');
    expect(guide.howToSolve).toHaveLength(3);
    expect(guide.detail).toContain('Runtime stream unavailable');
  });

  it('returns generic guidance for unknown errors', () => {
    const guide = buildCliErrorGuide(new Error('boom'));

    expect(guide.what).toBe('boom');
    expect(guide.why).toContain('unexpected runtime error');
    expect(guide.howToSolve).toHaveLength(3);
  });
});

describe('formatCliError', () => {
  it('formats what/why/how sections', () => {
    const output = formatCliError(new Error('boom'), 'Fatal CLI error');

    expect(output).toContain('Fatal CLI error');
    expect(output).toContain('What: boom');
    expect(output).toContain('Why:');
    expect(output).toContain('How to solve:');
    expect(output).toContain('1.');
  });
});

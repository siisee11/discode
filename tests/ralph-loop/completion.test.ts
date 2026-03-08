import { describe, expect, it } from 'vitest';

import {
  collectAgentText,
  COMPLETE_TOKEN,
  containsCompletionSignal,
  stripCompletionSignal,
} from '../../scripts/ralph-loop/lib/completion.mts';

describe('ralph loop completion helpers', () => {
  it('detects the completion token', () => {
    expect(containsCompletionSignal(`done ${COMPLETE_TOKEN}`)).toBe(true);
    expect(containsCompletionSignal('still working')).toBe(false);
  });

  it('strips the completion token from output', () => {
    expect(stripCompletionSignal(`summary\n${COMPLETE_TOKEN}`)).toBe('summary');
  });

  it('joins agent text chunks predictably', () => {
    expect(collectAgentText(['first', '', 'second'])).toBe('first\nsecond');
  });
});

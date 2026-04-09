import { describe, expect, it } from 'vitest';
import { isPtyRuntimeMode, normalizeRuntimeMode, parseRuntimeModeInput } from '../../src/runtime/mode.js';

describe('runtime mode helpers', () => {
  it('normalizes all inputs to pty-rust', () => {
    expect(normalizeRuntimeMode('tmux')).toBe('pty-rust');
    expect(normalizeRuntimeMode('pty-rust')).toBe('pty-rust');
    expect(normalizeRuntimeMode('something-else')).toBe('pty-rust');
    expect(normalizeRuntimeMode(undefined)).toBe('pty-rust');
  });

  it('parses only explicit pty-rust runtime-mode inputs', () => {
    expect(parseRuntimeModeInput('tmux')).toBeUndefined();
    expect(parseRuntimeModeInput('pty-rust')).toBe('pty-rust');
    expect(parseRuntimeModeInput('unknown')).toBeUndefined();
  });

  it('treats missing and normalized modes as pty runtime mode', () => {
    expect(isPtyRuntimeMode('tmux')).toBe(true);
    expect(isPtyRuntimeMode('pty-rust')).toBe(true);
    expect(isPtyRuntimeMode(undefined)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { RuntimeTerminalScreen } from '../../../src/cli/common/runtime-terminal-screen.js';

describe('RuntimeTerminalScreen', () => {
  it('projects the bottom viewport rows with column fitting', () => {
    const screen = new RuntimeTerminalScreen('status');
    screen.setPlainOutput('line-1\nline-2\nline-3\nline-4');

    const projection = screen.project(6, 4);

    expect(projection.bodyRows).toEqual([
      'line-2',
      'line-3',
      'line-4',
    ]);
    expect(projection.statusRow).toBe('status');
  });

  it('pads short rows and truncates long rows', () => {
    const screen = new RuntimeTerminalScreen('very-long-status');
    screen.setPlainOutput('a\n123456789');

    const projection = screen.project(5, 3);

    expect(projection.bodyRows).toEqual([
      'a    ',
      '12345',
    ]);
    expect(projection.statusRow).toBe('very-');
  });

  it('applies runtime frame output as screen state', () => {
    const screen = new RuntimeTerminalScreen('ok');
    screen.applyFrame({
      sessionName: 'bridge',
      windowName: 'demo',
      output: 'first\nsecond',
    });

    const projection = screen.project(10, 3);

    expect(projection.bodyRows).toEqual([
      'first     ',
      'second    ',
    ]);
  });
});

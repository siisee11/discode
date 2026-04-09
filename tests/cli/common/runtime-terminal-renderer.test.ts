import { describe, expect, it } from 'vitest';
import {
  renderProjection,
  renderTerminalEnterSequence,
  renderTerminalExitSequence,
} from '../../../src/cli/common/runtime-terminal-renderer.js';

describe('runtime-terminal-renderer', () => {
  it('renders enter and exit control sequences', () => {
    expect(renderTerminalEnterSequence()).toContain('\x1b[?1049h');
    expect(renderTerminalEnterSequence()).toContain('\x1b[2J');
    expect(renderTerminalExitSequence()).toContain('\x1b[?1049l');
    expect(renderTerminalExitSequence()).toContain('\x1b[?25h');
  });

  it('serializes projected rows into terminal redraw output', () => {
    const rendered = renderProjection({
      bodyRows: ['row-1', 'row-2'],
      statusRow: 'status',
    });

    expect(rendered.startsWith('\x1b[H')).toBe(true);
    expect(rendered).toContain('\x1b[2Krow-1\n');
    expect(rendered).toContain('\x1b[2Krow-2\n');
    expect(rendered.endsWith('\x1b[2Kstatus')).toBe(true);
  });
});

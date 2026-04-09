import type { RuntimeTerminalProjection } from './runtime-terminal-screen.js';

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_SCREEN = '\x1b[2J';
const MOVE_HOME = '\x1b[H';
const CLEAR_LINE = '\x1b[2K';

export function renderTerminalEnterSequence(): string {
  return `${ENTER_ALT_SCREEN}${HIDE_CURSOR}${CLEAR_SCREEN}${MOVE_HOME}`;
}

export function renderTerminalExitSequence(): string {
  return `${SHOW_CURSOR}${LEAVE_ALT_SCREEN}`;
}

export function renderProjection(projection: RuntimeTerminalProjection): string {
  const output: string[] = [MOVE_HOME];
  for (const row of projection.bodyRows) {
    output.push(CLEAR_LINE);
    output.push(row);
    output.push('\n');
  }
  output.push(CLEAR_LINE);
  output.push(projection.statusRow);
  return output.join('');
}

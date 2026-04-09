import { emitKeypressEvents } from 'readline';
import type { RuntimeFrameEvent, RuntimeSessionManager } from './runtime-session-manager.js';

type EmbeddedRuntimeTerminalOptions = {
  session: RuntimeSessionManager;
  windowId: string;
};

type WindowParts = {
  sessionName: string;
  windowName: string;
};

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_SCREEN = '\x1b[2J';
const MOVE_HOME = '\x1b[H';
const CLEAR_LINE = '\x1b[2K';

function parseWindowId(windowId: string): WindowParts | null {
  const idx = windowId.indexOf(':');
  if (idx <= 0 || idx >= windowId.length - 1) return null;
  return {
    sessionName: windowId.slice(0, idx),
    windowName: windowId.slice(idx + 1),
  };
}

function terminalSize(): { cols: number; rows: number } {
  return {
    cols: Math.max(20, process.stdout.columns || 120),
    rows: Math.max(6, process.stdout.rows || 40),
  };
}

function trimToColumns(input: string, cols: number): string {
  if (input.length <= cols) return input;
  return input.slice(0, cols);
}

function statusLine(cols: number, text: string): string {
  const content = trimToColumns(text, cols);
  if (content.length >= cols) return content;
  return `${content}${' '.repeat(cols - content.length)}`;
}

function keyToInputSequence(str: string, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined): string | undefined {
  if (!key) return str || undefined;

  const name = key.name || '';
  if (name === 'return' || name === 'enter') return '\r';
  if (name === 'backspace') return '\x7f';
  if (name === 'tab') return '\t';
  if (name === 'escape') return '\x1b';
  if (name === 'up') return '\x1b[A';
  if (name === 'down') return '\x1b[B';
  if (name === 'right') return '\x1b[C';
  if (name === 'left') return '\x1b[D';
  if (name === 'home') return '\x1b[H';
  if (name === 'end') return '\x1b[F';
  if (name === 'pageup') return '\x1b[5~';
  if (name === 'pagedown') return '\x1b[6~';
  if (name === 'delete') return '\x1b[3~';

  if (key.ctrl && name.length === 1 && name >= 'a' && name <= 'z') {
    const code = name.charCodeAt(0) - 96;
    return String.fromCharCode(code);
  }

  if (str && str.length > 0) return str;
  return undefined;
}

export async function openEmbeddedRuntimeTerminal(options: EmbeddedRuntimeTerminalOptions): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const parts = parseWindowId(options.windowId);
  if (!parts) return false;

  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
  const hadRawMode = !!stdin.isRaw;
  const { session } = options;
  const { sessionName, windowName } = parts;

  let closed = false;
  let renderQueued = false;
  let currentLines: string[] = [];
  const currentStatus = `embedded ${options.windowId} | ctrl+q exit`;

  const cleanup = new Set<() => void>();

  const queueRender = () => {
    if (closed || renderQueued) return;
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      if (!closed) renderNow();
    }, 16);
  };

  const renderNow = () => {
    if (closed) return;
    const { cols, rows } = terminalSize();
    const bodyRows = Math.max(1, rows - 1);
    const visible = currentLines.slice(Math.max(0, currentLines.length - bodyRows));
    const output: string[] = [MOVE_HOME];
    for (let row = 0; row < bodyRows; row += 1) {
      const line = visible[row] || '';
      output.push(CLEAR_LINE);
      output.push(trimToColumns(line, cols));
      output.push('\n');
    }
    output.push(CLEAR_LINE);
    output.push(statusLine(cols, currentStatus));
    process.stdout.write(output.join(''));
  };

  const setFrame = (event: RuntimeFrameEvent) => {
    if (event.sessionName !== sessionName || event.windowName !== windowName) return;
    currentLines = event.output.length > 0 ? event.output.split('\n') : [];
    queueRender();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    for (const fn of cleanup) fn();
  };

  try {
    process.stdout.write(`${ENTER_ALT_SCREEN}${HIDE_CURSOR}${CLEAR_SCREEN}${MOVE_HOME}`);

    emitKeypressEvents(stdin);
    stdin.setRawMode?.(true);
    stdin.resume();

    const offFrame = session.registerFrameListener(setFrame);
    cleanup.add(offFrame);

    const onResize = () => {
      const { cols, rows } = terminalSize();
      void session.sendResize(sessionName, windowName, cols, rows);
      queueRender();
    };
    process.stdout.on('resize', onResize);
    cleanup.add(() => process.stdout.off('resize', onResize));

    const onKeypress = (str: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key?.ctrl && key.name === 'q') {
        close();
        return;
      }
      const sequence = keyToInputSequence(str, key);
      if (!sequence) return;
      session.sendInput(options.windowId, Buffer.from(sequence, 'utf8'));
    };
    stdin.on('keypress', onKeypress);
    cleanup.add(() => stdin.off('keypress', onKeypress));

    await session.requireConnected('embedded runtime terminal');
    await session.focusWindow(options.windowId);
    const { cols, rows } = terminalSize();
    await session.sendResize(sessionName, windowName, cols, rows);
    const initial = await session.readWindowOutput(sessionName, windowName, cols, rows);
    if (typeof initial === 'string' && initial.length > 0) {
      currentLines = initial.split('\n');
    }
    renderNow();

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (closed) {
          clearInterval(timer);
          resolve();
        }
      }, 40);
      cleanup.add(() => {
        clearInterval(timer);
        resolve();
      });
    });
    return true;
  } finally {
    for (const fn of cleanup) fn();
    stdin.setRawMode?.(hadRawMode);
    process.stdout.write(`${SHOW_CURSOR}${LEAVE_ALT_SCREEN}`);
  }
}

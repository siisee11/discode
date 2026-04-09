import { emitKeypressEvents } from 'readline';
import type { RuntimeFrameEvent, RuntimeSessionManager } from './runtime-session-manager.js';
import {
  renderProjection,
  renderTerminalEnterSequence,
  renderTerminalExitSequence,
} from './runtime-terminal-renderer.js';
import { RuntimeTerminalScreen } from './runtime-terminal-screen.js';

type EmbeddedRuntimeTerminalOptions = {
  session: RuntimeSessionManager;
  windowId: string;
};

type WindowParts = {
  sessionName: string;
  windowName: string;
};

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
  const screen = new RuntimeTerminalScreen(`embedded ${options.windowId} | ctrl+q exit`);

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
    process.stdout.write(renderProjection(screen.project(cols, rows)));
  };

  const setFrame = (event: RuntimeFrameEvent) => {
    if (event.sessionName !== sessionName || event.windowName !== windowName) return;
    screen.applyFrame(event);
    queueRender();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    for (const fn of cleanup) fn();
  };

  try {
    process.stdout.write(renderTerminalEnterSequence());

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
      screen.setPlainOutput(initial);
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
    process.stdout.write(renderTerminalExitSequence());
  }
}

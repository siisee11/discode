import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openEmbeddedRuntimeTerminal } from '../../../src/cli/common/runtime-terminal-embedded-host.js';

type MockSession = {
  registerFrameListener: ReturnType<typeof vi.fn>;
  requireConnected: ReturnType<typeof vi.fn>;
  focusWindow: ReturnType<typeof vi.fn>;
  sendResize: ReturnType<typeof vi.fn>;
  readWindowOutput: ReturnType<typeof vi.fn>;
  sendInput: ReturnType<typeof vi.fn>;
};

function createMockSession(): MockSession {
  return {
    registerFrameListener: vi.fn(() => () => {}),
    requireConnected: vi.fn(async () => {}),
    focusWindow: vi.fn(async () => true),
    sendResize: vi.fn(async () => {}),
    readWindowOutput: vi.fn(async () => 'boot\nready'),
    sendInput: vi.fn(),
  };
}

type PatchedProp = { target: object; key: string; descriptor?: PropertyDescriptor };
const patchedProps: PatchedProp[] = [];

function patchProperty(target: object, key: string, value: unknown): void {
  patchedProps.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value,
  });
}

function restorePatchedProperties(): void {
  while (patchedProps.length > 0) {
    const next = patchedProps.pop()!;
    if (next.descriptor) {
      Object.defineProperty(next.target, next.key, next.descriptor);
    } else {
      delete (next.target as Record<string, unknown>)[next.key];
    }
  }
}

describe('openEmbeddedRuntimeTerminal', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    patchProperty(process.stdin, 'isTTY', true);
    patchProperty(process.stdin, 'isRaw', false);
    patchProperty(process.stdin as unknown as Record<string, unknown>, 'setRawMode', vi.fn());
    patchProperty(process.stdin as unknown as Record<string, unknown>, 'resume', vi.fn());

    patchProperty(process.stdout, 'isTTY', true);
    patchProperty(process.stdout, 'columns', 120);
    patchProperty(process.stdout, 'rows', 40);

    writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    restorePatchedProperties();
  });

  it('returns false when not running in a TTY', async () => {
    patchProperty(process.stdin, 'isTTY', false);
    const session = createMockSession();

    const launched = await openEmbeddedRuntimeTerminal({
      session: session as any,
      windowId: 'bridge:demo',
    });

    expect(launched).toBe(false);
    expect(session.requireConnected).not.toHaveBeenCalled();
  });

  it('wires focus, subscribe/resize, input, and exits via ctrl+q', async () => {
    const session = createMockSession();

    const run = openEmbeddedRuntimeTerminal({
      session: session as any,
      windowId: 'bridge:demo',
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    (process.stdin as any).emit('keypress', 'x', { name: 'x', ctrl: false, meta: false });
    (process.stdout as any).emit('resize');
    (process.stdin as any).emit('keypress', 'q', { name: 'q', ctrl: true, meta: false });
    const launched = await run;

    expect(launched).toBe(true);
    expect(session.requireConnected).toHaveBeenCalledWith('embedded runtime terminal');
    expect(session.focusWindow).toHaveBeenCalledWith('bridge:demo');
    expect(session.readWindowOutput).toHaveBeenCalledWith('bridge', 'demo', 120, 40);
    expect(session.sendInput).toHaveBeenCalledWith('bridge:demo', Buffer.from('x', 'utf8'));
    expect(session.sendResize).toHaveBeenCalledWith('bridge', 'demo', 120, 40);
    expect(session.sendResize.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(writeSpy.mock.calls.some((call) => String(call[0]).includes('\x1b[?1049h'))).toBe(true);
    expect(writeSpy.mock.calls.some((call) => String(call[0]).includes('\x1b[?1049l'))).toBe(true);
  });

  it('maps arrow keys to VT input sequences', async () => {
    const session = createMockSession();

    const run = openEmbeddedRuntimeTerminal({
      session: session as any,
      windowId: 'bridge:demo',
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    (process.stdin as any).emit('keypress', '', { name: 'up', ctrl: false, meta: false });
    (process.stdin as any).emit('keypress', 'q', { name: 'q', ctrl: true, meta: false });
    await run;

    expect(session.sendInput).toHaveBeenCalledWith('bridge:demo', Buffer.from('\x1b[A', 'utf8'));
  });
});

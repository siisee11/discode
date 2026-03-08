import { describe, expect, it } from 'vitest';
import { RuntimeStreamServer } from '../../src/runtime/stream-server.js';
import type { AgentRuntime } from '../../src/runtime/interface.js';
import type { TerminalStyledFrame } from '../../src/runtime/vt-screen.js';
import { flushClientFrame, type FrameRendererOptions } from '../../src/runtime/stream-frame-renderer.js';
import type { RuntimeStreamClientState } from '../../src/runtime/stream-utilities.js';

function createStyledFrame(cursorCol: number, cursorVisible: boolean = true): TerminalStyledFrame {
  return {
    cols: 10,
    rows: 4,
    cursorRow: 0,
    cursorCol,
    cursorVisible,
    lines: [
      { segments: [{ text: 'abc       ' }] },
      { segments: [{ text: '          ' }] },
      { segments: [{ text: '          ' }] },
      { segments: [{ text: '          ' }] },
    ],
  };
}

function createRuntimeMock(frameRef: { frame: TerminalStyledFrame; shouldThrowBuffer?: boolean }): AgentRuntime {
  return {
    getOrCreateSession: (projectName: string) => projectName,
    setSessionEnv: () => {},
    windowExists: () => true,
    startAgentInWindow: () => {},
    sendKeysToWindow: () => {},
    typeKeysToWindow: () => {},
    sendEnterToWindow: () => {},
    getWindowBuffer: () => {
      if (frameRef.shouldThrowBuffer) {
        throw new Error('buffer boom');
      }
      return 'abc';
    },
    getWindowFrame: () => frameRef.frame,
  };
}

function createPlainRuntime(buffer: string): AgentRuntime {
  return {
    getOrCreateSession: (projectName: string) => projectName,
    setSessionEnv: () => {},
    windowExists: () => true,
    startAgentInWindow: () => {},
    sendKeysToWindow: () => {},
    typeKeysToWindow: () => {},
    sendEnterToWindow: () => {},
    getWindowBuffer: () => buffer,
    getWindowFrame: undefined,
  };
}

function createRuntimeInputErrorMock(): AgentRuntime {
  return {
    getOrCreateSession: (projectName: string) => projectName,
    setSessionEnv: () => {},
    windowExists: () => true,
    startAgentInWindow: () => {},
    sendKeysToWindow: () => {},
    typeKeysToWindow: () => {
      throw new Error('window not running');
    },
    sendEnterToWindow: () => {},
    getWindowBuffer: () => 'abc',
    getWindowFrame: undefined,
  };
}

function createClientState(windowId: string = 'bridge:demo') {
  const writes: unknown[] = [];
  const socket = {
    write: (raw: string) => {
      for (const line of raw.trim().split('\n')) {
        if (line.length > 0) writes.push(JSON.parse(line));
      }
      return true;
    },
  };
  return {
    writes,
    client: {
      socket,
      buffer: '',
      windowId,
      cols: 120,
      rows: 40,
      seq: 0,
      lastBufferLength: -1,
      lastSnapshot: '',
      lastLines: [],
      lastEmitAt: 0,
      windowMissingNotified: false,
      runtimeErrorNotified: false,
      lastStyledSignature: '',
      lastStyledLines: [],
      lastCursorRow: -1,
      lastCursorCol: -1,
      lastCursorVisible: true,
    } as unknown as RuntimeStreamClientState,
  };
}

function sendToClient(client: RuntimeStreamClientState, payload: unknown): void {
  try {
    client.socket.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // ignore in tests
  }
}

const defaultFrameOptions: FrameRendererOptions = {
  enablePatchDiff: false,
  patchThresholdRatio: 0.55,
  minEmitIntervalMs: 50,
};

describe('RuntimeStreamServer (unit flush behavior)', () => {
  it('emits styled frame when only cursor changes', () => {
    const frameRef = { frame: createStyledFrame(0) };
    const runtime = createRuntimeMock(frameRef);
    const opts = { ...defaultFrameOptions, minEmitIntervalMs: 250 };
    const { writes, client } = createClientState();

    flushClientFrame(client, runtime, opts, sendToClient, true);
    frameRef.frame = createStyledFrame(1);
    flushClientFrame(client, runtime, opts, sendToClient, true);

    const styledFrames = writes.filter(
      (payload: any) => payload && payload.type === 'frame-styled',
    ) as Array<{ seq: number; cursorCol: number }>;

    expect(styledFrames.length).toBe(2);
    expect(styledFrames[0].seq).toBe(1);
    expect(styledFrames[0].cursorCol).toBe(0);
    expect(styledFrames[1].seq).toBe(2);
    expect(styledFrames[1].cursorCol).toBe(1);
  });

  it('does not emit extra frame when styled content and cursor are unchanged', () => {
    const frameRef = { frame: createStyledFrame(0) };
    const runtime = createRuntimeMock(frameRef);
    const { writes, client } = createClientState();

    flushClientFrame(client, runtime, defaultFrameOptions, sendToClient, true);
    flushClientFrame(client, runtime, defaultFrameOptions, sendToClient, true);

    const styledFrames = writes.filter((payload: any) => payload?.type === 'frame-styled');
    expect(styledFrames.length).toBe(1);
  });

  it('emits styled frame when only cursor visibility changes', () => {
    const frameRef = { frame: createStyledFrame(0, true) };
    const runtime = createRuntimeMock(frameRef);
    const { writes, client } = createClientState();

    flushClientFrame(client, runtime, defaultFrameOptions, sendToClient, true);
    frameRef.frame = createStyledFrame(0, false);
    flushClientFrame(client, runtime, defaultFrameOptions, sendToClient, true);

    const styledFrames = writes.filter((payload: any) => payload?.type === 'frame-styled');
    expect(styledFrames.length).toBe(2);
    expect((styledFrames[0] as any).cursorVisible).toBe(true);
    expect((styledFrames[1] as any).cursorVisible).toBe(false);
  });

  it('returns runtime_error once when buffer read fails', () => {
    const frameRef = { frame: createStyledFrame(0), shouldThrowBuffer: true };
    const runtime = createRuntimeMock(frameRef);
    const { writes, client } = createClientState();

    flushClientFrame(client, runtime, defaultFrameOptions, sendToClient, true);
    flushClientFrame(client, runtime, defaultFrameOptions, sendToClient, true);

    const errors = writes.filter((payload: any) => payload?.type === 'error');
    expect(errors.length).toBe(1);
    expect((errors[0] as any).code).toBe('runtime_error');
  });

  it('coalesces non-forced flush when interval is too short and buffer length is unchanged', () => {
    const runtime = createPlainRuntime('abc');
    const opts = { ...defaultFrameOptions, minEmitIntervalMs: 250 };
    const { writes, client } = createClientState();
    client.lastBufferLength = 3;
    client.lastEmitAt = Date.now();
    client.lastSnapshot = 'abc';
    client.lastLines = ['abc'];

    flushClientFrame(client, runtime, opts, sendToClient, false);
    expect(writes.length).toBe(0);
  });

  it('bypasses coalescing when flush is forced', () => {
    const runtime = createPlainRuntime('abc');
    const opts = { ...defaultFrameOptions, minEmitIntervalMs: 250 };
    const { writes, client } = createClientState();
    client.lastBufferLength = 3;
    client.lastEmitAt = Date.now();
    client.lastSnapshot = '';
    client.lastLines = [];

    flushClientFrame(client, runtime, opts, sendToClient, true);
    const frames = writes.filter((payload: any) => payload?.type === 'frame');
    expect(frames.length).toBe(1);
  });

  it('does not throw when runtime input path raises and emits window-exit', () => {
    const server = new RuntimeStreamServer(createRuntimeInputErrorMock(), '/tmp/discode-stream-unit-6.sock');
    const { writes, client } = createClientState('bridge:demo');

    (server as any).handleMessage(client, JSON.stringify({
      type: 'input',
      windowId: 'bridge:demo',
      bytesBase64: Buffer.from('x', 'utf8').toString('base64'),
    }));

    const exits = writes.filter((payload: any) => payload?.type === 'window-exit');
    expect(exits.length).toBe(1);
    expect((exits[0] as any).signal).toBe('not_running');
  });

  it('returns bad_subscribe for malformed subscribe windowId', () => {
    const server = new RuntimeStreamServer(createPlainRuntime('abc'), '/tmp/discode-stream-unit-7.sock');
    const { writes, client } = createClientState('bridge:demo');

    (server as any).handleMessage(client, JSON.stringify({
      type: 'subscribe',
      windowId: 'invalid-window-id',
    }));

    const errors = writes.filter((payload: any) => payload?.type === 'error');
    expect(errors.length).toBe(1);
    expect((errors[0] as any).code).toBe('bad_subscribe');
  });

  it('returns bad_resize for invalid resize payload', () => {
    const server = new RuntimeStreamServer(createPlainRuntime('abc'), '/tmp/discode-stream-unit-8.sock');
    const { writes, client } = createClientState('bridge:demo');

    (server as any).handleMessage(client, JSON.stringify({
      type: 'resize',
      windowId: 'bridge:demo',
      cols: 120,
      rows: 'bad',
    }));

    const errors = writes.filter((payload: any) => payload?.type === 'error');
    expect(errors.length).toBe(1);
    expect((errors[0] as any).code).toBe('bad_resize');
  });
});

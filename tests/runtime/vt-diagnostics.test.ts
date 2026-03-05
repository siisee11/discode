import { describe, expect, it } from 'vitest';
import { VtScreen } from '../../src/runtime/vt-screen.js';
import { buildTerminalResponse } from '../../src/runtime/pty-query-handler.js';
import { flushClientFrame } from '../../src/runtime/stream-frame-renderer.js';
import type { RuntimeStreamClientState } from '../../src/runtime/stream-utilities.js';
import {
  getRuntimeMetric,
  resetRuntimeMetrics,
} from '../../src/runtime/vt-diagnostics.js';
import type { AgentRuntime } from '../../src/runtime/interface.js';

describe('runtime diagnostics metrics', () => {
  it('tracks VT parser partial and unknown sequences', () => {
    resetRuntimeMetrics();
    const screen = new VtScreen(20, 6);

    screen.write('\x1b['); // partial CSI
    screen.write('m'); // complete carried CSI
    screen.write('\x1b#'); // unknown escape
    screen.write('\x1b[1;2q'); // unknown CSI final

    expect(getRuntimeMetric('vt_partial_sequence_carry', { kind: 'csi' })).toBeGreaterThan(0);
    expect(getRuntimeMetric('vt_unknown_escape', { next: '#' })).toBeGreaterThan(0);
    expect(getRuntimeMetric('vt_unknown_csi', { final: 'q' })).toBeGreaterThan(0);
  });

  it('tracks PTY query responses and partial carries', () => {
    resetRuntimeMetrics();
    const record = {
      screen: new VtScreen(20, 6),
      queryCarry: '',
      privateModes: new Map<number, boolean>(),
    };

    buildTerminalResponse(record, '\x1b['); // partial escape
    buildTerminalResponse(record, '6n'); // completes prior CSI and responds

    expect(getRuntimeMetric('pty_query_partial_carry', { kind: 'csi' })).toBeGreaterThan(0);
    expect(getRuntimeMetric('pty_query_response', { kind: 'csi_6n' })).toBeGreaterThan(0);
  });


  it('tracks stream forced flush and coalesced skip', () => {
    resetRuntimeMetrics();
    const runtime: AgentRuntime = {
      getOrCreateSession: (projectName: string) => projectName,
      setSessionEnv: () => {},
      windowExists: () => true,
      startAgentInWindow: () => {},
      sendKeysToWindow: () => {},
      typeKeysToWindow: () => {},
      sendEnterToWindow: () => {},
      getWindowBuffer: () => 'abc',
      getWindowFrame: undefined,
    };
    const writes: unknown[] = [];
    const client = {
      socket: {
        write: (raw: string) => {
          writes.push(raw);
          return true;
        },
      },
      buffer: '',
      windowId: 'bridge:demo',
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
    } as unknown as RuntimeStreamClientState;

    const sendFn = (c: RuntimeStreamClientState, payload: unknown) => {
      try { c.socket.write(`${JSON.stringify(payload)}\n`); } catch { /* ignore */ }
    };
    const opts = { enablePatchDiff: false, patchThresholdRatio: 0.55, minEmitIntervalMs: 250 };

    flushClientFrame(client, runtime, opts, sendFn, true);
    client.lastBufferLength = 3;
    client.lastEmitAt = Date.now();
    flushClientFrame(client, runtime, opts, sendFn, false);

    expect(getRuntimeMetric('stream_forced_flush')).toBeGreaterThan(0);
    expect(getRuntimeMetric('stream_coalesced_skip')).toBeGreaterThan(0);
    expect(writes.length).toBeGreaterThan(0);
  });
});

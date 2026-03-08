import { describe, expect, it } from 'vitest';
import {
  isSupportedRuntimeStreamProtocolVersion,
  parseRuntimeStreamProtocolVersion,
  validateRuntimeStreamInboundMessage,
} from '../../src/runtime/protocol.js';

describe('runtime stream protocol helpers', () => {
  it('parses protocol versions from integer number or string', () => {
    expect(parseRuntimeStreamProtocolVersion(2)).toBe(2);
    expect(parseRuntimeStreamProtocolVersion('1')).toBe(1);
    expect(parseRuntimeStreamProtocolVersion(' 2 ')).toBe(2);
    expect(parseRuntimeStreamProtocolVersion('x')).toBeUndefined();
    expect(parseRuntimeStreamProtocolVersion(1.5)).toBeUndefined();
  });

  it('checks supported protocol version range', () => {
    expect(isSupportedRuntimeStreamProtocolVersion(1)).toBe(true);
    expect(isSupportedRuntimeStreamProtocolVersion(2)).toBe(true);
    expect(isSupportedRuntimeStreamProtocolVersion(0)).toBe(false);
    expect(isSupportedRuntimeStreamProtocolVersion(3)).toBe(false);
  });

  it('validates hello and v2 operation messages', () => {
    expect(validateRuntimeStreamInboundMessage({ type: 'hello', version: '2' })).toEqual({
      ok: true,
      message: { type: 'hello', version: 2, clientId: undefined },
    });

    expect(validateRuntimeStreamInboundMessage({
      type: 'subscribe',
      windowId: 'bridge:demo-opencode',
      cols: 120,
      rows: 40,
    })).toEqual({
      ok: true,
      message: {
        type: 'subscribe',
        windowId: 'bridge:demo-opencode',
        cols: 120,
        rows: 40,
      },
    });

    expect(validateRuntimeStreamInboundMessage({
      type: 'input',
      windowId: 'bridge:demo-opencode',
      bytesBase64: Buffer.from('hello').toString('base64'),
    })).toEqual({
      ok: true,
      message: {
        type: 'input',
        windowId: 'bridge:demo-opencode',
        bytesBase64: 'aGVsbG8=',
      },
    });

    expect(validateRuntimeStreamInboundMessage({
      type: 'resize',
      windowId: 'bridge:demo-opencode',
      cols: 180,
      rows: 50,
    })).toEqual({
      ok: true,
      message: {
        type: 'resize',
        windowId: 'bridge:demo-opencode',
        cols: 180,
        rows: 50,
      },
    });
  });

  it('rejects malformed hello/message payloads', () => {
    expect(validateRuntimeStreamInboundMessage({ type: 'hello', version: '2.2' })).toEqual({
      ok: false,
      code: 'bad_message',
      message: 'Invalid hello.version',
    });

    expect(validateRuntimeStreamInboundMessage({ type: 'ping', id: 123 })).toEqual({
      ok: false,
      code: 'bad_message',
      message: 'Invalid ping.id',
    });

    expect(validateRuntimeStreamInboundMessage({ foo: 'bar' })).toEqual({
      ok: false,
      code: 'bad_message',
      message: 'Invalid message',
    });
  });

  it('rejects malformed operation payloads with operation-specific errors', () => {
    expect(validateRuntimeStreamInboundMessage({ type: 'subscribe', windowId: 'invalid' })).toEqual({
      ok: false,
      code: 'bad_subscribe',
      message: 'Invalid windowId',
    });

    expect(validateRuntimeStreamInboundMessage({ type: 'focus', windowId: '' })).toEqual({
      ok: false,
      code: 'bad_focus',
      message: 'Invalid windowId',
    });

    expect(validateRuntimeStreamInboundMessage({
      type: 'input',
      windowId: 'bridge:demo-opencode',
      bytesBase64: '***',
    })).toEqual({
      ok: false,
      code: 'bad_input',
      message: 'Invalid bytesBase64',
    });

    expect(validateRuntimeStreamInboundMessage({
      type: 'resize',
      windowId: 'bridge:demo-opencode',
      cols: 100,
      rows: 'x',
    })).toEqual({
      ok: false,
      code: 'bad_resize',
      message: 'Invalid size',
    });
  });

  it('returns unknown_type for unsupported message types', () => {
    expect(validateRuntimeStreamInboundMessage({ type: 'mystery' })).toEqual({
      ok: false,
      code: 'unknown_type',
      message: 'Unknown message type',
    });
  });
});

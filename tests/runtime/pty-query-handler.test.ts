import { describe, expect, it } from 'vitest';
import {
  privateModeState,
  xterm256Color,
  buildTerminalResponse,
  type QueryableWindowRecord,
} from '../../src/runtime/pty-query-handler.js';
import { VtScreen } from '../../src/runtime/vt-screen.js';

function makeRecord(): QueryableWindowRecord {
  return {
    screen: new VtScreen(20, 6),
    queryCarry: '',
    privateModes: new Map<number, boolean>(),
  };
}

describe('pty-query-handler', () => {
  describe('privateModeState', () => {
    it('returns 1 for explicitly enabled mode', () => {
      const record = makeRecord();
      record.privateModes.set(2004, true);
      expect(privateModeState(record, 2004)).toBe(1);
    });

    it('returns 2 for explicitly disabled mode', () => {
      const record = makeRecord();
      record.privateModes.set(2004, false);
      expect(privateModeState(record, 2004)).toBe(2);
    });

    it('returns 1 for default-enabled modes (7, 25)', () => {
      const record = makeRecord();
      expect(privateModeState(record, 7)).toBe(1);
      expect(privateModeState(record, 25)).toBe(1);
    });

    it('returns 2 for unknown modes', () => {
      const record = makeRecord();
      expect(privateModeState(record, 9999)).toBe(2);
    });
  });

  describe('xterm256Color', () => {
    it('returns hex triples for ANSI 16 colors', () => {
      const [r, g, b] = xterm256Color(0);
      expect(r).toBe('0000');
      expect(g).toBe('0000');
      expect(b).toBe('0000');
    });

    it('returns correct color for bright white (15)', () => {
      const [r, g, b] = xterm256Color(15);
      expect(r).toBe('ffff');
      expect(g).toBe('ffff');
      expect(b).toBe('ffff');
    });

    it('returns 6x6x6 cube color', () => {
      const result = xterm256Color(16); // r=0, g=0, b=0
      expect(result).toEqual(['0000', '0000', '0000']);
    });

    it('returns grayscale color', () => {
      const [r, g, b] = xterm256Color(232); // v = 8
      expect(r).toBe(g);
      expect(g).toBe(b);
      expect(r).toBe('0808');
    });

    it('returns valid hex4 for all 256 indices', () => {
      for (let i = 0; i < 256; i++) {
        const [r, g, b] = xterm256Color(i);
        expect(r).toMatch(/^[0-9a-f]{4}$/);
        expect(g).toMatch(/^[0-9a-f]{4}$/);
        expect(b).toMatch(/^[0-9a-f]{4}$/);
      }
    });
  });

  describe('buildTerminalResponse', () => {
    it('responds to CSI 6n with cursor position', () => {
      const record = makeRecord();
      record.screen.write('abc');
      const response = buildTerminalResponse(record, '\x1b[6n');
      expect(response).toBe('\x1b[1;4R');
    });

    it('responds to CSI ?6n with extended cursor position', () => {
      const record = makeRecord();
      const response = buildTerminalResponse(record, '\x1b[?6n');
      expect(response).toBe('\x1b[?1;1R');
    });

    it('responds to CSI 5n with device status ok', () => {
      const record = makeRecord();
      expect(buildTerminalResponse(record, '\x1b[5n')).toBe('\x1b[0n');
    });

    it('responds to CSI c with device attributes', () => {
      const record = makeRecord();
      expect(buildTerminalResponse(record, '\x1b[c')).toBe('\x1b[?62;c');
    });

    it('responds to CSI ?u with kitty keyboard protocol', () => {
      const record = makeRecord();
      expect(buildTerminalResponse(record, '\x1b[?u')).toBe('\x1b[?0u');
    });

    it('responds to CSI 14t with pixel dimensions', () => {
      const record = makeRecord();
      const response = buildTerminalResponse(record, '\x1b[14t');
      expect(response).toMatch(/^\x1b\[4;\d+;\d+t$/);
    });

    it('responds to OSC 10 foreground query', () => {
      const record = makeRecord();
      const response = buildTerminalResponse(record, '\x1b]10;?\x07');
      expect(response).toMatch(/^\x1b]10;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\x07$/);
    });

    it('responds to OSC 11 background query', () => {
      const record = makeRecord();
      const response = buildTerminalResponse(record, '\x1b]11;?\x07');
      expect(response).toMatch(/^\x1b]11;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\x07$/);
    });

    it('responds to OSC 4 indexed color query', () => {
      const record = makeRecord();
      const response = buildTerminalResponse(record, '\x1b]4;12;?\x07');
      expect(response).toMatch(/^\x1b]4;12;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\x07$/);
    });

    it('responds to APC kitty graphics query', () => {
      const record = makeRecord();
      const response = buildTerminalResponse(record, '\x1b_Ga=q\x1b\\');
      expect(response).toBe('\x1b_Gi=31337;OK\x1b\\');
    });

    it('tracks private mode h/l changes', () => {
      const record = makeRecord();
      buildTerminalResponse(record, '\x1b[?2004h');
      expect(record.privateModes.get(2004)).toBe(true);
      buildTerminalResponse(record, '\x1b[?2004l');
      expect(record.privateModes.get(2004)).toBe(false);
    });

    it('carries partial CSI across chunks', () => {
      const record = makeRecord();
      buildTerminalResponse(record, '\x1b[');
      expect(record.queryCarry).toBe('\x1b[');
      const response = buildTerminalResponse(record, '6n');
      expect(response).toBe('\x1b[1;1R');
    });

    it('carries partial OSC across chunks', () => {
      const record = makeRecord();
      buildTerminalResponse(record, '\x1b]10;');
      expect(record.queryCarry).toBe('\x1b]10;');
    });

    it('returns empty for non-query sequences', () => {
      const record = makeRecord();
      expect(buildTerminalResponse(record, 'hello world')).toBe('');
    });

    it('responds to private mode DECRPM query', () => {
      const record = makeRecord();
      record.privateModes.set(2004, true);
      const response = buildTerminalResponse(record, '\x1b[?2004$p');
      expect(response).toBe('\x1b[?2004;1$y');
    });
  });
});

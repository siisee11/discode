/**
 * Terminal query response handler for PTY runtime.
 *
 * Parses ANSI/OSC/APC query sequences from terminal output and builds
 * appropriate responses (cursor position reports, device attributes,
 * color queries, etc.).
 */

import { incRuntimeMetric } from './vt-diagnostics.js';

/**
 * Subset of RuntimeWindowRecord needed by the query handler.
 */
export interface QueryableWindowRecord {
  screen: {
    getDimensions(): { cols: number; rows: number };
    getCursorPosition(): { row: number; col: number };
  };
  queryCarry: string;
  privateModes: Map<number, boolean>;
}

export function privateModeState(record: QueryableWindowRecord, mode: number): number {
  const value = record.privateModes.get(mode);
  if (value !== undefined) return value ? 1 : 2;

  // Some private modes are effectively enabled by default in modern terminals.
  if (mode === 7 || mode === 25) return 1;
  return 2;
}

/**
 * xterm 256-color palette → hex triples for OSC responses.
 *
 * Returns [rr, gg, bb] where each component is a 4-char hex string
 * (e.g. "e5e5") as required by the OSC color report format.
 *
 * This differs from vt-utils.xterm256Color which returns #rrggbb strings.
 */
export function xterm256Color(index: number): [string, string, string] {
  const toHex4 = (value: number): string => {
    const clamped = Math.max(0, Math.min(255, Math.floor(value)));
    return clamped.toString(16).padStart(2, '0').repeat(2);
  };

  if (index < 16) {
    const ansi16 = [
      [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16],
      [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
      [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67],
      [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
    ][index] ?? [0, 0, 0];
    return [toHex4(ansi16[0]), toHex4(ansi16[1]), toHex4(ansi16[2])];
  }

  if (index >= 232) {
    const v = 8 + (index - 232) * 10;
    const x = toHex4(v);
    return [x, x, x];
  }

  const i = index - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const map = [0, 95, 135, 175, 215, 255];
  return [toHex4(map[r]), toHex4(map[g]), toHex4(map[b])];
}

/**
 * Parse terminal query sequences from a data chunk and build responses.
 *
 * Handles CSI queries (cursor position, device status, private modes,
 * device attributes, window size), OSC color queries (fg/bg/indexed),
 * and APC queries (kitty graphics protocol).
 *
 * Partial sequences are stored in record.queryCarry for the next call.
 */
export function buildTerminalResponse(record: QueryableWindowRecord, chunk: string): string {
  const dims = record.screen.getDimensions();
  const data = `${record.queryCarry}${chunk}`;
  record.queryCarry = '';
  const noteQueryResponse = (kind: string) => incRuntimeMetric('pty_query_response', { kind });

  let out = '';
  let i = 0;

  while (i < data.length) {
    const ch = data[i];
    if (ch !== '\x1b') {
      i += 1;
      continue;
    }

    const next = data[i + 1];
    if (!next) {
      incRuntimeMetric('pty_query_partial_carry', { kind: 'escape' });
      record.queryCarry = data.slice(i);
      break;
    }

    if (next === '[') {
      let j = i + 2;
      while (j < data.length && (data.charCodeAt(j) < 0x40 || data.charCodeAt(j) > 0x7e)) j += 1;
      if (j >= data.length) {
        incRuntimeMetric('pty_query_partial_carry', { kind: 'csi' });
        record.queryCarry = data.slice(i);
        break;
      }

      const final = data[j];
      const raw = data.slice(i + 2, j);

      if (final === 'n' && raw === '6') {
        const cursor = record.screen.getCursorPosition();
        out += `\x1b[${cursor.row + 1};${cursor.col + 1}R`;
        noteQueryResponse('csi_6n');
      }
      if (final === 'n' && raw === '?6') {
        const cursor = record.screen.getCursorPosition();
        out += `\x1b[?${cursor.row + 1};${cursor.col + 1}R`;
        noteQueryResponse('csi_q6n');
      }
      if (final === 'n' && raw === '5') {
        out += '\x1b[0n';
        noteQueryResponse('csi_5n');
      }

      if (final === 'p' && raw.startsWith('?') && raw.endsWith('$')) {
        const mode = parseInt(raw.slice(1, -1), 10);
        if (Number.isFinite(mode)) {
          const state = privateModeState(record, mode);
          out += `\x1b[?${mode};${state}$y`;
          noteQueryResponse('csi_private_mode');
        }
      }

      if ((final === 'h' || final === 'l') && raw.startsWith('?')) {
        const enable = final === 'h';
        const params = raw.slice(1).split(';');
        for (const value of params) {
          const mode = parseInt(value, 10);
          if (Number.isFinite(mode)) {
            record.privateModes.set(mode, enable);
          }
        }
      }

      if (final === 'u' && raw === '?') {
        out += '\x1b[?0u';
        noteQueryResponse('csi_q_u');
      }

      if (final === 't' && raw === '14') {
        const widthPx = Math.max(320, dims.cols * 11);
        const heightPx = Math.max(200, dims.rows * 22);
        out += `\x1b[4;${heightPx};${widthPx}t`;
        noteQueryResponse('csi_14t');
      }

      if (final === 'c' && raw.length === 0) {
        out += '\x1b[?62;c';
        noteQueryResponse('csi_c');
      }

      i = j + 1;
      continue;
    }

    if (next === ']') {
      let j = i + 2;
      let terminated = false;
      let endIndex = -1;
      while (j < data.length) {
        if (data[j] === '\x07') {
          endIndex = j;
          j += 1;
          terminated = true;
          break;
        }
        if (data[j] === '\x1b' && data[j + 1] === '\\') {
          endIndex = j;
          j += 2;
          terminated = true;
          break;
        }
        j += 1;
      }
      if (!terminated) {
        incRuntimeMetric('pty_query_partial_carry', { kind: 'osc' });
        record.queryCarry = data.slice(i);
        break;
      }

      const body = data.slice(i + 2, endIndex >= 0 ? endIndex : j);
      if (body === '10;?') {
        out += '\x1b]10;rgb:e5e5/e5e5/e5e5\x07';
        noteQueryResponse('osc_10');
      }
      if (body === '11;?') {
        out += '\x1b]11;rgb:0a0a/0a0a/0a0a\x07';
        noteQueryResponse('osc_11');
      }
      const indexedColorQuery = body.match(/^4;(\d+);\?$/);
      if (indexedColorQuery) {
        const idx = parseInt(indexedColorQuery[1], 10);
        if (Number.isFinite(idx) && idx >= 0 && idx <= 255) {
          const [r, g, b] = xterm256Color(idx);
          out += `\x1b]4;${idx};rgb:${r}/${g}/${b}\x07`;
          noteQueryResponse('osc_4_index');
        }
      }

      i = j;
      continue;
    }

    if (next === '_') {
      let j = i + 2;
      let terminated = false;
      while (j < data.length) {
        if (data[j] === '\x1b' && data[j + 1] === '\\') {
          j += 2;
          terminated = true;
          break;
        }
        j += 1;
      }
      if (!terminated) {
        incRuntimeMetric('pty_query_partial_carry', { kind: 'apc' });
        record.queryCarry = data.slice(i);
        break;
      }

      const body = data.slice(i + 2, j - 2);
      if (body.includes('a=q')) {
        out += '\x1b_Gi=31337;OK\x1b\\';
        noteQueryResponse('apc_kitty_graphics');
      }

      i = j;
      continue;
    }

    i += 2;
  }

  return out;
}

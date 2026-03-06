/**
 * Utility functions and types for the runtime stream server.
 */

import type { Socket } from 'net';
import type { TerminalStyledLine } from './vt-screen.js';

export type RuntimeStreamClientState = {
  socket: Socket;
  buffer: string;
  protocolVersion: number;
  windowId?: string;
  cols: number;
  rows: number;
  seq: number;
  lastBufferLength: number;
  lastSnapshot: string;
  lastLines: string[];
  lastEmitAt: number;
  windowMissingNotified: boolean;
  runtimeErrorNotified: boolean;
  lastStyledSignature: string;
  lastStyledLines: TerminalStyledLine[];
  lastCursorRow: number;
  lastCursorCol: number;
  lastCursorVisible: boolean;
};

export function parseWindowId(windowId: string): { sessionName: string; windowName: string } | null {
  const idx = windowId.indexOf(':');
  if (idx <= 0 || idx >= windowId.length - 1) return null;
  return {
    sessionName: windowId.slice(0, idx),
    windowName: windowId.slice(idx + 1),
  };
}

export function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value!)));
}

export function decodeBase64(value: string): Buffer | null {
  if (!value || typeof value !== 'string') return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

export function buildStyledSignature(lines: TerminalStyledLine[]): string {
  return lines
    .map((line) => line.segments.map((seg) => `${seg.text}\u001f${seg.fg || ''}\u001f${seg.bg || ''}\u001f${seg.bold ? '1' : '0'}\u001f${seg.italic ? '1' : '0'}\u001f${seg.underline ? '1' : '0'}`).join('\u001e'))
    .join('\u001d');
}

export function buildLinePatch(prev: string[], next: string[]): { ops: Array<{ index: number; line: string }> } | null {
  const max = Math.max(prev.length, next.length);
  const ops: Array<{ index: number; line: string }> = [];
  for (let i = 0; i < max; i += 1) {
    const before = prev[i] || '';
    const after = next[i] || '';
    if (before !== after) {
      ops.push({ index: i, line: after });
    }
  }
  if (ops.length === 0 && prev.length === next.length) return null;
  return { ops };
}

export function buildStyledPatch(prev: TerminalStyledLine[], next: TerminalStyledLine[]): { ops: Array<{ index: number; line: TerminalStyledLine }> } | null {
  const max = Math.max(prev.length, next.length);
  const ops: Array<{ index: number; line: TerminalStyledLine }> = [];
  for (let i = 0; i < max; i += 1) {
    const before = prev[i] || { segments: [] };
    const after = next[i] || { segments: [] };
    if (buildStyledSignature([before]) !== buildStyledSignature([after])) {
      ops.push({ index: i, line: cloneStyledLine(after) });
    }
  }
  if (ops.length === 0 && prev.length === next.length) return null;
  return { ops };
}

export function cloneStyledLines(lines: TerminalStyledLine[]): TerminalStyledLine[] {
  return lines.map(cloneStyledLine);
}

export function cloneStyledLine(line: TerminalStyledLine): TerminalStyledLine {
  return {
    segments: line.segments.map((seg) => ({
      text: seg.text,
      fg: seg.fg,
      bg: seg.bg,
      bold: seg.bold,
      italic: seg.italic,
      underline: seg.underline,
    })),
  };
}

/**
 * Frame rendering and emission logic for the runtime stream server.
 *
 * Handles both styled (VtScreen) and plain-text (renderTerminalSnapshot)
 * frame paths, including patch-diff optimization.
 */

import type { AgentRuntime } from './interface.js';
import { renderTerminalSnapshot } from '../capture/parser.js';
import { incRuntimeMetric } from './vt-diagnostics.js';
import {
  parseWindowId,
  buildStyledSignature,
  buildStyledPatch,
  buildLinePatch,
  cloneStyledLines,
  type RuntimeStreamClientState,
} from './stream-utilities.js';

function isV2(client: RuntimeStreamClientState): boolean {
  return client.protocolVersion >= 2;
}

function plainLinesToStyled(lines: string[]) {
  return lines.map((line) => ({ segments: [{ text: line }] }));
}

export type FrameRendererOptions = {
  enablePatchDiff: boolean;
  patchThresholdRatio: number;
  minEmitIntervalMs: number;
};

/**
 * Render and emit a frame for a single client.
 *
 * Uses the styled frame path (VtScreen) when available, falling back
 * to plain-text snapshot rendering. Supports patch-diff optimization
 * to reduce payload size when only a few lines have changed.
 */
export function flushClientFrame(
  client: RuntimeStreamClientState,
  runtime: AgentRuntime,
  options: FrameRendererOptions,
  send: (client: RuntimeStreamClientState, payload: unknown) => void,
  force: boolean = false,
): void {
  if (!client.windowId) return;
  if (!runtime.getWindowBuffer) return;
  if (force) {
    incRuntimeMetric('stream_forced_flush');
  }

  const parsed = parseWindowId(client.windowId);
  if (!parsed) return;
  if (!runtime.windowExists(parsed.sessionName, parsed.windowName)) {
    if (!client.windowMissingNotified) {
      send(client, {
        type: 'window-exit',
        windowId: client.windowId,
        code: null,
        signal: 'missing',
      });
      client.windowMissingNotified = true;
    }
    return;
  }
  client.windowMissingNotified = false;

  let raw = '';
  try {
    raw = runtime.getWindowBuffer(parsed.sessionName, parsed.windowName);
    client.runtimeErrorNotified = false;
  } catch (error) {
    if (!client.runtimeErrorNotified) {
      send(client, {
        type: 'error',
        code: 'runtime_error',
        message: `Failed to read runtime buffer: ${error instanceof Error ? error.message : String(error)}`,
      });
      incRuntimeMetric('stream_runtime_error');
      client.runtimeErrorNotified = true;
    }
    return;
  }

  const now = Date.now();
  if (
    !force &&
    client.lastBufferLength >= 0 &&
    now - client.lastEmitAt < options.minEmitIntervalMs &&
    raw.length === client.lastBufferLength
  ) {
    incRuntimeMetric('stream_coalesced_skip');
    return;
  }

  let styledFrame: ReturnType<NonNullable<AgentRuntime['getWindowFrame']>> | undefined | null =
    null;
  try {
    styledFrame = runtime.getWindowFrame?.(
      parsed.sessionName,
      parsed.windowName,
      client.cols,
      client.rows,
    );
  } catch {
    styledFrame = null;
  }
  if (styledFrame) {
    const styledLines = cloneStyledLines(styledFrame.lines);
    const signature = buildStyledSignature(styledLines);
    const cursorChanged =
      styledFrame.cursorRow !== client.lastCursorRow ||
      styledFrame.cursorCol !== client.lastCursorCol;
    const cursorVisible = styledFrame.cursorVisible !== false;
    const cursorVisibilityChanged = cursorVisible !== client.lastCursorVisible;
    if (signature !== client.lastStyledSignature || cursorChanged || cursorVisibilityChanged) {
      client.lastStyledSignature = signature;
      client.lastBufferLength = raw.length;
      client.lastEmitAt = now;
      client.seq += 1;

      if (isV2(client)) {
        send(client, {
          type: 'frame-v2',
          windowId: client.windowId,
          seq: client.seq,
          lineCount: styledLines.length,
          lines: styledLines,
          cursorRow: styledFrame.cursorRow,
          cursorCol: styledFrame.cursorCol,
          cursorVisible,
        });
      } else {
        const patch = options.enablePatchDiff
          ? buildStyledPatch(client.lastStyledLines, styledLines)
          : null;
        const usePatch = !!(
          options.enablePatchDiff
          && client.lastStyledLines.length > 0
          && patch
          && patch.ops.length > 0
          && patch.ops.length <= Math.ceil(styledLines.length * options.patchThresholdRatio)
        );

        if (usePatch && patch) {
          send(client, {
            type: 'patch-styled',
            windowId: client.windowId,
            seq: client.seq,
            lineCount: styledLines.length,
            ops: patch.ops,
            cursorRow: styledFrame.cursorRow,
            cursorCol: styledFrame.cursorCol,
            cursorVisible,
          });
        } else {
          send(client, {
            type: 'frame-styled',
            windowId: client.windowId,
            seq: client.seq,
            lines: styledLines,
            cursorRow: styledFrame.cursorRow,
            cursorCol: styledFrame.cursorCol,
            cursorVisible,
          });
        }
      }

      client.lastStyledLines = styledLines;
      client.lastCursorRow = styledFrame.cursorRow;
      client.lastCursorCol = styledFrame.cursorCol;
      client.lastCursorVisible = cursorVisible;
    }
    return;
  }

  const snapshot = renderTerminalSnapshot(raw, {
    width: client.cols,
    height: client.rows,
  });

  if (snapshot === client.lastSnapshot && raw.length >= 0) {
    client.lastBufferLength = raw.length;
    return;
  }

  client.lastBufferLength = raw.length;
  const lines = snapshot.split('\n');
  client.lastSnapshot = snapshot;
  client.seq += 1;
  client.lastEmitAt = now;

  if (isV2(client)) {
    send(client, {
      type: 'frame-v2',
      windowId: client.windowId,
      seq: client.seq,
      lineCount: lines.length,
      lines: plainLinesToStyled(lines),
      cursorRow: 0,
      cursorCol: 0,
      cursorVisible: true,
    });
  } else {
    const patch = options.enablePatchDiff ? buildLinePatch(client.lastLines, lines) : null;
    const usePatch = !!(
      options.enablePatchDiff
      && client.lastLines.length > 0
      && patch
      && patch.ops.length > 0
      && patch.ops.length <= Math.ceil(lines.length * options.patchThresholdRatio)
    );

    if (usePatch && patch) {
      send(client, {
        type: 'patch',
        windowId: client.windowId,
        seq: client.seq,
        lineCount: lines.length,
        ops: patch.ops,
      });
    } else {
      send(client, {
        type: 'frame',
        windowId: client.windowId,
        seq: client.seq,
        lines,
      });
    }
  }

  client.lastLines = lines;
}

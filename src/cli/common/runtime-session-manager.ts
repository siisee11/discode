import { RuntimeStreamClient, getDefaultRuntimeSocketPath } from './runtime-stream-client.js';
import { runtimeApiRequest, parseRuntimeWindowsResponse } from './runtime-api.js';
import type { RuntimeWindowsResponse } from './runtime-api.js';
import { applyStyledPatch, applyPlainPatch, styledLinesToPlainText } from './runtime-frame-ops.js';
import type { TerminalStyledLine } from '../../runtime/vt-screen.js';

export type RuntimeTransportStatus = {
  mode: 'stream';
  connected: boolean;
  detail: string;
  lastError?: string;
};

export type RuntimeFrameEvent = {
  sessionName: string;
  windowName: string;
  output: string;
  styled?: TerminalStyledLine[];
  cursorRow?: number;
  cursorCol?: number;
  cursorVisible?: boolean;
};

export type RuntimeFrameListener = (frame: RuntimeFrameEvent) => void;

export class RuntimeSessionManager {
  private runtimeSupported: boolean | undefined;
  private runtimeWindowsCache: RuntimeWindowsResponse | null = null;
  private transportStatus: RuntimeTransportStatus = {
    mode: 'stream',
    connected: false,
    detail: 'stream disconnected',
  };
  private runtimeFrameCache = new Map<string, string>();
  private runtimeFrameLines = new Map<string, string[]>();
  private runtimeStyledCache = new Map<string, TerminalStyledLine[]>();
  private runtimeFrameListeners = new Set<RuntimeFrameListener>();
  private streamSubscriptions = new Map<string, { cols: number; rows: number; subscribedAt: number }>();
  private runtimeStreamConnected = false;
  private lastStreamConnectAttemptAt = 0;
  private reconnecting: Promise<boolean> | undefined;
  private streamClient: RuntimeStreamClient;

  constructor(private runtimePort: number) {
    this.streamClient = new RuntimeStreamClient(getDefaultRuntimeSocketPath(), {
      onFrame: (frame) => {
        const output = frame.lines.join('\n');
        this.runtimeFrameLines.set(frame.windowId, frame.lines.slice());
        this.runtimeFrameCache.set(frame.windowId, output);
        this.runtimeStyledCache.delete(frame.windowId);
        this.notifyListeners(frame.windowId, output);
        this.runtimeSupported = true;
      },
      onFrameStyled: (frame) => {
        const output = styledLinesToPlainText(frame.lines);
        this.runtimeFrameCache.set(frame.windowId, output);
        this.runtimeStyledCache.set(frame.windowId, frame.lines);
        this.notifyListeners(frame.windowId, output, frame.lines, frame.cursorRow, frame.cursorCol, frame.cursorVisible);
        this.runtimeSupported = true;
      },
      onPatchStyled: (patch) => {
        const current = this.runtimeStyledCache.get(patch.windowId) || [];
        const next = applyStyledPatch(current, patch.lineCount, patch.ops);
        const output = styledLinesToPlainText(next);
        this.runtimeFrameCache.set(patch.windowId, output);
        this.runtimeStyledCache.set(patch.windowId, next);
        this.notifyListeners(patch.windowId, output, next, patch.cursorRow, patch.cursorCol, patch.cursorVisible);
        this.runtimeSupported = true;
      },
      onPatch: (patch) => {
        const current = this.runtimeFrameLines.get(patch.windowId) || [];
        const next = applyPlainPatch(current, patch.lineCount, patch.ops);
        const output = next.join('\n');
        this.runtimeFrameLines.set(patch.windowId, next);
        this.runtimeFrameCache.set(patch.windowId, output);
        this.runtimeStyledCache.delete(patch.windowId);
        this.notifyListeners(patch.windowId, output);
        this.runtimeSupported = true;
      },
      onWindowExit: (event) => {
        this.runtimeFrameCache.delete(event.windowId);
        this.runtimeFrameLines.delete(event.windowId);
        this.runtimeStyledCache.delete(event.windowId);
        this.streamSubscriptions.delete(event.windowId);
        this.notifyListeners(event.windowId, '');
        this.setTransportStatus({
          mode: 'stream',
          connected: true,
          detail: `window exited: ${event.windowId}`,
        });
      },
      onError: (message) => {
        const isSocketDown = message.includes('runtime stream socket error');
        this.setTransportStatus({
          mode: 'stream',
          connected: isSocketDown ? false : (this.runtimeStreamConnected && this.streamClient.isConnected()),
          detail: isSocketDown ? 'stream error' : 'stream warning',
          lastError: message,
        });
      },
      onStateChange: (state) => {
        if (state === 'connected') {
          this.runtimeStreamConnected = true;
          this.streamSubscriptions.clear();
          this.setTransportStatus({
            mode: 'stream',
            connected: true,
            detail: 'stream connected',
            lastError: undefined,
          });
        } else {
          this.runtimeStreamConnected = false;
          this.streamSubscriptions.clear();
          this.setTransportStatus({
            mode: 'stream',
            connected: false,
            detail: 'stream disconnected',
          });
        }
      },
    });
  }

  async connect(): Promise<void> {
    this.runtimeStreamConnected = await this.streamClient.connect();
    if (this.runtimeStreamConnected) {
      this.setTransportStatus({
        mode: 'stream',
        connected: true,
        detail: 'stream connected',
        lastError: undefined,
      });
    } else {
      const detail = this.streamClient.getLastConnectError() || this.transportStatus.lastError;
      const suffix = detail ? ` (${detail})` : '';
      throw new Error(`Runtime stream unavailable. HTTP fallback has been removed; restart the daemon and try again.${suffix}`);
    }
    this.lastStreamConnectAttemptAt = Date.now();
  }

  disconnect(): void {
    this.streamClient.disconnect();
  }

  getTransportStatus(): RuntimeTransportStatus {
    return { ...this.transportStatus };
  }

  isSupported(): boolean | undefined {
    return this.runtimeSupported;
  }

  async ensureConnected(): Promise<boolean> {
    if (this.runtimeStreamConnected && this.streamClient.isConnected()) {
      return true;
    }

    if (this.reconnecting) {
      return this.reconnecting;
    }

    const now = Date.now();
    if (now - this.lastStreamConnectAttemptAt < 250) {
      return this.runtimeStreamConnected;
    }

    this.lastStreamConnectAttemptAt = now;
    this.reconnecting = this.streamClient.connect().catch(() => false);

    try {
      this.runtimeStreamConnected = await this.reconnecting;
      if (this.runtimeStreamConnected) {
        this.setTransportStatus({
          mode: 'stream',
          connected: true,
          detail: 'stream reconnected',
          lastError: undefined,
        });
      } else {
        this.setTransportStatus({
          mode: 'stream',
          connected: false,
          detail: 'stream unavailable',
        });
      }
      return this.runtimeStreamConnected;
    } finally {
      this.reconnecting = undefined;
    }
  }

  async requireConnected(context: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const connected = await this.ensureConnected();
      if (connected && this.streamClient.isConnected()) return;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    const detail = this.transportStatus.lastError
      ? `${this.transportStatus.detail}: ${this.transportStatus.lastError}`
      : this.transportStatus.detail;
    throw new Error(`Runtime stream is required for ${context} (${detail}).`);
  }

  async fetchWindows(): Promise<RuntimeWindowsResponse | null> {
    try {
      const result = await runtimeApiRequest({
        port: this.runtimePort,
        method: 'GET',
        path: '/runtime/windows',
      });

      if (result.status === 200) {
        const payload = parseRuntimeWindowsResponse(result.body);
        this.runtimeSupported = !!payload;
        this.runtimeWindowsCache = payload;
        return payload;
      }

      if (result.status === 501 || result.status === 404 || result.status === 405) {
        this.runtimeSupported = false;
        this.runtimeWindowsCache = null;
        return null;
      }

      return this.runtimeWindowsCache;
    } catch {
      return this.runtimeWindowsCache;
    }
  }

  getWindowsCache(): RuntimeWindowsResponse | null {
    return this.runtimeWindowsCache;
  }

  async focusWindow(windowId: string): Promise<boolean> {
    if (this.runtimeStreamConnected) {
      this.streamClient.focus(windowId);
    }

    try {
      const result = await runtimeApiRequest({
        port: this.runtimePort,
        method: 'POST',
        path: '/runtime/focus',
        payload: { windowId },
      });
      if (result.status === 200) {
        if (!this.runtimeWindowsCache || !this.runtimeWindowsCache.windows.some((item) => item.windowId === windowId)) {
          await this.fetchWindows();
        }
        if (this.runtimeWindowsCache) {
          this.runtimeWindowsCache.activeWindowId = windowId;
        }
        this.runtimeSupported = true;
        return true;
      }
      if (result.status === 501 || result.status === 404 || result.status === 405) {
        this.runtimeSupported = false;
      }
      if (result.status === 0 && this.runtimeStreamConnected) {
        return true;
      }
      return false;
    } catch {
      return this.runtimeStreamConnected;
    }
  }

  async readWindowOutput(
    sessionName: string,
    windowName: string,
    width?: number,
    height?: number,
  ): Promise<string | undefined> {
    if (!this.isStreamReady()) return undefined;
    const windowId = `${sessionName}:${windowName}`;
    try {
      this.ensureSubscribed(windowId, width, height);
      const frame = this.runtimeFrameCache.get(windowId);
      if (frame !== undefined) {
        this.setTransportStatus({ mode: 'stream', connected: true, detail: 'stream live' });
        return frame;
      }
      const subscribed = this.streamSubscriptions.get(windowId);
      if (subscribed && Date.now() - subscribed.subscribedAt < 1500) return undefined;
      this.retrySubscription(windowId, width, height);
      this.setTransportStatus({ mode: 'stream', connected: true, detail: 'waiting for stream frame' });
      return undefined;
    } catch {
      return undefined;
    }
  }

  getStyledFrame(windowId: string): TerminalStyledLine[] | undefined {
    return this.runtimeStyledCache.get(windowId);
  }

  async sendRawKey(sessionName: string, windowName: string, raw: string): Promise<void> {
    if (!raw) return;
    this.sendInput(`${sessionName}:${windowName}`, Buffer.from(raw, 'utf8'));
  }

  async sendResize(sessionName: string, windowName: string, width: number, height: number): Promise<void> {
    if (!this.isStreamReady()) return;
    const windowId = `${sessionName}:${windowName}`;
    try {
      this.streamClient.resize(windowId, width, height);
      this.ensureSubscribed(windowId, width, height);
    } catch {
      // Silently ignore errors when resizing disconnected/closed windows
    }
  }

  sendInput(windowId: string, data: Buffer): void {
    if (!this.isStreamReady()) return;
    try {
      this.streamClient.input(windowId, data);
      this.setTransportStatus({ mode: 'stream', connected: true, detail: 'stream input' });
    } catch {
      // Silently ignore
    }
  }

  registerFrameListener(listener: RuntimeFrameListener): () => void {
    this.runtimeFrameListeners.add(listener);
    return () => {
      this.runtimeFrameListeners.delete(listener);
    };
  }

  private isStreamReady(): boolean {
    return this.runtimeStreamConnected && this.streamClient.isConnected() && this.runtimeSupported !== false;
  }

  private setTransportStatus(next: Partial<RuntimeTransportStatus>): void {
    this.transportStatus = {
      ...this.transportStatus,
      ...next,
    };
  }

  private splitWindowId(windowId: string): { sessionName: string; windowName: string } | null {
    const idx = windowId.indexOf(':');
    if (idx <= 0 || idx >= windowId.length - 1) return null;
    return {
      sessionName: windowId.slice(0, idx),
      windowName: windowId.slice(idx + 1),
    };
  }

  private ensureSubscribed(windowId: string, width?: number, height?: number): void {
    if (!this.runtimeStreamConnected) return;
    const cols = Math.max(30, Math.min(240, Math.floor(width || 120)));
    const rows = Math.max(10, Math.min(120, Math.floor(height || 40)));
    const prev = this.streamSubscriptions.get(windowId);
    if (prev && prev.cols === cols && prev.rows === rows) return;
    this.streamClient.subscribe(windowId, cols, rows);
    this.streamSubscriptions.set(windowId, { cols, rows, subscribedAt: Date.now() });
  }

  private retrySubscription(windowId: string, width?: number, height?: number): void {
    if (!this.runtimeStreamConnected || !this.streamClient.isConnected()) return;
    const cols = Math.max(30, Math.min(240, Math.floor(width || 120)));
    const rows = Math.max(10, Math.min(120, Math.floor(height || 40)));
    this.streamClient.subscribe(windowId, cols, rows);
    this.streamClient.focus(windowId);
    this.streamSubscriptions.set(windowId, { cols, rows, subscribedAt: Date.now() });
  }

  private notifyListeners(
    windowId: string,
    output: string,
    styled?: TerminalStyledLine[],
    cursorRow?: number,
    cursorCol?: number,
    cursorVisible?: boolean,
  ): void {
    const parsed = this.splitWindowId(windowId);
    if (!parsed) return;
    for (const listener of this.runtimeFrameListeners) {
      listener({
        sessionName: parsed.sessionName,
        windowName: parsed.windowName,
        output,
        styled,
        cursorRow,
        cursorCol,
        cursorVisible,
      });
    }
  }
}

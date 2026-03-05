import { createConnection, type Socket } from 'net';
import { join } from 'path';
import { homedir } from 'os';
import type { TerminalStyledLine } from '../../runtime/vt-screen.js';
import { RUNTIME_STREAM_PROTOCOL_VERSION } from '../../runtime/protocol.js';

type FrameMessage = {
  type: 'frame';
  streamProtocolVersion?: number;
  windowId: string;
  seq: number;
  lines: string[];
};

type PatchMessage = {
  type: 'patch';
  streamProtocolVersion?: number;
  windowId: string;
  seq: number;
  lineCount: number;
  ops: Array<{ index: number; line: string }>;
};

type FrameStyledMessage = {
  type: 'frame-styled';
  streamProtocolVersion?: number;
  windowId: string;
  seq: number;
  lines: TerminalStyledLine[];
  cursorRow?: number;
  cursorCol?: number;
  cursorVisible?: boolean;
};

type PatchStyledMessage = {
  type: 'patch-styled';
  streamProtocolVersion?: number;
  windowId: string;
  seq: number;
  lineCount: number;
  ops: Array<{ index: number; line: TerminalStyledLine }>;
  cursorRow?: number;
  cursorCol?: number;
  cursorVisible?: boolean;
};

type WindowExitMessage = {
  type: 'window-exit';
  streamProtocolVersion?: number;
  windowId: string;
  code?: number | null;
  signal?: string | null;
};

type RuntimeStreamMessage =
  | FrameMessage
  | PatchMessage
  | FrameStyledMessage
  | PatchStyledMessage
  | WindowExitMessage
  | { type: 'hello'; ok: boolean; streamProtocolVersion?: number }
  | { type: 'focus'; ok: boolean; windowId: string }
  | { type: 'input'; ok: boolean; windowId: string }
  | { type: 'error'; code: string; message: string; streamProtocolVersion?: number };

type RuntimeStreamClientHandlers = {
  onFrame?: (frame: FrameMessage) => void;
  onPatch?: (patch: PatchMessage) => void;
  onFrameStyled?: (frame: FrameStyledMessage) => void;
  onPatchStyled?: (patch: PatchStyledMessage) => void;
  onWindowExit?: (event: WindowExitMessage) => void;
  onError?: (error: string) => void;
  onStateChange?: (state: 'connected' | 'disconnected') => void;
};

export class RuntimeStreamClient {
  private socket?: Socket;
  private readBuffer = '';
  private connected = false;
  private streamProtocolVersion?: number;
  private lastConnectError?: string;

  constructor(
    private socketPath: string,
    private handlers: RuntimeStreamClientHandlers = {},
  ) {}

  async connect(timeoutMs: number = 1200): Promise<boolean> {
    if (this.connected) return true;
    this.lastConnectError = undefined;

    return await new Promise<boolean>((resolve) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        resolve(ok);
      };

      const socket = createConnection(this.socketPath, () => {
        this.socket = socket;
        this.connected = true;
        this.streamProtocolVersion = undefined;
        this.handlers.onStateChange?.('connected');
        this.send({ type: 'hello', version: RUNTIME_STREAM_PROTOCOL_VERSION });
        finish(true);
      });

      timer = setTimeout(() => {
        this.lastConnectError = `runtime stream connect timeout after ${timeoutMs}ms`;
        socket.destroy();
        finish(false);
      }, timeoutMs);

      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        this.readBuffer += chunk;
        let idx = this.readBuffer.indexOf('\n');
        while (idx >= 0) {
          const line = this.readBuffer.slice(0, idx).trim();
          this.readBuffer = this.readBuffer.slice(idx + 1);
          if (line.length > 0) {
            this.handleLine(line);
          }
          idx = this.readBuffer.indexOf('\n');
        }
      });

      socket.on('error', (error: NodeJS.ErrnoException) => {
        this.connected = false;
        this.socket = undefined;
        this.handlers.onStateChange?.('disconnected');
        const detail = `${error.code || 'UNKNOWN'}: ${error.message || 'socket error'}`;
        this.lastConnectError = `runtime stream socket error (${detail})`;
        this.handlers.onError?.(this.lastConnectError);
        finish(false);
      });

      socket.on('close', () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.connected = false;
        this.socket = undefined;
        this.handlers.onStateChange?.('disconnected');
      });
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.connected = false;
    this.handlers.onStateChange?.('disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  getStreamProtocolVersion(): number | undefined {
    return this.streamProtocolVersion;
  }

  getLastConnectError(): string | undefined {
    return this.lastConnectError;
  }

  subscribe(windowId: string, cols: number, rows: number): void {
    this.send({ type: 'subscribe', windowId, cols, rows });
  }

  focus(windowId: string): void {
    this.send({ type: 'focus', windowId });
  }

  input(windowId: string, bytes: Buffer): void {
    this.send({
      type: 'input',
      windowId,
      bytesBase64: bytes.toString('base64'),
    });
  }

  resize(windowId: string, cols: number, rows: number): void {
    this.send({ type: 'resize', windowId, cols, rows });
  }

  private send(payload: unknown): void {
    if (!this.connected || !this.socket) return;
    try {
      this.socket.write(`${JSON.stringify(payload)}\n`);
    } catch {
      this.connected = false;
      this.socket = undefined;
    }
  }

  private handleLine(line: string): void {
    let msg: RuntimeStreamMessage;
    try {
      msg = JSON.parse(line) as RuntimeStreamMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
    if (msg.type === 'frame') {
      this.handlers.onFrame?.(msg);
      return;
    }
    if (msg.type === 'patch') {
      this.handlers.onPatch?.(msg);
      return;
    }
    if (msg.type === 'frame-styled') {
      this.handlers.onFrameStyled?.(msg);
      return;
    }
    if (msg.type === 'patch-styled') {
      this.handlers.onPatchStyled?.(msg);
      return;
    }
    if (msg.type === 'window-exit') {
      this.handlers.onWindowExit?.(msg);
      return;
    }
    if (msg.type === 'hello') {
      if (Number.isFinite(msg.streamProtocolVersion)) {
        this.streamProtocolVersion = Math.floor(msg.streamProtocolVersion!);
      }
      return;
    }
    if (msg.type === 'error') {
      this.handlers.onError?.(`${msg.code}: ${msg.message}`);
    }
  }
}

export function getDefaultRuntimeSocketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\discode-runtime';
  }
  return join(homedir(), '.discode', 'runtime.sock');
}

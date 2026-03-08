import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { collectAgentText } from './completion.mts';

type JsonRpcId = number;

interface JsonRpcError {
  code?: number;
  message?: string;
}

interface JsonRpcResponse {
  id: JsonRpcId;
  result?: Record<string, unknown>;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface ThreadOptions {
  model: string;
  cwd: string;
  approvalPolicy: string;
  sandbox: string | Record<string, unknown>;
}

export interface TurnResult {
  status: string;
  turnId?: string;
  agentText: string;
  codexErrorInfo?: string;
}

export interface CodexClientOptions {
  command?: string;
  args?: string[];
  logFile?: string;
  spawnProcess?: (
    command: string,
    args: string[],
    options: { cwd?: string; stdio: ['pipe', 'pipe', 'pipe'] },
  ) => ChildProcessLike;
}

export interface ChildProcessLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'error' | 'close', listener: (...args: unknown[]) => void): this;
}

export class CodexClient extends EventEmitter {
  private readonly child: ChildProcessLike;
  private readonly pending = new Map<
    JsonRpcId,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly logStream?: WriteStream;
  private isClosed = false;
  private requestId = 0;

  constructor(child: ChildProcessLike, logFile?: string) {
    super();
    this.child = child;
    if (logFile) {
      mkdirSync(dirname(logFile), { recursive: true });
      this.logStream = createWriteStream(logFile, { flags: 'a' });
      this.logStream.on('error', () => {
        // Best-effort logging only. Logging failures must not crash the loop runner.
      });
    }

    this.child.on('error', (error) => {
      this.writeLog(`process error: ${String(error)}`);
      this.emit('error', error);
    });
    this.child.on('close', (code) => {
      this.writeLog(`process closed: ${String(code)}`);
      this.emit('close', code);
    });

    this.bindReadable(this.child.stdout, 'stdout');
    this.bindReadable(this.child.stderr, 'stderr');
  }

  static spawn(options: CodexClientOptions = {}): CodexClient {
    const command = options.command ?? 'codex';
    const args = options.args ?? ['app-server'];
    const spawnProcess = options.spawnProcess ?? defaultSpawn;
    const child = spawnProcess(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new CodexClient(child, options.logFile);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'ralph_loop',
        title: 'Ralph Loop',
        version: '1.0.0',
      },
    });
    this.notify('initialized', {});
  }

  async startThread(options: ThreadOptions): Promise<string> {
    const result = await this.request('thread/start', {
      model: options.model,
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy,
      sandbox: options.sandbox,
    });
    const threadId = extractThreadId(result);
    if (!threadId) {
      throw new Error('thread/start did not return a thread id');
    }
    return threadId;
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.request('thread/resume', { threadId });
  }

  async compactThread(threadId: string): Promise<void> {
    await this.request('thread/compact/start', { threadId });
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<void> {
    await this.request('turn/interrupt', {
      threadId,
      ...(turnId ? { turnId } : {}),
    });
  }

  async runTurn(
    threadId: string,
    prompt: string,
    timeoutMs = 30 * 60 * 1000,
  ): Promise<TurnResult> {
    const agentChunks: string[] = [];
    let activeTurnId: string | undefined;

    return new Promise<TurnResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.interruptTurn(threadId, activeTurnId).catch(() => {});
        cleanup();
        reject(new Error(`turn/start timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onNotification = (message: JsonRpcNotification) => {
        if (message.method === 'turn/started') {
          activeTurnId = extractTurnId(message.params) ?? activeTurnId;
          return;
        }

        if (message.method === 'item/completed') {
          const text = extractAgentText(message.params?.item);
          if (text) {
            agentChunks.push(text);
          }
          return;
        }

        if (message.method === 'turn/completed') {
          const params = message.params as
            | {
                status?: string;
                turn?: { id?: string; status?: string; codexErrorInfo?: string };
                codexErrorInfo?: string;
              }
            | undefined;
          const completedTurnId = extractTurnId(message.params);
          if (activeTurnId && completedTurnId && completedTurnId !== activeTurnId) {
            return;
          }
          cleanup();
          resolve({
            status: String(params?.status ?? params?.turn?.status ?? 'completed'),
            turnId: completedTurnId ?? activeTurnId,
            agentText: collectAgentText(agentChunks),
            codexErrorInfo: extractCodexErrorInfo(params),
          });
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.off('notification', onNotification);
      };

      this.on('notification', onNotification);

      void this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
      }).then((result) => {
        activeTurnId = extractTurnId(result) ?? activeTurnId;
      }).catch((error) => {
        cleanup();
        reject(error);
      });
    });
  }

  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.child.kill();
    this.logStream?.end();
  }

  private bindReadable(stream: Readable, label: 'stdout' | 'stderr'): void {
    const rl = createInterface({ input: stream });
    rl.on('line', (line) => {
      this.writeLog(`${label}: ${line}`);
      if (label === 'stderr') {
        return;
      }
      this.handleStdoutLine(line);
    });
  }

  private handleStdoutLine(line: string): void {
    let message: JsonRpcResponse | JsonRpcNotification;
    try {
      message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
    } catch {
      this.emit('invalid-json', line);
      return;
    }

    if ('id' in message) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'JSON-RPC request failed'));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    this.emit('notification', message);
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.requestId;
    const payload = { method, id, params };
    this.writeJson(payload);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.writeJson({ method, params });
  }

  private writeJson(payload: Record<string, unknown>): void {
    if (this.isClosed) {
      return;
    }
    const line = `${JSON.stringify(payload)}\n`;
    this.writeLog(`stdin: ${line.trimEnd()}`);
    this.child.stdin.write(line);
  }

  private writeLog(message: string): void {
    if (!this.logStream || this.isClosed || this.logStream.writableEnded || this.logStream.destroyed) {
      return;
    }
    this.logStream.write(`${new Date().toISOString()} ${message}\n`);
  }
}

function defaultSpawn(
  command: string,
  args: string[],
  options: { cwd?: string; stdio: ['pipe', 'pipe', 'pipe'] },
): ChildProcessLike {
  const child = spawn(command, args, options);
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error('codex app-server must be spawned with piped stdio');
  }
  return child as ChildProcessLike;
}

function extractThreadId(payload: Record<string, unknown> | undefined): string | undefined {
  const thread = payload?.thread as { id?: string } | undefined;
  if (thread?.id) {
    return thread.id;
  }
  const result = payload?.result as { thread?: { id?: string } } | undefined;
  return result?.thread?.id;
}

function extractTurnId(payload: unknown): string | undefined {
  const object = payload as
    | {
        turn?: { id?: string };
        id?: string;
      }
    | undefined;
  return object?.turn?.id ?? object?.id;
}

function extractCodexErrorInfo(payload: Record<string, unknown> | undefined): string | undefined {
  const turn = payload?.turn as { codexErrorInfo?: string } | undefined;
  return turn?.codexErrorInfo ?? (payload?.codexErrorInfo as string | undefined);
}

function extractAgentText(item: unknown): string {
  const message = item as
    | {
        type?: string;
        text?: string;
        content?: Array<{ type?: string; text?: string }>;
      }
    | undefined;
  if (message?.type !== 'agentMessage') {
    return '';
  }
  if (typeof message.text === 'string' && message.text.length > 0) {
    return message.text;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

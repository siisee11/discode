/**
 * Tests for the terminal buffer fallback mechanism — core behavior.
 *
 * When the Stop hook doesn't fire, the buffer fallback captures the terminal
 * content and sends it to Slack after detecting that the terminal buffer is
 * stable.  If hook events set hookActive on the pending entry before the
 * fallback fires, the fallback defers to the hook handler.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────

const mockDownloadFileAttachments = vi.fn().mockResolvedValue({ downloaded: [], skipped: [] });
const mockBuildFileMarkers = vi.fn().mockReturnValue('');

vi.mock('../../src/infra/file-downloader.js', () => ({
  downloadFileAttachments: (...args: any[]) => mockDownloadFileAttachments(...args),
  buildFileMarkers: (...args: any[]) => mockBuildFileMarkers(...args),
}));

vi.mock('../../src/container/index.js', () => ({
  injectFile: vi.fn(),
  WORKSPACE_DIR: '/workspace',
}));

// ── Imports ─────────────────────────────────────────────────────────

import { BridgeMessageRouter } from '../../src/bridge/message-router.js';
import { PendingMessageTracker } from '../../src/bridge/pending-message-tracker.js';
import { normalizeProjectState } from '../../src/state/instances.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createMockMessaging() {
  return {
    platform: 'slack',
    onMessage: vi.fn(),
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockRuntime(bufferContent?: string | (() => string)) {
  return {
    sendKeysToWindow: vi.fn(),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
    getWindowBuffer: vi.fn().mockImplementation(() => {
      if (typeof bufferContent === 'function') return bufferContent();
      return bufferContent ?? '';
    }),
  } as any;
}

function createProject() {
  return normalizeProjectState({
    projectName: 'myapp',
    projectPath: '/home/user/myapp',
    runtimeSession: 'bridge',
    discordChannels: { claude: 'ch-1' },
    agents: { claude: true },
    instances: {
      claude: {
        instanceId: 'claude',
        agentType: 'claude',
        runtimeWindow: 'myapp-claude',
        channelId: 'ch-1',
      },
    },
    createdAt: new Date(),
    lastActive: new Date(),
  });
}

function createMultiInstanceProject() {
  return normalizeProjectState({
    projectName: 'myapp',
    projectPath: '/home/user/myapp',
    runtimeSession: 'bridge',
    discordChannels: { claude: 'ch-1', 'claude-2': 'ch-2' },
    agents: { claude: true },
    instances: {
      claude: {
        instanceId: 'claude',
        agentType: 'claude',
        runtimeWindow: 'myapp-claude',
        channelId: 'ch-1',
      },
      'claude-2': {
        instanceId: 'claude-2',
        agentType: 'claude',
        runtimeWindow: 'myapp-claude-2',
        channelId: 'ch-2',
      },
    },
    createdAt: new Date(),
    lastActive: new Date(),
  });
}

const MODEL_MENU = [
  '❯ /model',
  '───────────────────────────────',
  ' Select model',
  '',
  '   1. Default (recommended)  Opus 4.6',
  '   2. Sonnet                 Sonnet 4.6',
  '   3. Haiku                  Haiku 4.5',
  ' ❯ 4. opus ✔                Custom model',
  '',
  ' Enter to confirm · Esc to exit',
].join('\n');

const HELP_OUTPUT = [
  'Available commands:',
  '  /model   - Switch models',
  '  /help    - Show this help',
  '  /clear   - Clear conversation',
  '  /config  - Show configuration',
].join('\n');

// ── Tests ───────────────────────────────────────────────────────────

describe('buffer fallback — pty, multi-instance & ANSI', () => {
  let messaging: any;
  let runtime: any;
  let stateManager: any;
  let pendingTracker: PendingMessageTracker;
  let router: BridgeMessageRouter;
  let messageCallback: Function;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    process.env.DISCODE_SUBMIT_DELAY_MS = '0';

    messaging = createMockMessaging();
    runtime = createMockRuntime(MODEL_MENU);
    stateManager = {
      getProject: vi.fn().mockReturnValue(createProject()),
      updateLastActive: vi.fn(),
    };
    pendingTracker = new PendingMessageTracker(messaging);

    router = new BridgeMessageRouter({
      messaging,
      runtime,
      stateManager,
      pendingTracker,
      streamingUpdater: { canStream: vi.fn(), start: vi.fn(), append: vi.fn(),
      appendCumulative: vi.fn(), finalize: vi.fn(), discard: vi.fn(), has: vi.fn() } as any,
      sanitizeInput: (content: string) => content.trim() || null,
    });

    router.register();
    messageCallback = messaging.onMessage.mock.calls[0][0];
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.DISCODE_SUBMIT_DELAY_MS;
  });

  // ── Pty runtime (getWindowFrame) ────────────────────────────────

  it('uses getWindowFrame when available (pty runtime)', async () => {
    const styledFrame = {
      cols: 80, rows: 24,
      lines: [
        { segments: [{ text: 'Select model' }] },
        { segments: [{ text: '  1. Default' }] },
        { segments: [{ text: '' }] },
      ],
      cursorRow: 0, cursorCol: 0, cursorVisible: true,
    };

    runtime.getWindowFrame = vi.fn().mockReturnValue(styledFrame);

    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(runtime.getWindowFrame).toHaveBeenCalled();
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Select model'),
    );
  });

  it('falls back to getWindowBuffer when getWindowFrame throws', async () => {
    runtime.getWindowFrame = vi.fn().mockImplementation(() => {
      throw new Error('screen not ready');
    });
    runtime.getWindowBuffer.mockReturnValue(MODEL_MENU);

    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(runtime.getWindowFrame).toHaveBeenCalled();
    expect(runtime.getWindowBuffer).toHaveBeenCalled();
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Select model'),
    );
  });

  it('falls back to getWindowBuffer when getWindowFrame returns null', async () => {
    runtime.getWindowFrame = vi.fn().mockReturnValue(null);
    runtime.getWindowBuffer.mockReturnValue(HELP_OUTPUT);

    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Available commands'),
    );
  });

  it('concatenates multiple segments in pty frame lines', async () => {
    const styledFrame = {
      cols: 80, rows: 24,
      lines: [
        { segments: [{ text: '  1. ' }, { text: 'Default' }, { text: ' (recommended)' }] },
        { segments: [{ text: '  2. Sonnet' }] },
        { segments: [{ text: '' }] },
      ],
      cursorRow: 0, cursorCol: 0, cursorVisible: true,
    };

    runtime.getWindowFrame = vi.fn().mockReturnValue(styledFrame);

    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('  1. Default (recommended)'),
    );
  });

  // ── Multi-instance isolation ────────────────────────────────────

  it('maintains separate fallback timers per instance', async () => {
    stateManager.getProject.mockReturnValue(createMultiInstanceProject());

    let instance1Buffer = 'output from instance 1';
    let instance2Buffer = 'output from instance 2';

    runtime.getWindowBuffer.mockImplementation((_session: string, windowName: string) => {
      if (windowName === 'myapp-claude') return instance1Buffer;
      if (windowName === 'myapp-claude-2') return instance2Buffer;
      return '';
    });

    await messageCallback('claude', 'msg one', 'myapp', 'ch-1', 'msg-1', undefined);
    await messageCallback('claude', 'msg two', 'myapp', 'ch-2', 'msg-2', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('instance 1'),
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-2',
      expect.stringContaining('instance 2'),
    );
  });

  it('cancelling one instance fallback does not affect another', async () => {
    stateManager.getProject.mockReturnValue(createMultiInstanceProject());

    runtime.getWindowBuffer.mockImplementation((_session: string, windowName: string) => {
      if (windowName === 'myapp-claude') return MODEL_MENU;
      if (windowName === 'myapp-claude-2') return HELP_OUTPUT;
      return '';
    });

    await messageCallback('claude', 'msg one', 'myapp', 'ch-1', 'msg-1', undefined);
    await messageCallback('claude', 'msg two', 'myapp', 'ch-2', 'msg-2', undefined);

    await vi.advanceTimersByTimeAsync(2000);
    await pendingTracker.markCompleted('myapp', 'claude', 'claude');

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Select model'),
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-2',
      expect.stringContaining('Available commands'),
    );
  });

  // ── ANSI stripping ──────────────────────────────────────────────

  it('strips ANSI escape codes from buffer output', async () => {
    const ansiBuffer = '\x1b[1m\x1b[36mSelect model\x1b[0m\n  1. Default\n';
    runtime.getWindowBuffer.mockReturnValue(ansiBuffer);

    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    const sentText = messaging.sendToChannel.mock.calls[0][1];
    expect(sentText).not.toContain('\x1b');
    expect(sentText).toContain('Select model');
    expect(sentText).toContain('1. Default');
  });
});

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

describe('buffer fallback for interactive prompts', () => {
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

  // ── Core behavior ───────────────────────────────────────────────

  it('sends terminal buffer to Slack when Stop hook does not fire', async () => {
    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Select model'),
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringMatching(/^```\n[\s\S]+\n```$/),
    );
  });

  it('marks pending as completed after sending buffer', async () => {
    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith(
      'ch-1', 'msg-1', '⏳', '✅',
    );
  });

  it('does not send buffer when Stop hook fires before fallback', async () => {
    await messageCallback('claude', 'hello world', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(2000);
    await pendingTracker.markCompleted('myapp', 'claude', 'claude');

    await vi.advanceTimersByTimeAsync(5000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('does not send buffer when Stop hook fires between first and second check', async () => {
    await messageCallback('claude', 'hello world', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);

    await vi.advanceTimersByTimeAsync(1000);
    await pendingTracker.markCompleted('myapp', 'claude', 'claude');

    await vi.advanceTimersByTimeAsync(1000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  // ── Stability detection ─────────────────────────────────────────

  it('retries when buffer is changing (agent still processing)', async () => {
    let callCount = 0;
    runtime.getWindowBuffer.mockImplementation(() => {
      callCount++;
      if (callCount <= 1) return 'thinking...';
      return MODEL_MENU;
    });

    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Select model'),
    );
  });

  it('gives up after max checks when buffer keeps changing', async () => {
    let callCount = 0;
    runtime.getWindowBuffer.mockImplementation(() => {
      callCount++;
      return `frame-${callCount}`;
    });

    await messageCallback('claude', 'long task', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('does not send when buffer is whitespace-only', async () => {
    runtime.getWindowBuffer.mockReturnValue('   \n  \n   \n');

    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  // ── Timer management ────────────────────────────────────────────

  it('cancels previous fallback when new message arrives', async () => {
    await messageCallback('claude', 'first msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(2000);

    runtime.getWindowBuffer.mockReturnValue('new prompt content');
    await messageCallback('claude', 'second msg', 'myapp', 'ch-1', 'msg-2', undefined);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('new prompt content'),
    );
  });

  it('does not fire fallback after timer is cancelled by new message', async () => {
    runtime.getWindowBuffer.mockReturnValue(MODEL_MENU);
    await messageCallback('claude', 'first msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(2500);

    runtime.getWindowBuffer.mockReturnValue('idle screen');
    await messageCallback('claude', 'second msg', 'myapp', 'ch-1', 'msg-2', undefined);
    await pendingTracker.markCompleted('myapp', 'claude', 'claude');

    await vi.advanceTimersByTimeAsync(10000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  // ── No pending (no messageId) ───────────────────────────────────

  it('fires fallback even when message has no messageId (ensurePending still creates pending entry)', async () => {
    runtime.getWindowBuffer.mockReturnValue(MODEL_MENU);

    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', undefined, undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    // The router now calls ensurePending even without messageId, so a
    // pending entry exists and the buffer fallback fires.
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Select model'),
    );
  });

  // ── Empty / error conditions ────────────────────────────────────

  it('does not send when buffer is empty', async () => {
    runtime.getWindowBuffer.mockReturnValue('');

    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('handles getWindowBuffer throwing gracefully', async () => {
    runtime.getWindowBuffer.mockImplementation(() => {
      throw new Error('window not found');
    });

    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('handles sendToChannel failure in fallback gracefully', async () => {
    runtime.getWindowBuffer.mockReturnValue(MODEL_MENU);
    messaging.sendToChannel.mockRejectedValueOnce(new Error('Slack API error'));

    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).toHaveBeenCalled();
  });

  it('does not fallback when runtime has no getWindowBuffer', async () => {
    const bareRuntime = {
      sendKeysToWindow: vi.fn(),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
    } as any;

    const r = new BridgeMessageRouter({
      messaging,
      runtime: bareRuntime,
      stateManager,
      pendingTracker,
      streamingUpdater: { canStream: vi.fn(), start: vi.fn(), append: vi.fn(),
      appendCumulative: vi.fn(), finalize: vi.fn(), discard: vi.fn(), has: vi.fn() } as any,
      sanitizeInput: (content: string) => content.trim() || null,
    });
    r.register();
    const cb = messaging.onMessage.mock.calls[1][0];

    await cb('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });
});

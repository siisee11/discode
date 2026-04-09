/**
 * Tests for buffer fallback — idle suppression & hookActive.
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

// ── Tests ───────────────────────────────────────────────────────────

describe('buffer fallback — idle suppression & hookActive', () => {
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

  // ── Idle prompt suppression ───────────────────────────────────

  it('does not send idle prompt with status bar (empty ❯ + separator + status)', async () => {
    const idleScreen = [
      '● 안녕하세요! 무엇을 도와드릴까요?',
      '',
      '──────────────────────────────────────────────────────────────────────────────────────────────────────────────',
      '❯ ',
      '──────────────────────────────────────────────────────────────────────────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (… ✗ Auto-update failed · Try claude doctor or npm i -g @anthropic-ai/claude-code',
    ].join('\n');

    runtime.getWindowBuffer.mockReturnValue(idleScreen);

    await messageCallback('claude', 'ㅎㅇ', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('does not send idle prompt with different status bar text', async () => {
    const idleScreen = [
      '● Hello! How can I help you?',
      '',
      '──────────────────────────────────────────────────────────────────────────────────────────────────────────────',
      '❯ ',
      '──────────────────────────────────────────────────────────────────────────────────────────────────────────────',
      '   Claude Code has switched from npm to native installer. Run `claude install` or see https://docs.anthropic…',
      '                               ✗ Auto-update failed · Try claude doctor or npm i -g @anthropic-ai/claude-code',
    ].join('\n');

    runtime.getWindowBuffer.mockReturnValue(idleScreen);

    await messageCallback('claude', 'hello', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('does not send idle prompt when next message is being typed', async () => {
    const idleWithTyping = [
      '● Previous response here',
      '',
      '──────────────────────────────────────────────────────────────────────────────────────────────────────────────',
      '❯ 이 프로젝트 구조 좀 알려줘',
      '──────────────────────────────────────────────────────────────────────────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (… ✗ Auto-update failed',
    ].join('\n');

    runtime.getWindowBuffer.mockReturnValue(idleWithTyping);

    await messageCallback('claude', 'test', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  // ── hookActive suppression (hook events fire before buffer) ──

  it('defers to hook handler when hookActive is set before buffer fires', async () => {
    runtime.getWindowBuffer.mockReturnValue(MODEL_MENU);

    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(2000);
    pendingTracker.setHookActive('myapp', 'claude', 'claude');

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('sends buffer normally when hookActive is not set', async () => {
    runtime.getWindowBuffer.mockReturnValue(MODEL_MENU);

    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Select model'),
    );
  });
});

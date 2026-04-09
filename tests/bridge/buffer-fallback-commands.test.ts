/**
 * Tests for buffer fallback — command handling, prompt extraction, and hookActive.
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

const HELP_OUTPUT = [
  'Available commands:',
  '  /model   - Switch models',
  '  /help    - Show this help',
  '  /clear   - Clear conversation',
  '  /config  - Show configuration',
].join('\n');

// ── Tests ───────────────────────────────────────────────────────────

describe('buffer fallback — commands & prompt extraction', () => {
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

  // ── Various interactive commands ────────────────────────────────

  it('handles command output in buffer', async () => {
    runtime.getWindowBuffer.mockReturnValue(HELP_OUTPUT);

    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Available commands'),
    );
  });

  // ── Submit delay (typeKeysToWindow + Enter) ───────────────────

  it('submits claude messages via typeKeysToWindow + sendEnterToWindow', async () => {
    await messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    expect(runtime.typeKeysToWindow).toHaveBeenCalledWith(
      'bridge', 'myapp-claude', '/model', 'claude',
    );
    expect(runtime.sendEnterToWindow).toHaveBeenCalledWith(
      'bridge', 'myapp-claude', 'claude',
    );
    expect(runtime.sendKeysToWindow).not.toHaveBeenCalled();
  });

  it('respects DISCODE_SUBMIT_DELAY_MS env var for claude agents', async () => {
    process.env.DISCODE_SUBMIT_DELAY_MS = '200';

    const promise = messageCallback('claude', '/model', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(10000);
    await promise;

    expect(runtime.typeKeysToWindow).toHaveBeenCalledWith(
      'bridge', 'myapp-claude', '/model', 'claude',
    );
    expect(runtime.sendEnterToWindow).toHaveBeenCalledWith(
      'bridge', 'myapp-claude', 'claude',
    );

    const typeOrder = runtime.typeKeysToWindow.mock.invocationCallOrder[0];
    const enterOrder = runtime.sendEnterToWindow.mock.invocationCallOrder[0];
    expect(typeOrder).toBeLessThan(enterOrder);
  });

  it('trims trailing whitespace from prompt before typing', async () => {
    await messageCallback('claude', '  /model  ', 'myapp', 'ch-1', 'msg-1', undefined);

    expect(runtime.typeKeysToWindow).toHaveBeenCalledWith(
      'bridge', 'myapp-claude', '/model', 'claude',
    );
  });

  // ── Command block extraction ──────────────────────────────────

  it('extracts only the last command block from full screen buffer', async () => {
    const fullScreen = [
      '╭─── Claude Code v2.1.45 ───╮',
      '│     Welcome back gui!     │',
      '╰───────────────────────────╯',
      '',
      '❯ /model',
      '  ⎿  Set model to opus',
      '',
      '❯ hello',
      '',
      '● Hello!',
      '',
      '❯ /model',
      '───────────────────────────────',
      ' Select model',
      '',
      '   1. Default (recommended)',
      ' ❯ 4. opus ✔',
      '',
      ' Enter to confirm · Esc to exit',
    ].join('\n');

    runtime.getWindowBuffer.mockReturnValue(fullScreen);

    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    const sent = messaging.sendToChannel.mock.calls[0][1];
    expect(sent).not.toContain('Welcome back');
    expect(sent).not.toContain('Hello!');
    expect(sent).toContain('❯ /model');
    expect(sent).toContain('Select model');
    expect(sent).toContain('Enter to confirm');
  });

  it('sends full buffer when no prompt marker found', async () => {
    const noPrompt = [
      'Some output without prompt markers',
      'Another line of output',
    ].join('\n');

    runtime.getWindowBuffer.mockReturnValue(noPrompt);

    await messageCallback('claude', 'test', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    const sent = messaging.sendToChannel.mock.calls[0][1];
    expect(sent).toContain('Some output without prompt markers');
    expect(sent).toContain('Another line of output');
  });

  it('does not confuse menu selection marker with prompt marker', async () => {
    const menuOnly = [
      ' Select model',
      '',
      '   1. Default (recommended)',
      ' ❯ 4. opus ✔',
      '',
      ' Enter to confirm · Esc to exit',
    ].join('\n');

    runtime.getWindowBuffer.mockReturnValue(menuOnly);

    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    const sent = messaging.sendToChannel.mock.calls[0][1];
    expect(sent).toContain('Select model');
    expect(sent).toContain('❯ 4. opus');
    expect(sent).toContain('Enter to confirm');
  });

  it('strips trailing blank lines from extracted command block', async () => {
    const withTrailing = [
      '❯ help text',
      'Available commands:',
      '  /model   - Switch models',
      '',
      '',
      '',
    ].join('\n');

    runtime.getWindowBuffer.mockReturnValue(withTrailing);

    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    const sent = messaging.sendToChannel.mock.calls[0][1];
    expect(sent).toMatch(/Switch models\n```$/);
  });

  it('extracts command block from real-world screen capture', async () => {
    const realCapture = [
      '╭─── Claude Code v2.1.45 ─────────────────────────────────────────╮',
      '│                           │ Tips for getting started            │',
      '│     Welcome back gui!     │ Run /init to create a CLAUDE.md    │',
      '│             ✻             │                                     │',
      '│   Opus 4.6 · Claude Max   │                                     │',
      '╰─────────────────────────────────────────────────────────────────╯',
      '',
      '❯ /model',
      '  ⎿  Set model to opus (claude-opus-4-6)',
      '',
      '❯ ㅎㅇ',
      '',
      '● ㅎㅇ! 무엇을 도와드릴까요?',
      '',
      '❯ test msg',
      '──────────────────────────────────────────────────────────',
      ' Select model',
      ' Switch between Claude models.',
      '',
      '   1. Default (recommended)  Opus 4.6',
      '   2. Sonnet                 Sonnet 4.6',
      '   3. Haiku                  Haiku 4.5',
      ' ❯ 4. opus ✔                 Custom model',
      '',
      ' ▌▌▌ High effort (default) ← → to adjust',
      '',
      ' Enter to confirm · Esc to exit',
    ].join('\n');

    runtime.getWindowBuffer.mockReturnValue(realCapture);

    await messageCallback('claude', 'test msg', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    const sent = messaging.sendToChannel.mock.calls[0][1];
    expect(sent).not.toContain('Welcome back');
    expect(sent).not.toContain('Set model to opus');
    expect(sent).not.toContain('무엇을 도와드릴까요');
    expect(sent).toContain('Select model');
    expect(sent).toContain('opus ✔');
    expect(sent).toContain('High effort');
    expect(sent).toContain('Enter to confirm');
  });

  it('extracts single prompt line without trailing output', async () => {
    const promptOnly = [
      '╭─── Claude Code ───╮',
      '╰───────────────────╯',
      '',
      '❯ ',
    ].join('\n');

    runtime.getWindowBuffer.mockReturnValue(promptOnly);

    await messageCallback('claude', 'test', 'myapp', 'ch-1', 'msg-1', undefined);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    const sent = messaging.sendToChannel.mock.calls[0]?.[1];
    if (sent) {
      expect(sent).not.toContain('Claude Code');
    }
  });
});

/**
 * Tests for BridgeMessageRouter delivery failure handling and user guidance.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockDownloadFileAttachments = vi.fn().mockResolvedValue({ downloaded: [], skipped: [] });
const mockBuildFileMarkers = vi.fn().mockReturnValue('');

vi.mock('../../src/infra/file-downloader.js', () => ({
  downloadFileAttachments: (...args: any[]) => mockDownloadFileAttachments(...args),
  buildFileMarkers: (...args: any[]) => mockBuildFileMarkers(...args),
}));

vi.mock('../../src/container/index.js', () => ({
  injectFile: vi.fn().mockReturnValue(true),
  WORKSPACE_DIR: '/workspace',
}));

import { BridgeMessageRouter } from '../../src/bridge/message-router.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createMockMessaging() {
  return {
    platform: 'discord' as const,
    onMessage: vi.fn(),
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    replyInThreadWithId: vi.fn().mockResolvedValue('thread-msg-ts'),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockRuntime() {
  return {
    sendKeysToWindow: vi.fn(),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
  } as any;
}

function createMockPendingTracker() {
  return {
    markPending: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markError: vi.fn().mockResolvedValue(undefined),
    hasPending: vi.fn().mockReturnValue(true),
    ensurePending: vi.fn().mockResolvedValue(undefined),
    ensureStartMessage: vi.fn().mockResolvedValue(undefined),
    getPending: vi.fn().mockReturnValue(undefined),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('BridgeMessageRouter delivery failure', () => {
  let messaging: any;
  let runtime: any;
  let stateManager: any;
  let pendingTracker: any;
  let router: BridgeMessageRouter;
  let messageCallback: Function;

  const project = {
    projectName: 'test',
    projectPath: '/test/path',
    runtimeSession: 'bridge',
    discordChannels: { claude: 'ch-1' },
    agents: { claude: true },
    instances: {
      claude: {
        instanceId: 'claude',
        agentType: 'claude',
        runtimeWindow: 'test-claude',
        channelId: 'ch-1',
      },
    },
    createdAt: new Date(),
    lastActive: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    messaging = createMockMessaging();
    runtime = createMockRuntime();
    stateManager = {
      getProject: vi.fn().mockReturnValue(project),
      updateLastActive: vi.fn(),
    };
    pendingTracker = createMockPendingTracker();

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

  it('marks error and sends guidance when typeKeysToWindow throws', async () => {
    runtime.typeKeysToWindow.mockImplementation(() => {
      throw new Error('tmux session error');
    });

    await messageCallback('claude', 'hello', 'test', 'ch-1', 'msg-1', 'claude');

    expect(pendingTracker.markError).toHaveBeenCalledWith('test', 'claude', 'claude');
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining("couldn't deliver your message"),
    );
  });

  it('provides restart guidance when window/pane not found', async () => {
    runtime.typeKeysToWindow.mockImplementation(() => {
      throw new Error("can't find window: test-claude");
    });

    await messageCallback('claude', 'hello', 'test', 'ch-1', 'msg-1', 'claude');

    const sentMessage = messaging.sendToChannel.mock.calls[0][1];
    expect(sentMessage).toContain('discode new --name test');
    expect(sentMessage).toContain('discode attach test');
  });

  it('provides generic guidance for non-window errors', async () => {
    runtime.typeKeysToWindow.mockImplementation(() => {
      throw new Error('unexpected tmux failure');
    });

    await messageCallback('claude', 'hello', 'test', 'ch-1', 'msg-1', 'claude');

    const sentMessage = messaging.sendToChannel.mock.calls[0][1];
    expect(sentMessage).toContain('confirm the agent is running');
    expect(sentMessage).not.toContain('discode attach');
  });

  it('sends warning when project is not found in state', async () => {
    stateManager.getProject.mockReturnValue(undefined);

    await messageCallback('claude', 'hello', 'missing-project', 'ch-1', undefined, undefined);

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('not found in state'),
    );
    expect(runtime.typeKeysToWindow).not.toHaveBeenCalled();
  });

  it('sends warning when agent instance mapping not found', async () => {
    stateManager.getProject.mockReturnValue({
      ...project,
      agents: {},
      instances: {},
      discordChannels: {},
    });

    await messageCallback('claude', 'hello', 'test', 'ch-unknown', undefined, undefined);

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-unknown',
      expect.stringContaining('instance mapping not found'),
    );
  });

  it('sends warning for empty/invalid messages', async () => {
    await messageCallback('claude', '   ', 'test', 'ch-1', undefined, undefined);

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Invalid message'),
    );
    expect(runtime.typeKeysToWindow).not.toHaveBeenCalled();
  });
});

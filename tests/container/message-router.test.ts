/**
 * Tests for message-router container file injection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock file downloader
const mockDownloadFileAttachments = vi.fn().mockResolvedValue({ downloaded: [], skipped: [] });
const mockBuildFileMarkers = vi.fn().mockReturnValue('');

vi.mock('../../src/infra/file-downloader.js', () => ({
  downloadFileAttachments: (...args: any[]) => mockDownloadFileAttachments(...args),
  buildFileMarkers: (...args: any[]) => mockBuildFileMarkers(...args),
}));

// Mock container module
const mockInjectFile = vi.fn().mockReturnValue(true);

vi.mock('../../src/container/index.js', () => ({
  injectFile: (...args: any[]) => mockInjectFile(...args),
  WORKSPACE_DIR: '/workspace',
}));

import { BridgeMessageRouter } from '../../src/bridge/message-router.js';
import { normalizeProjectState } from '../../src/state/instances.js';
import { PendingMessageTracker } from '../../src/bridge/pending-message-tracker.js';

function createMockMessaging() {
  return {
    platform: 'discord',
    onMessage: vi.fn(),
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockRuntime() {
  return {
    sendKeysToWindow: vi.fn(),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
  } as any;
}

describe('BridgeMessageRouter container file injection', () => {
  let messaging: any;
  let runtime: any;
  let stateManager: any;
  let pendingTracker: any;
  let router: BridgeMessageRouter;
  let messageCallback: Function;

  beforeEach(() => {
    vi.clearAllMocks();

    messaging = createMockMessaging();
    runtime = createMockRuntime();
    stateManager = {
      getProject: vi.fn(),
      updateLastActive: vi.fn(),
    };
    pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      ensurePending: vi.fn().mockResolvedValue(undefined),
      setPromptPreview: vi.fn(),
      ensureStartMessage: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    };

    router = new BridgeMessageRouter({
      messaging,
      runtime,
      stateManager,
      pendingTracker,
      streamingUpdater: { canStream: vi.fn(), start: vi.fn(), append: vi.fn(), finalize: vi.fn(), discard: vi.fn(), has: vi.fn() } as any,
      sanitizeInput: (content: string) => content.trim() || null,
    });

    router.register();
    messageCallback = messaging.onMessage.mock.calls[0][0];
  });

  it('injects files into container when instance has containerMode', async () => {
    const project = normalizeProjectState({
      projectName: 'test',
      projectPath: '/test/path',
      runtimeSession: 'session',
      discordChannels: { claude: 'ch-1' },
      agents: { claude: true },
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          runtimeWindow: 'test-claude',
          channelId: 'ch-1',
          containerMode: true,
          containerId: 'container-abc',
        },
      },
      createdAt: new Date(),
      lastActive: new Date(),
    });
    stateManager.getProject.mockReturnValue(project);

    const downloadedFiles = [
      { localPath: '/test/path/.discode/files/img.png', originalName: 'img.png', contentType: 'image/png' },
    ];
    mockDownloadFileAttachments.mockResolvedValue({ downloaded: downloadedFiles, skipped: [] });
    mockBuildFileMarkers.mockReturnValue('\n[file:/test/path/.discode/files/img.png]');

    const attachments = [
      { url: 'https://cdn.discord.com/img.png', filename: 'img.png', contentType: 'image/png', size: 1024 },
    ];

    await messageCallback('claude', 'check this image', 'test', 'ch-1', undefined, undefined, attachments);

    // Should inject file into container
    expect(mockInjectFile).toHaveBeenCalledWith(
      'container-abc',
      '/test/path/.discode/files/img.png',
      '/workspace/.discode/files',
    );
  });

  it('does not inject files when instance is not container mode', async () => {
    const project = normalizeProjectState({
      projectName: 'test',
      projectPath: '/test/path',
      runtimeSession: 'session',
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
    });
    stateManager.getProject.mockReturnValue(project);

    const downloadedFiles = [
      { localPath: '/test/path/.discode/files/img.png', originalName: 'img.png', contentType: 'image/png' },
    ];
    mockDownloadFileAttachments.mockResolvedValue({ downloaded: downloadedFiles, skipped: [] });
    mockBuildFileMarkers.mockReturnValue('\n[file:/test/path/.discode/files/img.png]');

    const attachments = [
      { url: 'https://cdn.discord.com/img.png', filename: 'img.png', contentType: 'image/png', size: 1024 },
    ];

    await messageCallback('claude', 'check this', 'test', 'ch-1', undefined, undefined, attachments);

    // Should NOT inject file into container
    expect(mockInjectFile).not.toHaveBeenCalled();
  });

  it('does not create start message from router path', async () => {
    const project = normalizeProjectState({
      projectName: 'test',
      projectPath: '/test/path',
      runtimeSession: 'session',
      discordChannels: { codex: 'ch-codex' },
      agents: { codex: true },
      instances: {
        codex: {
          instanceId: 'codex',
          agentType: 'codex',
          runtimeWindow: 'test-codex',
          channelId: 'ch-codex',
        },
      },
      createdAt: new Date(),
      lastActive: new Date(),
    });
    stateManager.getProject.mockReturnValue(project);

    await messageCallback('codex', '흠', 'test', 'ch-codex', 'msg-1');

    expect(pendingTracker.setPromptPreview).toHaveBeenCalledWith('test', 'codex', '흠', 'codex');
    expect(pendingTracker.ensureStartMessage).not.toHaveBeenCalled();
  });
});

describe('BridgeMessageRouter SDK routing', () => {
  let messaging: any;
  let runtime: any;
  let stateManager: any;
  let pendingTracker: any;
  let router: BridgeMessageRouter;
  let messageCallback: Function;
  let mockGetSdkRunner: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    messaging = createMockMessaging();
    runtime = createMockRuntime();
    stateManager = {
      getProject: vi.fn(),
      updateLastActive: vi.fn(),
    };
    pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      ensurePending: vi.fn().mockResolvedValue(undefined),
      setPromptPreview: vi.fn(),
      ensureStartMessage: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      getPending: vi.fn().mockReturnValue(undefined),
      hasPending: vi.fn().mockReturnValue(false),
    };
    mockGetSdkRunner = vi.fn();

    router = new BridgeMessageRouter({
      messaging,
      runtime,
      stateManager,
      pendingTracker,
      streamingUpdater: { canStream: vi.fn(), start: vi.fn(), append: vi.fn(), finalize: vi.fn(), discard: vi.fn(), has: vi.fn() } as any,
      sanitizeInput: (content: string) => content.trim() || null,
      getSdkRunner: mockGetSdkRunner,
    });

    router.register();
    messageCallback = messaging.onMessage.mock.calls[0][0];
  });

  it('routes to SDK runner when runtimeType is sdk', async () => {
    const mockRunner = { submitMessage: vi.fn().mockResolvedValue(undefined) };
    mockGetSdkRunner.mockReturnValue(mockRunner);

    const project = normalizeProjectState({
      projectName: 'test',
      projectPath: '/test/path',
      runtimeSession: 'session',
      discordChannels: { claude: 'ch-1' },
      agents: { claude: true },
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          runtimeWindow: 'test-claude',
          channelId: 'ch-1',
          runtimeType: 'sdk',
        },
      },
      createdAt: new Date(),
      lastActive: new Date(),
    });
    stateManager.getProject.mockReturnValue(project);

    await messageCallback('claude', 'hello sdk', 'test', 'ch-1');

    expect(mockGetSdkRunner).toHaveBeenCalledWith('test', 'claude');
    expect(mockRunner.submitMessage).toHaveBeenCalledWith('hello sdk');

    // Should NOT use tmux runtime
    expect(runtime.typeKeysToWindow).not.toHaveBeenCalled();
    expect(runtime.sendKeysToWindow).not.toHaveBeenCalled();
  });

  it('sends error when SDK runner is not found', async () => {
    mockGetSdkRunner.mockReturnValue(undefined);

    const project = normalizeProjectState({
      projectName: 'test',
      projectPath: '/test/path',
      runtimeSession: 'session',
      discordChannels: { claude: 'ch-1' },
      agents: { claude: true },
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          runtimeWindow: 'test-claude',
          channelId: 'ch-1',
          runtimeType: 'sdk',
        },
      },
      createdAt: new Date(),
      lastActive: new Date(),
    });
    stateManager.getProject.mockReturnValue(project);

    await messageCallback('claude', 'hello', 'test', 'ch-1');

    expect(pendingTracker.markError).toHaveBeenCalled();
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('SDK runner not found'),
    );
  });

  it('uses runtime window path when runtimeType is not sdk', async () => {
    const project = normalizeProjectState({
      projectName: 'test',
      projectPath: '/test/path',
      runtimeSession: 'session',
      discordChannels: { claude: 'ch-1' },
      agents: { claude: true },
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          runtimeWindow: 'test-claude',
          channelId: 'ch-1',
          runtimeType: 'pty-rust',
        },
      },
      createdAt: new Date(),
      lastActive: new Date(),
    });
    stateManager.getProject.mockReturnValue(project);

    await messageCallback('claude', 'hello tmux', 'test', 'ch-1');

    // Should NOT call getSdkRunner for dispatching
    expect(mockGetSdkRunner).not.toHaveBeenCalled();
  });
});

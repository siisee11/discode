import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BridgeHookServer } from '../../src/bridge/hook-server.js';
import type { BridgeHookServerDeps } from '../../src/bridge/hook-server.js';
import {
  createMockMessaging, createMockPendingTracker, createMockStreamingUpdater,
  createMockStateManager, postJSON, createServerDeps,
} from './hook-server-helpers.js';

describe('BridgeHookServer — auto-pending + streaming', () => {
  let tempDir: string;
  let server: BridgeHookServer;
  let port: number;

  beforeEach(() => {
    const rawDir = join(tmpdir(), `discode-hookserver-test-${Date.now()}`);
    mkdirSync(rawDir, { recursive: true });
    tempDir = realpathSync(rawDir);
  });

  afterEach(() => {
    server?.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function startServer(deps: Partial<BridgeHookServerDeps> = {}): Promise<BridgeHookServer> {
    server = new BridgeHookServer(createServerDeps(0, deps));
    server.start();
    await server.ready();
    port = server.address()!.port;
    return server;
  }

  function makeState() {
    return createMockStateManager({
      test: {
        projectName: 'test',
        projectPath: tempDir,
        tmuxSession: 'bridge',
        agents: { claude: true },
        discordChannels: { claude: 'ch-123' },
        instances: {
          claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    });
  }

  it('auto-creates pending entry for tmux-initiated tool.activity', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.hasPending.mockReturnValue(false);
    mockPendingTracker.ensurePending = vi.fn().mockImplementation(async () => {
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: '',
      });
    });
    mockPendingTracker.ensureStartMessage.mockResolvedValue('auto-start-msg');
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
    });

    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '📖 Read(`src/index.ts`)',
    });

    expect(mockPendingTracker.ensurePending).toHaveBeenCalledWith('test', 'claude', 'ch-123', 'claude');
    expect(mockPendingTracker.ensureStartMessage).toHaveBeenCalled();
  });

  it('auto-creates pending entry for tmux-initiated session.idle', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.hasPending.mockReturnValue(false);
    mockPendingTracker.ensurePending = vi.fn().mockImplementation(async () => {
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: '',
        startMessageId: 'auto-start-msg',
      });
    });
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
    });

    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Response from tmux',
    });

    expect(mockPendingTracker.ensurePending).toHaveBeenCalledWith('test', 'claude', 'ch-123', 'claude');
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Response from tmux');
  });

  it('does not call ensurePending when pending already exists', async () => {
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.hasPending.mockReturnValue(true);
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-user-1',
      startMessageId: 'start-msg-ts',
    });
    mockPendingTracker.ensurePending = vi.fn();
    await startServer({
      messaging: createMockMessaging() as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
    });

    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '📖 Read(`src/index.ts`)',
    });

    expect(mockPendingTracker.ensurePending).not.toHaveBeenCalled();
  });

  it('does not call ensurePending for session.notification', async () => {
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.hasPending.mockReturnValue(false);
    mockPendingTracker.ensurePending = vi.fn();
    await startServer({
      messaging: createMockMessaging() as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
    });

    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.notification',
      notificationType: 'permission_prompt',
      text: 'Allow?',
    });

    expect(mockPendingTracker.ensurePending).not.toHaveBeenCalled();
  });

  it('does not call ensurePending for session.error', async () => {
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.hasPending.mockReturnValue(false);
    mockPendingTracker.ensurePending = vi.fn();
    await startServer({
      messaging: createMockMessaging() as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
    });

    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.error',
      text: 'Something broke',
    });

    expect(mockPendingTracker.ensurePending).not.toHaveBeenCalled();
  });

  // ── Streaming updater integration ──────────────────────────────

  it('tool.activity posts as thread reply', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-user-1',
      startMessageId: 'start-msg-ts',
    });
    const mockStreaming = createMockStreamingUpdater();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
      streamingUpdater: mockStreaming as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '📖 Read(`src/index.ts`)',
    });
    expect(res.status).toBe(200);
    expect(mockPendingTracker.ensureStartMessage).toHaveBeenCalled();
    expect(mockStreaming.start).toHaveBeenCalledWith('test', 'claude', 'ch-123', 'start-msg-ts', 'start-msg-ts');
    expect(mockStreaming.appendCumulative).toHaveBeenCalledWith('test', 'claude', '📖 Read(`src/index.ts`)');
  });

  it('tool.activity skips thread reply when no pending startMessageId', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-user-1',
    });
    const mockStreaming = createMockStreamingUpdater();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
      streamingUpdater: mockStreaming as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '📖 Read(`src/index.ts`)',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.replyInThreadWithId).not.toHaveBeenCalled();
    expect(mockStreaming.appendCumulative).toHaveBeenCalledWith('test', 'claude', '📖 Read(`src/index.ts`)');
  });

  it('session.idle calls streamingUpdater.finalize', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    const mockStreaming = createMockStreamingUpdater();
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-user-1',
      startMessageId: 'start-msg-ts',
    });
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
      streamingUpdater: mockStreaming as any,
    });

    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Done!',
    });

    expect(mockStreaming.finalize).toHaveBeenCalledWith('test', 'claude', undefined, 'start-msg-ts');
  });

  it('session.idle without prior activity skips streamingUpdater.finalize', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    const mockStreaming = createMockStreamingUpdater();
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-user-1',
    });
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
      streamingUpdater: mockStreaming as any,
    });

    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Quick response',
    });

    expect(mockStreaming.finalize).not.toHaveBeenCalled();
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Quick response');
    expect(mockPendingTracker.markCompleted).toHaveBeenCalled();
  });

  it('session.error calls streamingUpdater.discard', async () => {
    const mockPendingTracker = createMockPendingTracker();
    const mockStreaming = createMockStreamingUpdater();
    await startServer({
      messaging: createMockMessaging() as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
      streamingUpdater: mockStreaming as any,
    });

    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.error',
      text: 'Something went wrong',
    });

    expect(mockStreaming.discard).toHaveBeenCalledWith('test', 'claude');
  });

  it('auto-pending creates pending and posts tool activity as thread reply', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.hasPending.mockReturnValue(false);
    mockPendingTracker.ensurePending = vi.fn().mockImplementation(async () => {
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: '',
      });
    });
    mockPendingTracker.ensureStartMessage.mockResolvedValue('auto-start-msg');
    const mockStreaming = createMockStreamingUpdater();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
      streamingUpdater: mockStreaming as any,
    });

    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '📖 Read(`src/index.ts`)',
    });

    expect(mockPendingTracker.ensurePending).toHaveBeenCalled();
    expect(mockPendingTracker.ensureStartMessage).toHaveBeenCalled();
    expect(mockStreaming.start).toHaveBeenCalledWith('test', 'claude', 'ch-123', 'start-msg-ts', 'auto-start-msg');
    expect(mockStreaming.appendCumulative).toHaveBeenCalledWith('test', 'claude', '📖 Read(`src/index.ts`)');
  });

  it('full lifecycle: tool activities replaced in thread → finalize', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.hasPending.mockReturnValue(false);
    mockPendingTracker.ensurePending = vi.fn().mockImplementation(async () => {
      mockPendingTracker.hasPending.mockReturnValue(true);
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: '',
      });
    });
    mockPendingTracker.ensureStartMessage.mockImplementation(async () => {
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: '',
        startMessageId: 'auto-start-msg',
      });
      return 'auto-start-msg';
    });
    const mockStreaming = createMockStreamingUpdater();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
      streamingUpdater: mockStreaming as any,
    });

    // Step 1: tool.activity triggers auto-pending + thread reply
    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '📖 Read(`src/index.ts`)',
    });

    // Step 2: another tool.activity as thread reply
    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '✏️ Edit(`src/config.ts`)',
    });

    // Step 3: session.idle finalizes
    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Done!',
    });

    expect(mockStreaming.start).toHaveBeenCalledWith('test', 'claude', 'ch-123', 'start-msg-ts', 'auto-start-msg');
    expect(mockStreaming.appendCumulative).toHaveBeenCalledTimes(2);
    expect(mockStreaming.appendCumulative).toHaveBeenCalledWith('test', 'claude', '📖 Read(`src/index.ts`)');
    expect(mockStreaming.appendCumulative).toHaveBeenCalledWith('test', 'claude', '✏️ Edit(`src/config.ts`)');
    expect(mockStreaming.finalize).toHaveBeenCalledWith('test', 'claude', undefined, 'auto-start-msg');
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Done!');
  });
});

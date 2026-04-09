import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BridgeHookServer } from '../../src/bridge/hook-server.js';
import type { BridgeHookServerDeps } from '../../src/bridge/hook-server.js';
import {
  createMockMessaging, createMockPendingTracker,
  createMockStateManager, postJSON, createServerDeps,
} from './hook-server-helpers.js';

describe('BridgeHookServer — intermediateText handling', () => {
  let tempDir: string;
  let server: BridgeHookServer;
  let port: number;

  beforeEach(() => {
    process.env.DISCODE_SHOW_THINKING = '1';
    process.env.DISCODE_SHOW_USAGE = '1';
    const rawDir = join(tmpdir(), `discode-hookserver-test-${Date.now()}`);
    mkdirSync(rawDir, { recursive: true });
    tempDir = realpathSync(rawDir);
  });

  afterEach(() => {
    delete process.env.DISCODE_SHOW_THINKING;
    delete process.env.DISCODE_SHOW_USAGE;
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
        runtimeSession: 'bridge',
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

  it('posts intermediateText as channel message', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-user-1',
      startMessageId: 'start-msg-ts',
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
      text: 'Final answer',
      intermediateText: 'Let me check the code.',
    });
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      'Let me check the code.',
    );
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Final answer');
    // No thread replies
    expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
  });

  it('does not post intermediateText when empty', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-user-1',
      startMessageId: 'start-msg-ts',
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
      text: 'Response only',
      intermediateText: '',
    });
    // Only response text, no intermediate
    const channelCalls = mockMessaging.sendToChannel.mock.calls;
    expect(channelCalls.length).toBe(1);
    expect(channelCalls[0][1]).toBe('Response only');
  });

  it('posts intermediateText before thinking in channel', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-user-1',
      startMessageId: 'start-msg-ts',
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
      text: 'Final answer',
      intermediateText: 'Let me check the code.',
      thinking: 'Reasoning about the problem...',
    });
    const channelCalls = mockMessaging.sendToChannel.mock.calls;
    const intermediateIdx = channelCalls.findIndex((c: any) => c[1] === 'Let me check the code.');
    const thinkingIdx = channelCalls.findIndex((c: any) => c[1].includes('Reasoning'));
    expect(intermediateIdx).toBeGreaterThanOrEqual(0);
    expect(thinkingIdx).toBeGreaterThanOrEqual(0);
    expect(intermediateIdx).toBeLessThan(thinkingIdx);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Final answer');
  });

  it('ignores intermediateText when not a string', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-user-1',
      startMessageId: 'start-msg-ts',
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
      text: 'Response',
      intermediateText: 42,
    });

    const channelCalls = mockMessaging.sendToChannel.mock.calls;
    expect(channelCalls.every((c: any) => typeof c[1] === 'string' && !c[1].includes('42'))).toBe(true);
  });

  it('always posts intermediateText when present (no startMessageId guard)', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-user-1',
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
      text: 'Response',
      intermediateText: 'Intermediate content',
    });

    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Intermediate content');
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Response');
  });

  it('handles intermediateText sendToChannel failure gracefully', async () => {
    const mockMessaging = createMockMessaging();
    mockMessaging.sendToChannel.mockRejectedValueOnce(new Error('Slack API error'));
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-user-1',
      startMessageId: 'start-msg-ts',
    });
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Still delivered',
      intermediateText: 'This fails to post',
    });

    expect(res.status).toBe(200);
  });
});

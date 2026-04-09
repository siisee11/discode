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

describe('BridgeHookServer — thinking thread platform & integration', () => {
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

  function pendingWithStart() {
    const pt = createMockPendingTracker();
    pt.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-user-1',
      startMessageId: 'start-msg-ts',
    });
    return pt;
  }

  it('splits long thinking into multiple thread replies', async () => {
    const mockMessaging = createMockMessaging();
    mockMessaging.platform = 'slack' as const;
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: pendingWithStart() as any,
    });

    const lines = Array.from({ length: 80 }, (_, i) => `Reasoning step ${i}: ${'x'.repeat(60)}`);
    const longThinking = lines.join('\n');
    expect(longThinking.length).toBeGreaterThan(3900);

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Done',
      thinking: longThinking,
    });
    expect(res.status).toBe(200);
    // Thinking is now posted to channel via sendToChannel (not thread replies)
    // At least 2 chunks for the thinking + 1 for the response text
    const thinkingCalls = mockMessaging.sendToChannel.mock.calls.filter(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('Reasoning step'),
    );
    expect(thinkingCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of mockMessaging.sendToChannel.mock.calls) {
      expect(call[0]).toBe('ch-123');
    }
  });

  it('uses Discord splitting for discord platform thinking', async () => {
    const mockMessaging = createMockMessaging();
    mockMessaging.platform = 'discord' as const;
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: pendingWithStart() as any,
    });

    const thinking = 'x'.repeat(2500);
    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Done',
      thinking,
    });
    expect(res.status).toBe(200);
    // Thinking is now posted to channel via sendToChannel
    // With Discord splitting (1900 char limit), the thinking code block should be split
    expect(mockMessaging.sendToChannel.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not post thinking when replyInThread method is absent', async () => {
    const mockMessaging = createMockMessaging();
    delete (mockMessaging as any).replyInThread;
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: pendingWithStart() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'The answer is 42',
      thinking: 'Some thinking...',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
  });

  it('calls getPending before markCompleted to preserve startMessageId', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    const callOrder: string[] = [];
    mockPendingTracker.getPending.mockImplementation(() => {
      callOrder.push('getPending');
      return { channelId: 'ch-123', messageId: 'msg-user-1', startMessageId: 'start-msg-ts' };
    });
    mockPendingTracker.markCompleted.mockImplementation(async () => {
      callOrder.push('markCompleted');
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
      text: 'Done',
      thinking: 'Thought about it',
    });

    expect(callOrder.indexOf('getPending')).toBeLessThan(callOrder.indexOf('markCompleted'));
  });

  it('sends thinking and main response to correct channels independently', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: pendingWithStart() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'The final answer',
      thinking: 'Internal reasoning',
    });
    expect(res.status).toBe(200);

    // Thinking is now posted to channel via sendToChannel (not thread replies)
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      expect.stringContaining('Internal reasoning'),
    );
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The final answer');
  });

  it('handles replyInThread failure gracefully', async () => {
    const mockMessaging = createMockMessaging();
    mockMessaging.replyInThread.mockRejectedValue(new Error('Slack API error'));
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: pendingWithStart() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'The answer is 42',
      thinking: 'Some thinking...',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
  });
});

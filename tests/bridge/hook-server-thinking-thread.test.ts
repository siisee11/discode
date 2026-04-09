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

describe('BridgeHookServer — thinking channel messages', () => {
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

  it('posts thinking as channel message', async () => {
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
      text: 'The answer is 42',
      thinking: 'Let me reason about this question...',
    });
    expect(res.status).toBe(200);
    // Thinking and response both go to sendToChannel
    const channelCalls = mockMessaging.sendToChannel.mock.calls;
    const thinkingCall = channelCalls.find((c: any[]) =>
      typeof c[1] === 'string' && c[1].includes('Reasoning'),
    );
    expect(thinkingCall).toBeDefined();
    expect(thinkingCall![1]).toContain('Let me reason about this question...');
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
    // No thread replies
    expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
  });

  it('wraps thinking content in code block', async () => {
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
      text: 'Done',
      thinking: 'Step 1: read the file\nStep 2: fix the bug',
    });
    expect(res.status).toBe(200);
    const channelCalls = mockMessaging.sendToChannel.mock.calls;
    const thinkingContent = channelCalls
      .map((call: any) => call[1])
      .filter((s: string) => s.includes('Reasoning'))
      .join('');
    expect(thinkingContent).toContain(':brain: *Reasoning*');
    expect(thinkingContent).toContain('```\nStep 1: read the file\nStep 2: fix the bug\n```');
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Done');
  });

  it('wraps truncated thinking in code block with truncation marker', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: pendingWithStart() as any,
    });

    const longThinking = 'y'.repeat(15000);
    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Done',
      thinking: longThinking,
    });
    expect(res.status).toBe(200);
    const channelCalls = mockMessaging.sendToChannel.mock.calls;
    const thinkingContent = channelCalls
      .map((call: any) => call[1])
      .filter((s: string) => s.includes('Reasoning') || s.includes('truncated'))
      .join('');
    expect(thinkingContent).toContain('```\n');
    expect(thinkingContent).toContain('\n```');
    expect(thinkingContent).toContain('_(truncated)_');
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Done');
  });

  it('always posts thinking when present (no startMessageId guard)', async () => {
    const mockMessaging = createMockMessaging();
    const pt = createMockPendingTracker();
    pt.getPending.mockReturnValue({ channelId: 'ch-123', messageId: 'msg-user-1' });
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: pt as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'The answer is 42',
      thinking: 'Some thinking...',
    });
    expect(res.status).toBe(200);
    // Thinking goes to channel even without startMessageId
    const thinkingCall = mockMessaging.sendToChannel.mock.calls.find(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('Reasoning'),
    );
    expect(thinkingCall).toBeDefined();
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
  });

  it('does not post empty thinking', async () => {
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
      text: 'The answer is 42',
    });
    expect(res.status).toBe(200);
    const thinkingCall = mockMessaging.sendToChannel.mock.calls.find(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('Reasoning'),
    );
    expect(thinkingCall).toBeUndefined();
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
  });

  it('truncates long thinking content', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: pendingWithStart() as any,
    });

    const longThinking = 'x'.repeat(15000);
    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Done',
      thinking: longThinking,
    });
    expect(res.status).toBe(200);
    const allContent = mockMessaging.sendToChannel.mock.calls
      .map((call: any) => call[1])
      .join('');
    expect(allContent).toContain('Reasoning');
    expect(allContent).toContain('_(truncated)_');
  });

  it('does not post whitespace-only thinking', async () => {
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
      text: 'The answer is 42',
      thinking: '   \n  ',
    });
    expect(res.status).toBe(200);
    const thinkingCall = mockMessaging.sendToChannel.mock.calls.find(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('Reasoning'),
    );
    expect(thinkingCall).toBeUndefined();
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
  });

  it('does not post thinking when thinking is not a string', async () => {
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
      text: 'The answer is 42',
      thinking: 12345,
    });
    expect(res.status).toBe(200);
    const thinkingCall = mockMessaging.sendToChannel.mock.calls.find(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('Reasoning'),
    );
    expect(thinkingCall).toBeUndefined();
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
  });
});

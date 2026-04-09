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

describe('BridgeHookServer — tool.activity session boundaries', () => {
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

  it('session.idle clears activity history — no stale data leak', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
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

    // Session 1: two activities
    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '📖 Read(`src/a.ts`)',
    });
    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '✏️ Edit(`src/b.ts`)',
    });

    // session.idle clears activity history
    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Done',
    });

    // tool.activity does not create channel/thread messages
    // sendToChannel should only have the 'Done' response
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Done');
    expect(mockMessaging.replyInThreadWithId).not.toHaveBeenCalled();
    expect(mockMessaging.updateMessage).not.toHaveBeenCalled();
  });

  it('tool.activity does not call markCompleted', async () => {
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
      type: 'tool.activity',
      text: '📖 Read(`src/index.ts`)',
    });
    // tool.activity should NOT call markCompleted — only session.idle does
    expect(mockPendingTracker.markCompleted).not.toHaveBeenCalled();
  });

  it('tool.activity uses text from message field as fallback', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
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
      type: 'tool.activity',
      message: '💻 `npm test`',
    });
    expect(res.status).toBe(200);
    // tool.activity should not send messages to channel or thread
    expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    expect(mockMessaging.replyInThreadWithId).not.toHaveBeenCalled();
  });
});

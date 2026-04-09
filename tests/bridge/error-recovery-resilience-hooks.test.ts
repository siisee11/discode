/**
 * Tests for hook server resilience when messaging or tracker calls fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PendingMessageTracker } from '../../src/bridge/pending-message-tracker.js';
import { BridgeHookServer } from '../../src/bridge/hook-server.js';
import type { BridgeHookServerDeps } from '../../src/bridge/hook-server.js';
import {
  createMockMessaging,
  createMockPendingTracker,
  createMockStateManager,
  createMockStreamingUpdater,
  postJSON,
  TEST_AUTH_TOKEN,
} from './hook-server-helpers.js';

// ── Tests ───────────────────────────────────────────────────────────

describe('hook server error resilience — hook failures & lifecycle', () => {
  let tempDir: string;
  let server: BridgeHookServer;
  let port: number;

  beforeEach(() => {
    process.env.DISCODE_SHOW_THINKING = '1';
    process.env.DISCODE_SHOW_USAGE = '1';
    const rawDir = join(tmpdir(), `discode-err-recovery-${Date.now()}`);
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
    const fullDeps: BridgeHookServerDeps = {
      port: 0,
      messaging: createMockMessaging('discord') as any,
      stateManager: createMockStateManager() as any,
      pendingTracker: createMockPendingTracker() as any,
      streamingUpdater: createMockStreamingUpdater() as any,
      reloadChannelMappings: vi.fn(),
      authToken: TEST_AUTH_TOKEN,
      ...deps,
    };
    server = new BridgeHookServer(fullDeps);
    server.start();
    await server.ready();
    port = server.address()!.port;
    return server;
  }

  const project = {
    projectName: 'test',
    projectPath: '/tmp/test',
    runtimeSession: 'bridge',
    agents: { claude: true },
    discordChannels: { claude: 'ch-1' },
    instances: {
      claude: {
        instanceId: 'claude',
        agentType: 'claude',
        channelId: 'ch-1',
      },
    },
    createdAt: new Date(),
    lastActive: new Date(),
  };

  it('does not crash when replyInThreadWithId throws during tool.activity', async () => {
    const mockMessaging = {
      ...createMockMessaging('discord'),
      replyInThreadWithId: vi.fn().mockRejectedValue(new Error('Discord API error')),
    };
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-1',
      messageId: 'msg-1',
      startMessageId: 'start-ts',
    });
    const stateManager = createMockStateManager({ test: project });

    await startServer({
      messaging: mockMessaging as any,
      stateManager: stateManager as any,
      pendingTracker: mockPendingTracker as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '📖 Read(`src/index.ts`)',
    });

    expect(res.status).toBe(200);

    const res2 = await postJSON(port, '/reload', {});
    expect(res2.status).toBe(200);
  });

  it('tool.activity continues to work after markCompleted clears pending entry', async () => {
    const mockMessaging = {
      ...createMockMessaging('discord'),
      sendToChannelWithId: vi.fn().mockResolvedValue('start-ts'),
      replyInThread: vi.fn().mockResolvedValue(undefined),
    };
    const tracker = new PendingMessageTracker(mockMessaging as any);
    const stateManager = createMockStateManager({ test: project });

    await startServer({
      messaging: mockMessaging as any,
      stateManager: stateManager as any,
      pendingTracker: tracker as any,
    });

    await tracker.markPending('test', 'claude', 'ch-1', 'msg-1');
    await tracker.markCompleted('test', 'claude');

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '📖 Read(`src/index.ts`)',
    });

    expect(res.status).toBe(200);
    // No crash; tool activity still processed after markCompleted cleanup
    expect(mockMessaging.sendToChannelWithId).not.toHaveBeenCalled();
  });

  it('does not crash when ensurePending throws during tool.activity', async () => {
    const mockMessaging = {
      ...createMockMessaging('discord'),
    };
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.hasPending.mockReturnValue(false);
    mockPendingTracker.ensurePending.mockRejectedValue(new Error('Slack API down'));
    const stateManager = createMockStateManager({ test: project });

    await startServer({
      messaging: mockMessaging as any,
      stateManager: stateManager as any,
      pendingTracker: mockPendingTracker as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '📖 Read(`src/index.ts`)',
    });

    expect(res.status).toBe(500);

    const res2 = await postJSON(port, '/reload', {});
    expect(res2.status).toBe(200);
  });

  it('does not crash when ensurePending throws during session.idle', async () => {
    const mockMessaging = createMockMessaging('discord');
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.hasPending.mockReturnValue(false);
    mockPendingTracker.ensurePending.mockRejectedValue(new Error('Slack API down'));
    const stateManager = createMockStateManager({ test: project });

    await startServer({
      messaging: mockMessaging as any,
      stateManager: stateManager as any,
      pendingTracker: mockPendingTracker as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Response',
    });

    expect(res.status).toBe(500);

    const res2 = await postJSON(port, '/reload', {});
    expect(res2.status).toBe(200);
  });

  it('tmux-initiated full lifecycle: ensurePending → tool.activity → session.idle', async () => {
    const mockMessaging = {
      ...createMockMessaging('discord'),
      sendToChannelWithId: vi.fn().mockResolvedValue('auto-start-ts'),
      replyInThread: vi.fn().mockResolvedValue(undefined),
    };
    const tracker = new PendingMessageTracker(mockMessaging as any);
    const stateManager = createMockStateManager({ test: project });

    await startServer({
      messaging: mockMessaging as any,
      stateManager: stateManager as any,
      pendingTracker: tracker as any,
    });

    const res1 = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '📖 Read(`src/index.ts`)',
    });
    expect(res1.status).toBe(200);
    // Without submitted prompt text, generic tmux start marker is suppressed.
    expect(mockMessaging.sendToChannelWithId).not.toHaveBeenCalled();

    mockMessaging.sendToChannelWithId.mockClear();
    const res2 = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '✏️ Edit(`src/config.ts`) +3 lines',
    });
    expect(res2.status).toBe(200);
    expect(mockMessaging.sendToChannelWithId).not.toHaveBeenCalled();

    const res3 = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Done!',
      intermediateText: 'Let me fix that.',
      thinking: 'Analyzing the issue...',
    });
    expect(res3.status).toBe(200);

    // intermediateText and thinking are now sent to channel (not thread replies)
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Let me fix that.'),
    );
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Analyzing the issue'),
    );
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'Done!');

    expect(mockMessaging.replaceOwnReactionOnMessage).not.toHaveBeenCalled();
  });

  it('does not crash when replyInThread throws during intermediateText', async () => {
    const mockMessaging = {
      ...createMockMessaging('discord'),
      replyInThread: vi.fn().mockRejectedValue(new Error('Discord API error')),
    };
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-1',
      messageId: 'msg-1',
      startMessageId: 'start-ts',
    });
    const stateManager = createMockStateManager({ test: project });

    await startServer({
      messaging: mockMessaging as any,
      stateManager: stateManager as any,
      pendingTracker: mockPendingTracker as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Still delivered',
      intermediateText: 'This fails',
      thinking: 'This also fails',
    });

    const res2 = await postJSON(port, '/reload', {});
    expect(res2.status).toBe(200);
  });
});

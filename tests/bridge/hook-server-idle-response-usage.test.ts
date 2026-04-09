import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BridgeHookServer } from '../../src/bridge/hook-server.js';
import type { BridgeHookServerDeps } from '../../src/bridge/hook-server.js';
import {
  createMockMessaging, createMockPendingTracker, createMockStreamingUpdater,
  createMockStateManager, postJSON, createServerDeps,
} from './hook-server-helpers.js';

describe('BridgeHookServer — idle response handling', () => {
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

  it('handles session.idle with usage in finalize header', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    const mockStreaming = createMockStreamingUpdater();
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-user-1',
      startMessageId: 'start-msg-ts',
    });
    const stateManager = createMockStateManager({
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
    await startServer({
      messaging: mockMessaging as any,
      stateManager: stateManager as any,
      pendingTracker: mockPendingTracker as any,
      streamingUpdater: mockStreaming as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Done result',
      usage: { inputTokens: 5000, outputTokens: 3234, totalCostUsd: 0.03 },
    });
    expect(res.status).toBe(200);

    // Finalize should be called with custom header containing tokens and cost
    expect(mockStreaming.finalize).toHaveBeenCalledWith(
      'test',
      'claude',
      expect.stringContaining('Done'),
      'start-msg-ts',
    );
    const finalizeHeader = mockStreaming.finalize.mock.calls[0][2];
    expect(finalizeHeader).toContain('8,234');  // 5000 + 3234
    expect(finalizeHeader).toContain('$0.03');
  });

  it('handles session.idle with usage channel message', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-user-1',
      startMessageId: 'start-msg-ts',
    });
    const stateManager = createMockStateManager({
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
    await startServer({
      messaging: mockMessaging as any,
      stateManager: stateManager as any,
      pendingTracker: mockPendingTracker as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Result text',
      usage: { inputTokens: 5000, outputTokens: 3234, totalCostUsd: 0.03 },
    });
    expect(res.status).toBe(200);

    // Should post usage details as channel message
    const channelCalls = mockMessaging.sendToChannel.mock.calls;
    const usageCall = channelCalls.find((c: any[]) =>
      typeof c[1] === 'string' && c[1].includes('Input:'),
    );
    expect(usageCall).toBeDefined();
    expect(usageCall![1]).toContain('5,000');
    expect(usageCall![1]).toContain('3,234');
    expect(usageCall![1]).toContain('$0.03');
  });

  it('handles session.idle without usage (no custom finalize header)', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    const mockStreaming = createMockStreamingUpdater();
    // Provide a live pending entry with startMessageId so finalize is called
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-user-1',
      startMessageId: 'start-msg-ts',
    });
    const stateManager = createMockStateManager({
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
    await startServer({
      messaging: mockMessaging as any,
      stateManager: stateManager as any,
      pendingTracker: mockPendingTracker as any,
      streamingUpdater: mockStreaming as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Simple result',
    });
    expect(res.status).toBe(200);

    // Finalize should be called WITHOUT custom header (no usage) but WITH startMessageId
    expect(mockStreaming.finalize).toHaveBeenCalledWith('test', 'claude', undefined, 'start-msg-ts');
  });

  it('uses turnText for file path extraction when text has no paths', async () => {
    const filesDir = join(tempDir, '.discode', 'files');
    mkdirSync(filesDir, { recursive: true });
    const testFile = join(filesDir, 'output.png');
    writeFileSync(testFile, 'fake-png');

    const mockMessaging = createMockMessaging();
    const stateManager = createMockStateManager({
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
    await startServer({
      messaging: mockMessaging as any,
      stateManager: stateManager as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Here is the chart',
      turnText: `Created ${testFile}`,
    });
    expect(res.status).toBe(200);
    // Text message should be sent
    expect(mockMessaging.sendToChannel).toHaveBeenCalled();
    // File from turnText should be sent
    expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith('ch-123', '', [testFile]);
  });

});

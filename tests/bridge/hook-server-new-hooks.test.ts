import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BridgeHookServer } from '../../src/bridge/hook-server.js';
import type { BridgeHookServerDeps } from '../../src/bridge/hook-server.js';
import {
  createMockMessaging, createMockPendingTracker,
  createMockStateManager, postJSON, createServerDeps,
} from './hook-server-helpers.js';

describe('BridgeHookServer — new hooks (prompt.submit, tool.failure, teammate.idle)', () => {
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

  // --- prompt.submit ---

  it('handles prompt.submit event', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'prompt.submit',
      text: 'Fix the login bug',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      expect.stringContaining('Fix the login bug'),
    );
    const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
    expect(sentMsg).toContain('📝');
  });

  it('prompt.submit with empty text does not send', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'prompt.submit',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('passes prompt.submit for agents without prompt hook support', async () => {
    const mockMessaging = createMockMessaging();
    const opencodeState = createMockStateManager({
      test: {
        projectName: 'test',
        projectPath: tempDir,
        runtimeSession: 'bridge',
        agents: { opencode: true },
        discordChannels: { opencode: 'ch-opencode' },
        instances: {
          opencode: { instanceId: 'opencode', agentType: 'opencode', channelId: 'ch-opencode' },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    });
    await startServer({
      messaging: mockMessaging as any,
      stateManager: opencodeState as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'opencode',
      type: 'prompt.submit',
      text: 'This should be ignored',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
  });

  // --- tool.failure ---

  it('handles tool.failure event', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.failure',
      toolName: 'Bash',
      error: 'Command failed with exit code 1',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      expect.stringContaining('Bash failed'),
    );
    const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
    expect(sentMsg).toContain('⚠️');
    expect(sentMsg).toContain('Command failed with exit code 1');
  });

  it('tool.failure without error sends minimal message', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.failure',
      toolName: 'Edit',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      '⚠️ *Edit failed*',
    );
  });

  // --- teammate.idle ---

  it('handles teammate.idle event', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'teammate.idle',
      teammateName: 'agent-2',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      '💤 *[agent-2]* idle',
    );
  });

  it('teammate.idle includes team name when provided', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'teammate.idle',
      teammateName: 'agent-3',
      teamName: 'backend-team',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      '💤 *[agent-3]* idle (backend-team)',
    );
  });

  it('teammate.idle with missing teammateName does not send', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'teammate.idle',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
  });
});

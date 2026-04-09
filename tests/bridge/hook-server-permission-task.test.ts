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

describe('BridgeHookServer — permission.request & task.completed', () => {
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

  describe('permission.request', () => {
    it('sends permission message with toolName and toolInput', async () => {
      const mockMessaging = createMockMessaging();
      await startServer({
        messaging: mockMessaging as any,
        stateManager: makeState() as any,
        pendingTracker: createMockPendingTracker() as any,
      });

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'permission.request',
        toolName: 'Bash',
        toolInput: 'npm test',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('Permission needed'),
      );
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toContain('🔐');
      expect(sentMsg).toContain('`Bash`');
      expect(sentMsg).toContain('`npm test`');
    });

    it('sends permission message without toolInput when empty', async () => {
      const mockMessaging = createMockMessaging();
      await startServer({
        messaging: mockMessaging as any,
        stateManager: makeState() as any,
        pendingTracker: createMockPendingTracker() as any,
      });

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'permission.request',
        toolName: 'Bash',
        toolInput: '',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toBe('🔐 *Permission needed:* `Bash`');
    });

    it('uses "unknown" when toolName is missing', async () => {
      const mockMessaging = createMockMessaging();
      await startServer({
        messaging: mockMessaging as any,
        stateManager: makeState() as any,
        pendingTracker: createMockPendingTracker() as any,
      });

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'permission.request',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toContain('`unknown`');
    });
  });

  describe('task.completed', () => {
    it('sends task completed message with subject', async () => {
      const mockMessaging = createMockMessaging();
      await startServer({
        messaging: mockMessaging as any,
        stateManager: makeState() as any,
        pendingTracker: createMockPendingTracker() as any,
      });

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'task.completed',
        taskId: 'task-1',
        taskSubject: 'Fix login bug',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('Task completed'),
      );
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toContain('✅');
      expect(sentMsg).toContain('Fix login bug');
    });

    it('includes teammate prefix when provided', async () => {
      const mockMessaging = createMockMessaging();
      await startServer({
        messaging: mockMessaging as any,
        stateManager: makeState() as any,
        pendingTracker: createMockPendingTracker() as any,
      });

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'task.completed',
        taskId: 'task-2',
        taskSubject: 'Write tests',
        teammateName: 'agent-2',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toContain('[agent-2]');
      expect(sentMsg).toContain('Write tests');
    });

    it('sends message without subject when missing', async () => {
      const mockMessaging = createMockMessaging();
      await startServer({
        messaging: mockMessaging as any,
        stateManager: makeState() as any,
        pendingTracker: createMockPendingTracker() as any,
      });

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'task.completed',
        taskId: 'task-3',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toBe('✅ *Task completed*');
    });
  });
});

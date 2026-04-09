import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BridgeHookServer } from '../../src/bridge/hook-server.js';
import type { BridgeHookServerDeps } from '../../src/bridge/hook-server.js';
import {
  createMockMessaging, createMockPendingTracker,
  createMockStateManager, postJSON, postRaw, createServerDeps,
} from './hook-server-helpers.js';

describe('BridgeHookServer', () => {
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

  describe('POST /reload', () => {
    it('calls reloadChannelMappings and returns 200', async () => {
      const reloadFn = vi.fn();
      await startServer({ reloadChannelMappings: reloadFn });

      const res = await postJSON(port, '/reload', {});
      expect(res.status).toBe(200);
      expect(res.body).toBe('OK');
      expect(reloadFn).toHaveBeenCalledOnce();
    });
  });

  describe('POST /send-files', () => {
    it('returns 400 for missing projectName', async () => {
      await startServer();

      const res = await postJSON(port, '/send-files', { files: ['/tmp/f.png'] });
      expect(res.status).toBe(400);
      expect(res.body).toContain('projectName');
    });

    it('returns 400 for empty files array', async () => {
      await startServer();

      const res = await postJSON(port, '/send-files', { projectName: 'test', files: [] });
      expect(res.status).toBe(400);
      expect(res.body).toContain('No files');
    });

    it('returns 404 for unknown project', async () => {
      await startServer({ stateManager: createMockStateManager({}) as any });

      const res = await postJSON(port, '/send-files', { projectName: 'nonexistent', files: ['/tmp/f.png'] });
      expect(res.status).toBe(404);
      expect(res.body).toContain('Project not found');
    });

    it('returns 404 when no channel found for project', async () => {
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          runtimeSession: 'bridge',
          agents: { claude: true },
          discordChannels: {},
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      await startServer({ stateManager: stateManager as any });

      const res = await postJSON(port, '/send-files', { projectName: 'test', files: ['/tmp/f.png'] });
      expect(res.status).toBe(404);
      expect(res.body).toContain('No channel');
    });

    it('sends files for valid project with channelId', async () => {
      const filesDir = join(tempDir, '.discode', 'files');
      mkdirSync(filesDir, { recursive: true });
      const testFile = join(filesDir, 'test.png');
      writeFileSync(testFile, 'fake-png-data');

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
      await startServer({ messaging: mockMessaging as any, stateManager: stateManager as any });

      const res = await postJSON(port, '/send-files', {
        projectName: 'test',
        agentType: 'claude',
        files: [testFile],
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith('ch-123', '', [testFile]);
    });

    it('rejects files outside the project directory', async () => {
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
      await startServer({ messaging: mockMessaging as any, stateManager: stateManager as any });

      // File outside projectPath
      const outsideFile = join(realpathSync(tmpdir()), 'outside.txt');
      writeFileSync(outsideFile, 'outside');
      try {
        const res = await postJSON(port, '/send-files', {
          projectName: 'test',
          agentType: 'claude',
          files: [outsideFile],
        });
        expect(res.status).toBe(400);
        expect(res.body).toContain('No valid files');
      } finally {
        rmSync(outsideFile, { force: true });
      }
    });
  });
});

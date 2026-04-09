import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import { mkdirSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BridgeHookServer } from '../../src/bridge/hook-server.js';
import type { BridgeHookServerDeps } from '../../src/bridge/hook-server.js';
import {
  createMockMessaging, createMockStateManager,
  postJSON, postRaw, getRequest, createServerDeps,
  TEST_AUTH_TOKEN,
} from './hook-server-helpers.js';

describe('BridgeHookServer — HTTP infra + runtime API', () => {
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

  describe('HTTP method filtering', () => {
    it('rejects non-POST requests', async () => {
      await startServer();

      const res = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, path: '/reload', method: 'GET', headers: { 'Authorization': `Bearer ${TEST_AUTH_TOKEN}` } },
          (res) => resolve({ status: res.statusCode || 0 }),
        );
        req.on('error', reject);
        req.end();
      });
      expect(res.status).toBe(405);
    });
  });

  describe('request limits', () => {
    it('returns 413 when body is too large', async () => {
      await startServer();

      const huge = JSON.stringify({ text: 'x'.repeat(300_000) });
      const res = await postRaw(port, '/runtime/input', huge);
      expect(res.status).toBe(413);
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      await startServer();

      const res = await postJSON(port, '/unknown', {});
      expect(res.status).toBe(404);
    });
  });

  describe('runtime control API', () => {
    function createMockRuntime() {
      const windows = [
        {
          sessionName: 'bridge',
          windowName: 'project-claude',
          status: 'running',
          pid: 1234,
        },
      ];

      return {
        getOrCreateSession: vi.fn().mockReturnValue('bridge'),
        setSessionEnv: vi.fn(),
        windowExists: vi.fn((sessionName: string, windowName: string) => sessionName === 'bridge' && windowName === 'project-claude'),
        startAgentInWindow: vi.fn(),
        sendKeysToWindow: vi.fn(),
        typeKeysToWindow: vi.fn(),
        sendEnterToWindow: vi.fn(),
        stopWindow: vi.fn().mockReturnValue(true),
        listWindows: vi.fn().mockReturnValue(windows),
        getWindowBuffer: vi.fn().mockReturnValue('hello-runtime'),
      };
    }

    it('returns runtime windows via GET /runtime/windows', async () => {
      await startServer({ runtime: createMockRuntime() as any });

      const res = await getRequest(port, '/runtime/windows');
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body) as { windows: Array<{ windowId: string }> };
      expect(parsed.windows[0].windowId).toBe('bridge:project-claude');
    });

    it('focuses and sends input to runtime window', async () => {
      const runtime = createMockRuntime();
      await startServer({ runtime: runtime as any });

      const focusRes = await postJSON(port, '/runtime/focus', { windowId: 'bridge:project-claude' });
      expect(focusRes.status).toBe(200);

      const inputRes = await postJSON(port, '/runtime/input', {
        text: 'hello',
        submit: true,
      });
      expect(inputRes.status).toBe(200);
      expect(runtime.typeKeysToWindow).toHaveBeenCalledWith('bridge', 'project-claude', 'hello');
      expect(runtime.sendEnterToWindow).toHaveBeenCalledWith('bridge', 'project-claude');
    });

    it('returns buffer slices via GET /runtime/buffer', async () => {
      await startServer({ runtime: createMockRuntime() as any });

      const res = await getRequest(port, '/runtime/buffer?windowId=bridge:project-claude&since=5');
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body) as { chunk: string; next: number };
      expect(parsed.chunk).toBe('-runtime');
      expect(parsed.next).toBe(13);
    });

    it('returns 501 when runtime control is unavailable', async () => {
      await startServer();

      const res = await getRequest(port, '/runtime/windows');
      expect(res.status).toBe(501);
    });

    it('stops runtime window via POST /runtime/stop', async () => {
      const runtime = createMockRuntime();
      await startServer({ runtime: runtime as any });

      const res = await postJSON(port, '/runtime/stop', { windowId: 'bridge:project-claude' });
      expect(res.status).toBe(200);
      expect(runtime.stopWindow).toHaveBeenCalledWith('bridge', 'project-claude');
    });

    it('ensures runtime window via POST /runtime/ensure', async () => {
      const runtime = createMockRuntime();
      runtime.windowExists = vi.fn().mockReturnValue(false);

      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          runtimeSession: 'bridge',
          createdAt: new Date().toISOString(),
          lastActive: new Date().toISOString(),
          instances: {
            opencode: {
              instanceId: 'opencode',
              agentType: 'opencode',
              runtimeWindow: 'test-opencode',
              channelId: 'C123',
            },
          },
        },
      });

      await startServer({ runtime: runtime as any, stateManager: stateManager as any });

      const res = await postJSON(port, '/runtime/ensure', { projectName: 'test', instanceId: 'opencode' });
      expect(res.status).toBe(200);
      expect(runtime.startAgentInWindow).toHaveBeenCalledWith(
        'bridge',
        'test-opencode',
        expect.stringContaining('opencode'),
      );
    });
  });
});

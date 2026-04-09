/**
 * Tests for hook server resilience when messaging or tracker calls fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import { mkdirSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PendingMessageTracker } from '../../src/bridge/pending-message-tracker.js';
import { BridgeHookServer } from '../../src/bridge/hook-server.js';
import type { BridgeHookServerDeps } from '../../src/bridge/hook-server.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createMockMessaging() {
  return {
    platform: 'discord' as const,
    onMessage: vi.fn(),
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    replyInThreadWithId: vi.fn().mockResolvedValue('thread-msg-ts'),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockStateManager(projects: Record<string, any> = {}) {
  return {
    getProject: vi.fn((name: string) => projects[name]),
    setProject: vi.fn(),
    listProjects: vi.fn().mockReturnValue(Object.values(projects)),
    reload: vi.fn(),
    removeProject: vi.fn(),
    getGuildId: vi.fn(),
    setGuildId: vi.fn(),
    updateLastActive: vi.fn(),
    findProjectByChannel: vi.fn(),
    getAgentTypeByChannel: vi.fn(),
  };
}

function createMockPendingTracker() {
  return {
    markPending: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markError: vi.fn().mockResolvedValue(undefined),
    hasPending: vi.fn().mockReturnValue(true),
    ensurePending: vi.fn().mockResolvedValue(undefined),
    ensureStartMessage: vi.fn().mockResolvedValue(undefined),
    getPending: vi.fn().mockReturnValue(undefined),
  };
}

const TEST_AUTH_TOKEN = 'test-hook-token-resilience';

function postJSON(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Authorization': `Bearer ${TEST_AUTH_TOKEN}` } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Tests ───────────────────────────────────────────────────────────

describe('hook server error resilience', () => {
  let tempDir: string;
  let server: BridgeHookServer;
  let port: number;

  beforeEach(() => {
    const rawDir = join(tmpdir(), `discode-err-recovery-${Date.now()}`);
    mkdirSync(rawDir, { recursive: true });
    tempDir = realpathSync(rawDir);
  });

  afterEach(() => {
    server?.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function startServer(deps: Partial<BridgeHookServerDeps> = {}): Promise<BridgeHookServer> {
    const fullDeps: BridgeHookServerDeps = {
      port: 0,
      messaging: createMockMessaging() as any,
      stateManager: createMockStateManager() as any,
      pendingTracker: createMockPendingTracker() as any,
      streamingUpdater: { canStream: vi.fn(), start: vi.fn(), append: vi.fn(),
      appendCumulative: vi.fn(), finalize: vi.fn(), discard: vi.fn(), has: vi.fn() } as any,
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

  it('does not crash when sendToChannel throws during session.idle', async () => {
    const mockMessaging = createMockMessaging();
    mockMessaging.sendToChannel.mockRejectedValue(new Error('Discord API error'));
    const stateManager = createMockStateManager({ test: project });

    await startServer({
      messaging: mockMessaging as any,
      stateManager: stateManager as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Hello',
    });

    expect(res.status).toBe(200);

    const res2 = await postJSON(port, '/reload', {});
    expect(res2.status).toBe(200);
  });

  it('does not crash when sendToChannel throws during session.error', async () => {
    const mockMessaging = createMockMessaging();
    mockMessaging.sendToChannel.mockRejectedValue(new Error('Slack API error'));
    const stateManager = createMockStateManager({ test: project });

    await startServer({
      messaging: mockMessaging as any,
      stateManager: stateManager as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.error',
      text: 'Agent crashed',
    });

    expect(res.status).toBe(200);

    const res2 = await postJSON(port, '/reload', {});
    expect(res2.status).toBe(200);
  });

  it('delivers message even when markCompleted fails', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.markCompleted.mockRejectedValue(new Error('Reaction API failed'));
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
      text: 'Important response',
    });

    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'Important response');
  });

  it('delivers error message even when markError fails', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.markError.mockRejectedValue(new Error('Reaction API failed'));
    const stateManager = createMockStateManager({ test: project });

    await startServer({
      messaging: mockMessaging as any,
      stateManager: stateManager as any,
      pendingTracker: mockPendingTracker as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.error',
      text: 'Something failed',
    });

    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Something failed'),
    );
  });

  it('returns 400 for malformed JSON body', async () => {
    await startServer();

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const body = 'this is not json{{{';
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/opencode-event',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': `Bearer ${TEST_AUTH_TOKEN}` },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    expect(res.status).toBe(400);
    expect(res.body).toContain('Invalid JSON');
  });

  it('returns 400 for missing projectName in opencode-event', async () => {
    await startServer();

    const res = await postJSON(port, '/opencode-event', {
      type: 'session.idle',
      text: 'No project',
    });

    expect(res.status).toBe(400);
  });

  it('returns false (400) when project is not found', async () => {
    const stateManager = createMockStateManager({});
    await startServer({ stateManager: stateManager as any });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'nonexistent',
      type: 'session.idle',
      text: 'Hello',
    });

    expect(res.status).toBe(400);
  });

  it('does not send message when session.idle text is empty', async () => {
    const mockMessaging = createMockMessaging();
    const stateManager = createMockStateManager({ test: project });

    await startServer({
      messaging: mockMessaging as any,
      stateManager: stateManager as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: '',
    });

    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
  });
});

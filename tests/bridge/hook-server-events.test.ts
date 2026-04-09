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

describe('BridgeHookServer — /opencode-event', () => {
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

  describe('POST /opencode-event', () => {
    it('handles session.idle with text', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      await startServer({
        messaging: mockMessaging as any,
        stateManager: makeState() as any,
        pendingTracker: mockPendingTracker as any,
      });

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Hello from agent',
      });
      expect(res.status).toBe(200);
      expect(mockPendingTracker.markCompleted).toHaveBeenCalled();
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Hello from agent');
    });

    it('strips file paths from display text in session.idle', async () => {
      const filesDir = join(tempDir, '.discode', 'files');
      mkdirSync(filesDir, { recursive: true });
      const testFile = join(filesDir, 'output.png');
      writeFileSync(testFile, 'png-data');

      const mockMessaging = createMockMessaging();
      await startServer({
        messaging: mockMessaging as any,
        stateManager: makeState() as any,
        pendingTracker: createMockPendingTracker() as any,
      });

      const textWithPath = `Here is the output: ${testFile}`;
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: textWithPath,
      });
      expect(res.status).toBe(200);

      const sentText = mockMessaging.sendToChannel.mock.calls[0]?.[1] || '';
      expect(sentText).not.toContain(testFile);
      expect(sentText).toContain('Here is the output:');

      expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith('ch-123', '', [testFile]);
    });

    it('handles session.error', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      await startServer({
        messaging: mockMessaging as any,
        stateManager: makeState() as any,
        pendingTracker: mockPendingTracker as any,
      });

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.error',
        text: 'Something went wrong',
      });
      expect(res.status).toBe(200);
      expect(mockPendingTracker.markError).toHaveBeenCalled();
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('Something went wrong'),
      );
    });

    // ── validation ───────────────────────────────────────────────

    it('returns 400 for missing projectName', async () => {
      await startServer();

      const res = await postJSON(port, '/opencode-event', { type: 'session.idle' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid JSON body', async () => {
      await startServer();

      const res = await postRaw(port, '/opencode-event', 'not valid json');
      expect(res.status).toBe(400);
      expect(res.body).toContain('Invalid JSON');
    });

    it('returns 400 for non-object payload', async () => {
      await startServer();

      const res = await postRaw(port, '/opencode-event', '"just a string"');
      expect(res.status).toBe(400);
      expect(res.body).toContain('Invalid event payload');
    });

    it('returns 400 for unknown project', async () => {
      await startServer({ stateManager: createMockStateManager({}) as any });

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'nonexistent',
        agentType: 'claude',
        type: 'session.idle',
        text: 'hello',
      });
      expect(res.status).toBe(400);
    });

    // ── getEventText ─────────────────────────────────────────────

    it('prefers text over message field in getEventText', async () => {
      const mockMessaging = createMockMessaging();
      await startServer({
        messaging: mockMessaging as any,
        stateManager: makeState() as any,
        pendingTracker: createMockPendingTracker() as any,
      });

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'from text field',
        message: 'from message field',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'from text field');
    });

    it('falls back to message field when text is missing', async () => {
      const mockMessaging = createMockMessaging();
      await startServer({
        messaging: mockMessaging as any,
        stateManager: makeState() as any,
        pendingTracker: createMockPendingTracker() as any,
      });

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        message: 'fallback message',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'fallback message');
    });

    // ── edge cases ───────────────────────────────────────────────

    it('handles session.error without text (defaults to "unknown error")', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      await startServer({
        messaging: mockMessaging as any,
        stateManager: makeState() as any,
        pendingTracker: mockPendingTracker as any,
      });

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.error',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('unknown error'),
      );
    });

    it('handles session.idle with empty text (no message sent)', async () => {
      const mockMessaging = createMockMessaging();
      await startServer({
        messaging: mockMessaging as any,
        stateManager: makeState() as any,
        pendingTracker: createMockPendingTracker() as any,
      });

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('handles unknown event type gracefully', async () => {
      const mockMessaging = createMockMessaging();
      await startServer({
        messaging: mockMessaging as any,
        stateManager: makeState() as any,
        pendingTracker: createMockPendingTracker() as any,
      });

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'some.future.event',
        text: 'hello',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });
  });
});

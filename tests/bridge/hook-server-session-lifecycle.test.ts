import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BridgeHookServer } from '../../src/bridge/hook-server.js';
import type { BridgeHookServerDeps } from '../../src/bridge/hook-server.js';
import {
  createMockMessaging, createMockPendingTracker, createMockStreamingUpdater,
  createMockStateManager, postJSON, createServerDeps,
} from './hook-server-helpers.js';

describe('BridgeHookServer — session lifecycle', () => {
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

  // ── session.start ──────────────────────────────────────────────

  it('does not send session.start message for startup source', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.start',
      source: 'startup',
      model: 'opus',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('handles session.start without model', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.start',
      source: 'api',
    });
    expect(res.status).toBe(200);
  });

  it('handles session.start without source (defaults to unknown)', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.start',
    });
    expect(res.status).toBe(200);
  });

  // ── session.end ────────────────────────────────────────────────

  it('handles session.end event', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.end',
      reason: 'model',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      expect.stringContaining('ended'),
    );
  });

  it('handles session.end without reason (defaults to unknown)', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.end',
    });
    expect(res.status).toBe(200);
    const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
    expect(sentMsg).toContain('unknown');
  });

  it('handles session.end with prompt_input_exit reason', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.end',
      reason: 'prompt_input_exit',
    });
    expect(res.status).toBe(200);
    const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
    expect(sentMsg).toContain('prompt_input_exit');
  });

  // ── setHookActive ──────────────────────────────────────────────

  it('session.end calls setHookActive on pending tracker', async () => {
    const mockPendingTracker = createMockPendingTracker();
    await startServer({
      messaging: createMockMessaging() as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
    });

    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.end',
      reason: 'model',
    });

    expect(mockPendingTracker.setHookActive).toHaveBeenCalledWith('test', 'claude', 'claude');
  });

  it('session.start calls setHookActive on pending tracker', async () => {
    const mockPendingTracker = createMockPendingTracker();
    await startServer({
      messaging: createMockMessaging() as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
    });

    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.start',
      source: 'model',
      model: 'opus',
    });

    expect(mockPendingTracker.setHookActive).toHaveBeenCalledWith('test', 'claude', 'claude');
  });

  // ── lifecycle timers ───────────────────────────────────────────

  it('session.start lifecycle timer resolves pending after 5s with no AI activity', async () => {
    vi.useFakeTimers();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.hasPending.mockReturnValue(true);
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-1',
    });

    const hookServer = new BridgeHookServer({
      port: 0,
      messaging: createMockMessaging() as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
      streamingUpdater: createMockStreamingUpdater() as any,
      reloadChannelMappings: vi.fn(),
    });

    await hookServer.handleOpencodeEvent({
      projectName: 'test',
      agentType: 'claude',
      type: 'session.start',
      source: 'model',
      model: 'opus',
    });

    expect(mockPendingTracker.markCompleted).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5001);
    expect(mockPendingTracker.markCompleted).toHaveBeenCalledWith('test', 'claude', 'claude');

    hookServer.stop();
    vi.useRealTimers();
  });

  it('session.start lifecycle timer does NOT resolve when AI activity started (startMessageId set)', async () => {
    vi.useFakeTimers();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.hasPending.mockReturnValue(true);
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-1',
      startMessageId: 'start-msg-ts',
    });

    const hookServer = new BridgeHookServer({
      port: 0,
      messaging: createMockMessaging() as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
      streamingUpdater: createMockStreamingUpdater() as any,
      reloadChannelMappings: vi.fn(),
    });

    await hookServer.handleOpencodeEvent({
      projectName: 'test',
      agentType: 'claude',
      type: 'session.start',
      source: 'model',
      model: 'opus',
    });

    vi.advanceTimersByTime(5001);
    expect(mockPendingTracker.markCompleted).not.toHaveBeenCalled();

    hookServer.stop();
    vi.useRealTimers();
  });

  it('thinking.start cancels session lifecycle timer', async () => {
    vi.useFakeTimers();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.hasPending.mockReturnValue(true);
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-1',
    });

    const hookServer = new BridgeHookServer({
      port: 0,
      messaging: createMockMessaging() as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
      streamingUpdater: createMockStreamingUpdater() as any,
      reloadChannelMappings: vi.fn(),
    });

    await hookServer.handleOpencodeEvent({
      projectName: 'test',
      agentType: 'claude',
      type: 'session.start',
      source: 'api',
    });

    await hookServer.handleOpencodeEvent({
      projectName: 'test',
      agentType: 'claude',
      type: 'thinking.start',
    });

    vi.advanceTimersByTime(5001);
    expect(mockPendingTracker.markCompleted).not.toHaveBeenCalled();

    hookServer.stop();
    vi.useRealTimers();
  });

  it('tool.activity cancels session lifecycle timer', async () => {
    vi.useFakeTimers();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.hasPending.mockReturnValue(true);
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-1',
    });

    const hookServer = new BridgeHookServer({
      port: 0,
      messaging: createMockMessaging() as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
      streamingUpdater: createMockStreamingUpdater() as any,
      reloadChannelMappings: vi.fn(),
    });

    await hookServer.handleOpencodeEvent({
      projectName: 'test',
      agentType: 'claude',
      type: 'session.start',
      source: 'api',
    });

    await hookServer.handleOpencodeEvent({
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: 'Reading file...',
    });

    vi.advanceTimersByTime(5001);
    expect(mockPendingTracker.markCompleted).not.toHaveBeenCalled();

    hookServer.stop();
    vi.useRealTimers();
  });

  // ── ensurePending for session.start ────────────────────────────

  it('does not call ensurePending for session.start', async () => {
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.hasPending.mockReturnValue(false);
    mockPendingTracker.ensurePending = vi.fn();
    await startServer({
      messaging: createMockMessaging() as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
    });

    await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.start',
      source: 'tmux',
    });

    expect(mockPendingTracker.ensurePending).not.toHaveBeenCalled();
  });
});

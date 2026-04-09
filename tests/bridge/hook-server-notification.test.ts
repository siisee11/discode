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

describe('BridgeHookServer — session.notification', () => {
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

  it('handles session.notification with permission_prompt', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.notification',
      notificationType: 'permission_prompt',
      text: 'Claude wants to run a command',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      expect.stringContaining('Claude wants to run a command'),
    );
    const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
    expect(sentMsg).toContain('🔐');
  });

  it('handles session.notification with idle_prompt', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.notification',
      notificationType: 'idle_prompt',
      text: 'Claude is waiting for input',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      expect.stringContaining('Claude is waiting for input'),
    );
    const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
    expect(sentMsg).toContain('💤');
  });

  it('handles session.notification with auth_success', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.notification',
      notificationType: 'auth_success',
      text: 'Authentication succeeded',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      expect.stringContaining('Authentication succeeded'),
    );
    const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
    expect(sentMsg).toContain('🔑');
  });

  it('handles session.notification with elicitation_dialog', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.notification',
      notificationType: 'elicitation_dialog',
      text: 'Claude has a question',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      expect.stringContaining('Claude has a question'),
    );
    const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
    expect(sentMsg).toContain('❓');
  });

  it('handles session.notification without text (falls back to notificationType)', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.notification',
      notificationType: 'permission_prompt',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      expect.stringContaining('permission_prompt'),
    );
  });

  it('handles session.notification without notificationType', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.notification',
      text: 'Some notification',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      expect.stringContaining('Some notification'),
    );
  });

  it('handles session.notification with both text and notificationType missing', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.notification',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      expect.stringContaining('unknown'),
    );
  });

  it('handles session.notification with unknown type using bell emoji', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.notification',
      notificationType: 'some_future_type',
      text: 'Future notification',
    });
    expect(res.status).toBe(200);
    const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
    expect(sentMsg).toContain('🔔');
  });

  it('sends promptText after notification message for session.notification', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.notification',
      notificationType: 'permission_prompt',
      text: 'Allow bash?',
      promptText: '📋 Plan approval needed',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel.mock.calls.length).toBeGreaterThanOrEqual(2);
    const calls = mockMessaging.sendToChannel.mock.calls;
    expect(calls[0][1]).toContain('Allow bash?');
    expect(calls[1][1]).toContain('Plan approval needed');
  });

  it('does not send promptText when empty in session.notification', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.notification',
      notificationType: 'permission_prompt',
      text: 'Allow?',
      promptText: '',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
  });

  it('does not send promptText when not a string in session.notification', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.notification',
      notificationType: 'permission_prompt',
      text: 'Allow?',
      promptText: 42,
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
  });

  it('skips promptText for elicitation_dialog to avoid duplicate with session.idle buttons', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.notification',
      notificationType: 'elicitation_dialog',
      text: 'Claude has a question',
      promptText: '❓ *Auth method*\nWhich library?\n• *OAuth* — Standard\n• *JWT* — Tokens',
    });
    expect(res.status).toBe(200);
    // Only the notification message should be sent, not the promptText
    expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
    expect(mockMessaging.sendToChannel.mock.calls[0][1]).toContain('Claude has a question');
    expect(mockMessaging.sendToChannel.mock.calls[0][1]).toContain('❓');
  });

  it('still sends promptText for non-elicitation notification types', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.notification',
      notificationType: 'idle_prompt',
      text: 'Waiting for input',
      promptText: '❓ Choose an option',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockMessaging.sendToChannel.mock.calls[0][1]).toContain('Waiting for input');
    expect(mockMessaging.sendToChannel.mock.calls[1][1]).toContain('Choose an option');
  });

  it('sends ExitPlanMode promptText in session.notification', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.notification',
      notificationType: 'permission_prompt',
      text: 'Allow?',
      promptText: '📋 Plan approval needed',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockMessaging.sendToChannel.mock.calls[1][1]).toContain('Plan approval needed');
  });
});

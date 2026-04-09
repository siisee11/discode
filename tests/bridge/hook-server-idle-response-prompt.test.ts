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

describe('BridgeHookServer — idle response promptText & platform', () => {
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

  it('sends promptText as additional message after response text', async () => {
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
      text: 'Which approach?',
      promptText: '❓ *Approach*\nWhich approach?\n\n• *Fast* — Quick\n• *Safe* — Reliable',
    });
    expect(res.status).toBe(200);
    // First call: response text, second call: prompt text
    expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(2);
    expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Which approach?');
    expect(mockMessaging.sendToChannel.mock.calls[1][1]).toContain('*Approach*');
    expect(mockMessaging.sendToChannel.mock.calls[1][1]).toContain('*Fast*');
  });

  it('does not send extra message when promptText is empty', async () => {
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
      text: 'Hello from agent',
      promptText: '',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
    expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Hello from agent');
  });

  it('uses Discord splitting for promptText on discord platform', async () => {
    const mockMessaging = createMockMessaging();
    mockMessaging.platform = 'discord' as const;
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

    // Create promptText > 1900 chars (Discord limit) to trigger splitting
    const lines = Array.from({ length: 40 }, (_, i) => `• *Option ${i}* — ${'x'.repeat(40)}`);
    const longPrompt = `❓ *Big question*\nPick one?\n${lines.join('\n')}`;
    expect(longPrompt.length).toBeGreaterThan(1900);

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Choose one',
      promptText: longPrompt,
    });
    expect(res.status).toBe(200);
    // First call: response text, subsequent calls: split promptText chunks
    expect(mockMessaging.sendToChannel.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Choose one');
  });

  it('does not send promptText that is whitespace only', async () => {
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
      text: 'Hello',
      promptText: '   \n  ',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
    expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Hello');
  });

  it('sends thinking + text + promptText in correct order', async () => {
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
      text: 'Here are options.',
      thinking: 'Analyzing requirements...',
      promptText: '❓ Pick an approach?',
    });
    expect(res.status).toBe(200);

    // Thinking → channel message (no longer thread reply)
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      expect.stringContaining('Analyzing requirements'),
    );
    // Text and promptText → channel messages
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Here are options.');
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      expect.stringContaining('Pick an approach?'),
    );
  });

  it('sends promptText with files in correct order', async () => {
    const filesDir = join(tempDir, '.discode', 'files');
    mkdirSync(filesDir, { recursive: true });
    const testFile = join(filesDir, 'diagram.png');
    writeFileSync(testFile, 'png-data');

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
      text: `Here is the diagram: ${testFile}`,
      turnText: `Created ${testFile}`,
      promptText: '❓ Does this look correct?',
    });
    expect(res.status).toBe(200);

    // Text (with file path stripped) → channel message
    const sentText = mockMessaging.sendToChannel.mock.calls[0]?.[1] || '';
    expect(sentText).not.toContain(testFile);
    // Files sent
    expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith('ch-123', '', [testFile]);
    // PromptText → additional channel message
    const lastCall = mockMessaging.sendToChannel.mock.calls[mockMessaging.sendToChannel.mock.calls.length - 1];
    expect(lastCall[1]).toContain('Does this look correct?');
  });

  it('does not send promptText when type is not string', async () => {
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
      text: 'Hello',
      promptText: 12345,
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
    expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Hello');
  });

  it('sends promptText even when text is empty', async () => {
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
      promptText: '📋 Plan approval needed',
    });
    expect(res.status).toBe(200);
    expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
    expect(mockMessaging.sendToChannel.mock.calls[0][1]).toContain('Plan approval needed');
  });

  it('skips empty text chunks', async () => {
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
      text: '   ',
    });
    expect(res.status).toBe(200);
    // No message should be sent for whitespace-only text
    expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('uses Slack splitting for slack platform', async () => {
    const mockMessaging = createMockMessaging();
    mockMessaging.platform = 'slack' as const;
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

    // Create a message that's > 1900 chars (Discord limit) but < 3900 (Slack limit)
    const longText = 'x'.repeat(2500);
    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: longText,
    });
    expect(res.status).toBe(200);
    // With Slack splitting (3900 limit), the message should be sent as a single chunk
    expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
  });
});

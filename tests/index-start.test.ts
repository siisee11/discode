/**
 * Tests for AgentBridge.start() method
 *
 * Tests messaging connect, channel mapping registration,
 * event-hook marking, reactions, agent submission, and tmux error handling.
 */

const pluginInstallerMocks = vi.hoisted(() => ({
  installOpencodePlugin: vi.fn().mockReturnValue('/mock/opencode/plugin.ts'),
  installClaudePlugin: vi.fn().mockReturnValue('/mock/claude/plugin'),
  installGeminiHook: vi.fn().mockReturnValue('/mock/gemini/hook.js'),
}));

vi.mock('../src/agents/opencode/plugin-installer.js', () => ({
  installOpencodePlugin: pluginInstallerMocks.installOpencodePlugin,
  getPluginSourcePath: () => '/mock/src/opencode/plugin/agent-opencode-bridge-plugin.ts',
  getOpencodePluginDir: () => '/mock/opencode/plugins',
  OPENCODE_PLUGIN_FILENAME: 'agent-opencode-bridge-plugin.ts',
}));

vi.mock('../src/agents/claude/plugin-installer.js', () => ({
  installClaudePlugin: pluginInstallerMocks.installClaudePlugin,
  getClaudePluginDir: () => '/mock/claude/plugin',
  getPluginSourceDir: () => '/mock/claude/plugin-source',
  CLAUDE_PLUGIN_NAME: 'discode-claude-bridge',
}));

vi.mock('../src/agents/gemini/hook-installer.js', () => ({
  installGeminiHook: pluginInstallerMocks.installGeminiHook,
  getGeminiHookSourcePath: () => '/mock/gemini/hook.js',
  getGeminiConfigDir: () => '/mock/gemini/config',
  getGeminiHookDir: () => '/mock/gemini/hooks',
  getGeminiSettingsPath: () => '/mock/gemini/settings.json',
  removeGeminiHook: vi.fn(),
  GEMINI_HOOK_NAME: 'discode-gemini-after-agent',
  GEMINI_AFTER_AGENT_HOOK_FILENAME: 'discode-after-agent-hook.js',
  GEMINI_NOTIFICATION_HOOK_FILENAME: 'discode-notification-hook.js',
  GEMINI_SESSION_HOOK_FILENAME: 'discode-session-hook.js',
  GEMINI_NOTIFICATION_HOOK_NAME: 'discode-gemini-notification',
  GEMINI_SESSION_HOOK_NAME: 'discode-gemini-session',
}));

import { AgentBridge } from '../src/index.js';
import type { IStateManager } from '../src/types/interfaces.js';
import type { BridgeConfig, ProjectState } from '../src/types/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock helpers
function createMockConfig(): BridgeConfig {
  return {
    discord: { token: 'test-token' },
    tmux: { sessionPrefix: 'agent-' },
    hookServerPort: 19999,
  };
}

function createMockStateManager(): IStateManager {
  return {
    reload: vi.fn(),
    getProject: vi.fn(),
    setProject: vi.fn(),
    removeProject: vi.fn(),
    listProjects: vi.fn().mockReturnValue([]),
    getGuildId: vi.fn().mockReturnValue('guild-123'),
    setGuildId: vi.fn(),
    getWorkspaceId: vi.fn().mockReturnValue('workspace-123'),
    setWorkspaceId: vi.fn(),
    updateLastActive: vi.fn(),
    findProjectByChannel: vi.fn(),
    getAgentTypeByChannel: vi.fn(),
  };
}

function createMockMessaging() {
  return {
    platform: 'discord',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    registerChannelMappings: vi.fn(),
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    getGuilds: vi.fn().mockReturnValue([]),
    getChannelMapping: vi.fn().mockReturnValue(new Map()),
    createAgentChannels: vi.fn().mockResolvedValue({ claude: 'ch-123' }),
    deleteChannel: vi.fn(),
    sendApprovalRequest: vi.fn(),
    sendQuestionWithButtons: vi.fn(),
    setTargetChannel: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
}

function createMockTmux() {
  return {
    getOrCreateSession: vi.fn().mockReturnValue('agent-test'),
    windowExists: vi.fn().mockReturnValue(true),
    createWindow: vi.fn(),
    sendKeysToWindow: vi.fn(),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
    capturePaneFromWindow: vi.fn(),
    startAgentInWindow: vi.fn(),
    setSessionEnv: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    createSession: vi.fn(),
    sendKeys: vi.fn(),
    capturePane: vi.fn(),
    sessionExists: vi.fn(),
    listWindows: vi.fn(),
    dispose: vi.fn(),
  } as any;
}

function createMockRegistry() {
  const mockAdapter = {
    config: { name: 'claude', displayName: 'Claude Code', command: 'claude', channelSuffix: 'claude' },
    getStartCommand: vi.fn().mockReturnValue('cd "/test" && claude'),
    matchesChannel: vi.fn(),
    isInstalled: vi.fn().mockReturnValue(true),
    injectContainerPlugins: vi.fn().mockReturnValue(false),
    buildLaunchCommand: vi.fn().mockImplementation((cmd: string, integration?: any) => {
      const pluginDir = integration?.claudePluginDir;
      if (!pluginDir) return cmd;
      if (/--plugin-dir\b/.test(cmd)) return cmd;
      const pattern = /((?:^|&&|;)\s*)claude\b/;
      if (!pattern.test(cmd)) return cmd;
      return cmd.replace(pattern, `$1claude --plugin-dir '${pluginDir}'`);
    }),
    getExtraEnvVars: vi.fn().mockReturnValue({}),
  };
  return {
    get: vi.fn().mockReturnValue(mockAdapter),
    getAll: vi.fn().mockReturnValue([mockAdapter]),
    register: vi.fn(),
    getByChannelSuffix: vi.fn(),
    parseChannelName: vi.fn(),
    _mockAdapter: mockAdapter,
  } as any;
}

describe('AgentBridge – start', () => {
  let bridge: AgentBridge;
  let mockMessaging: any;
  let mockStateManager: any;

  beforeEach(() => {
    pluginInstallerMocks.installOpencodePlugin.mockClear();
    pluginInstallerMocks.installClaudePlugin.mockClear();
    pluginInstallerMocks.installGeminiHook.mockClear();

    mockMessaging = createMockMessaging();
    mockStateManager = createMockStateManager();
    bridge = new AgentBridge({
      messaging: mockMessaging,
      runtime: createMockTmux(),
      stateManager: mockStateManager,
      registry: createMockRegistry(),
      config: createMockConfig(),
    });
  });

  afterEach(async () => {
    await bridge.stop();
  });

  it('connects messaging client and registers channel mappings from state', async () => {
    const projects: ProjectState[] = [
      {
        projectName: 'test-project',
        projectPath: '/test',
        runtimeSession: 'agent-test',
        discordChannels: { claude: 'ch-123', cursor: 'ch-456' },
        agents: { claude: true },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    ];
    mockStateManager.listProjects.mockReturnValue(projects);

    await bridge.start();

    expect(mockMessaging.connect).toHaveBeenCalledOnce();
    expect(mockMessaging.registerChannelMappings).toHaveBeenCalledWith([
      { channelId: 'ch-123', projectName: 'test-project', agentType: 'claude', instanceId: 'claude' },
      { channelId: 'ch-456', projectName: 'test-project', agentType: 'cursor', instanceId: 'cursor' },
    ]);
  });

  it('sets up message callback via messaging.onMessage', async () => {
    await bridge.start();

    expect(mockMessaging.onMessage).toHaveBeenCalledOnce();
    expect(mockMessaging.onMessage).toHaveBeenCalledWith(expect.any(Function));
  });

  it('marks claude projects as event-hook driven after plugin install', async () => {
    const projects: ProjectState[] = [
      {
        projectName: 'test-project',
        projectPath: '/test',
        runtimeSession: 'agent-test',
        discordChannels: { claude: 'ch-123' },
        agents: { claude: true },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    ];
    mockStateManager.listProjects.mockReturnValue(projects);

    await bridge.start();

    expect(pluginInstallerMocks.installClaudePlugin).toHaveBeenCalled();
    expect(mockStateManager.setProject).toHaveBeenCalledWith(
      expect.objectContaining({
        eventHooks: expect.objectContaining({ claude: true }),
      })
    );
  });

  it('marks gemini projects as event-hook driven after hook install', async () => {
    const projects: ProjectState[] = [
      {
        projectName: 'test-project',
        projectPath: '/test',
        runtimeSession: 'agent-test',
        discordChannels: { gemini: 'ch-123' },
        agents: { gemini: true },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    ];
    mockStateManager.listProjects.mockReturnValue(projects);

    await bridge.start();

    expect(pluginInstallerMocks.installGeminiHook).toHaveBeenCalled();
    expect(mockStateManager.setProject).toHaveBeenCalledWith(
      expect.objectContaining({
        eventHooks: expect.objectContaining({ gemini: true }),
      })
    );
  });

  it('uses reactions instead of received/completed status messages', async () => {
    const mockTmux = createMockTmux();
    bridge = new AgentBridge({
      messaging: mockMessaging,
      runtime: mockTmux,
      stateManager: mockStateManager,
      registry: createMockRegistry(),
      config: createMockConfig(),
    });

    mockStateManager.getProject.mockReturnValue({
      projectName: 'test-project',
      projectPath: '/test',
      runtimeSession: 'agent-test',
      discordChannels: { claude: 'ch-123' },
      agents: { claude: true },
      createdAt: new Date(),
      lastActive: new Date(),
    });

    await bridge.start();
    const cb = mockMessaging.onMessage.mock.calls[0][0];
    await cb('claude', 'hello', 'test-project', 'ch-123', 'msg-1');

    expect(mockMessaging.addReactionToMessage).toHaveBeenCalledWith('ch-123', 'msg-1', '⏳');
    const statusMessages = mockMessaging.sendToChannel.mock.calls
      .map((c: any[]) => String(c[1] ?? ''))
      .filter((msg) => msg.includes('받은 메시지') || msg.includes('✅ 작업 완료'));
    expect(statusMessages).toHaveLength(0);
  });

  it('submits all agents via type-then-enter with short delay', async () => {
    process.env.DISCODE_OPENCODE_SUBMIT_DELAY_MS = '0';

    const mockTmux = createMockTmux();
    bridge = new AgentBridge({
      messaging: mockMessaging,
      runtime: mockTmux,
      stateManager: mockStateManager,
      registry: createMockRegistry(),
      config: createMockConfig(),
    });

    mockStateManager.getProject.mockReturnValue({
      projectName: 'test-project',
      projectPath: '/test',
      runtimeSession: 'agent-test',
      runtimeWindows: { opencode: 'test-project-opencode' },
      discordChannels: { opencode: 'ch-123' },
      agents: { opencode: true },
      createdAt: new Date(),
      lastActive: new Date(),
    });

    await bridge.start();
    const cb = mockMessaging.onMessage.mock.calls[0][0];
    await cb('opencode', 'hello opencode', 'test-project', 'ch-123');

    expect(mockTmux.typeKeysToWindow).toHaveBeenCalledWith('agent-test', 'test-project-opencode', 'hello opencode', 'opencode');
    expect(mockTmux.sendEnterToWindow).toHaveBeenCalledWith('agent-test', 'test-project-opencode', 'opencode');
  });

  it('shows English recovery guidance when runtime window is missing', async () => {
    process.env.DISCODE_OPENCODE_SUBMIT_DELAY_MS = '0';

    const mockTmux = createMockTmux();
    mockTmux.typeKeysToWindow.mockImplementation(() => {
      throw new Error(
        "Failed to type keys to window 'discode-opencode' in session 'bridge': Command failed: tmux send-keys -t 'bridge:discode-opencode' 'hi'\ncan't find window: discode-opencode",
      );
    });
    bridge = new AgentBridge({
      messaging: mockMessaging,
      runtime: mockTmux,
      stateManager: mockStateManager,
      registry: createMockRegistry(),
      config: createMockConfig(),
    });

    mockStateManager.getProject.mockReturnValue({
      projectName: 'discode',
      projectPath: '/test',
      runtimeSession: 'bridge',
      runtimeWindows: { opencode: 'discode-opencode' },
      discordChannels: { opencode: 'ch-123' },
      agents: { opencode: true },
      createdAt: new Date(),
      lastActive: new Date(),
    });

    await bridge.start();
    const cb = mockMessaging.onMessage.mock.calls[0][0];
    await cb('opencode', 'hi', 'discode', 'ch-123');

    const lastNotice = String(mockMessaging.sendToChannel.mock.calls.at(-1)?.[1] ?? '');
    expect(lastNotice).toContain('agent runtime window is not running');
    expect(lastNotice).toContain('discode new --name discode');
    expect(lastNotice).toContain('discode attach discode');
    expect(lastNotice).not.toContain("can't find window");
  });
});

/**
 * Tests for AgentBridge main class
 *
 * Core tests: sanitizeInput, constructor, setupProject, stop.
 * Start tests: index-start.test.ts
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

describe('AgentBridge', () => {
  beforeEach(() => {
    pluginInstallerMocks.installOpencodePlugin.mockClear();
    pluginInstallerMocks.installClaudePlugin.mockClear();
    pluginInstallerMocks.installGeminiHook.mockClear();
  });

  describe('sanitizeInput', () => {
    it('returns null for empty string', () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      expect(bridge.sanitizeInput('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      expect(bridge.sanitizeInput('   \t\n  ')).toBeNull();
    });

    it('returns null for string > 10000 chars', () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      const longString = 'a'.repeat(10001);
      expect(bridge.sanitizeInput(longString)).toBeNull();
    });

    it('strips null bytes', () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      const input = 'hello\0world\0test';
      expect(bridge.sanitizeInput(input)).toBe('helloworldtest');
    });

    it('returns valid content unchanged', () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      const validContent = 'This is valid content with unicode 한글 emojis 🚀';
      expect(bridge.sanitizeInput(validContent)).toBe(validContent);
    });
  });

  describe('constructor', () => {
    it('creates with all dependencies injected', () => {
      const mockMessaging = createMockMessaging();
      const mockTmux = createMockTmux();
      const mockStateManager = createMockStateManager();
      const mockRegistry = createMockRegistry();
      const mockConfig = createMockConfig();

      const bridge = new AgentBridge({
        messaging: mockMessaging,
        runtime: mockTmux,
        stateManager: mockStateManager,
        registry: mockRegistry,
        config: mockConfig,
      });

      expect(bridge).toBeInstanceOf(AgentBridge);
    });

    it('creates with mocked dependencies', () => {
      // Just verify the class is constructable with mocked deps
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      expect(bridge).toBeInstanceOf(AgentBridge);
      expect(typeof bridge.sanitizeInput).toBe('function');
    });
  });

  describe('setupProject', () => {
    let bridge: AgentBridge;
    let mockMessaging: any;
    let mockTmux: any;
    let mockStateManager: any;
    let mockRegistry: any;

    beforeEach(() => {
      mockMessaging = createMockMessaging();
      mockTmux = createMockTmux();
      mockStateManager = createMockStateManager();
      mockRegistry = createMockRegistry();
      bridge = new AgentBridge({
        messaging: mockMessaging,
        runtime: mockTmux,
        stateManager: mockStateManager,
        registry: mockRegistry,
        config: createMockConfig(),
      });
    });

    it('creates tmux session, messaging channel, saves state', async () => {
      const result = await bridge.setupProject(
        'test-project',
        '/test/path',
        { claude: true }
      );

      expect(mockTmux.getOrCreateSession).toHaveBeenCalledWith('bridge', 'test-project-claude');
      expect(mockMessaging.createAgentChannels).toHaveBeenCalledWith(
        'guild-123',
        'test-project',
        [mockRegistry._mockAdapter.config],
        'test-project-claude',
        { claude: 'claude' },
      );
      expect(mockStateManager.setProject).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'test-project',
          projectPath: '/test/path',
          runtimeSession: 'agent-test',
          eventHooks: { claude: true },
        })
      );
      expect(mockTmux.startAgentInWindow).toHaveBeenCalledWith(
        'agent-test',
        'test-project-claude',
        expect.stringContaining(`--plugin-dir '/mock/claude/plugin'`)
      );
      expect(result).toEqual({
        channelName: 'test-project-claude',
        channelId: 'ch-123',
        agentName: 'Claude Code',
        runtimeSession: 'agent-test',
      });
    });

    it('sets OPENCODE_PERMISSION env when configured to allow', async () => {
      const opencodeAdapter = {
        config: { name: 'opencode', displayName: 'OpenCode', command: 'opencode', channelSuffix: 'opencode' },
        getStartCommand: vi.fn().mockReturnValue('cd "/missing/project/path" && opencode'),
        matchesChannel: vi.fn(),
        isInstalled: vi.fn().mockReturnValue(true),
        injectContainerPlugins: vi.fn().mockReturnValue(false),
        buildLaunchCommand: vi.fn().mockImplementation((cmd: string) => cmd),
        getExtraEnvVars: vi.fn().mockImplementation((opts?: { permissionAllow?: boolean }) => {
          if (opts?.permissionAllow) return { OPENCODE_PERMISSION: '{"*":"allow"}' };
          return {};
        }),
      };
      mockRegistry.getAll.mockReturnValue([opencodeAdapter]);
      mockMessaging.createAgentChannels.mockResolvedValue({ opencode: 'ch-op' });

      bridge = new AgentBridge({
        messaging: mockMessaging,
        runtime: mockTmux,
        stateManager: mockStateManager,
        registry: mockRegistry,
        config: {
          ...createMockConfig(),
          opencode: { permissionMode: 'allow' },
        },
      });

      await bridge.setupProject('test-project', '/missing/project/path', { opencode: true });

      expect(mockTmux.startAgentInWindow).toHaveBeenCalledWith(
        'agent-test',
        'test-project-opencode',
        expect.stringContaining(`export OPENCODE_PERMISSION='{"*":"allow"}';`)
      );
    });

    it('adds claude skip-permissions flag when permission mode is allow', async () => {
      bridge = new AgentBridge({
        messaging: mockMessaging,
        runtime: mockTmux,
        stateManager: mockStateManager,
        registry: mockRegistry,
        config: {
          ...createMockConfig(),
          opencode: { permissionMode: 'allow' },
        },
      });

      await bridge.setupProject('test-project', '/test/path', { claude: true });

      expect(mockRegistry._mockAdapter.getStartCommand).toHaveBeenCalledWith('/test/path', true);
    });

    it('throws when no guild ID configured', async () => {
      mockStateManager.getGuildId.mockReturnValue(undefined);

      await expect(
        bridge.setupProject('test-project', '/test/path', { claude: true })
      ).rejects.toThrow('Server ID not configured');
    });

    it('throws when no agent specified', async () => {
      mockRegistry.getAll.mockReturnValue([]);

      await expect(
        bridge.setupProject('test-project', '/test/path', {})
      ).rejects.toThrow('No agent specified');
    });
  });

  describe('stop', () => {
    it('stops hook server and disconnects messaging client', async () => {
      const mockMessaging = createMockMessaging();
      const mockRuntime = createMockTmux();
      const bridge = new AgentBridge({
        messaging: mockMessaging,
        runtime: mockRuntime,
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      // Start first to create HTTP server
      await bridge.start();

      // Now stop
      await bridge.stop();

      expect(mockRuntime.dispose).toHaveBeenCalledWith('SIGTERM');
      expect(mockMessaging.disconnect).toHaveBeenCalledOnce();
    });
  });
});

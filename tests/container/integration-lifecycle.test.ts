/**
 * Container lifecycle integration tests.
 *
 * Tests stop cleanup of container syncs and
 * restoreRuntimeWindows behavior with container instances.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock container module ────────────────────────────────────────────

const containerMocks = vi.hoisted(() => ({
  isDockerAvailable: vi.fn().mockReturnValue(true),
  createContainer: vi.fn().mockReturnValue('abc123def456'),
  buildDockerStartCommand: vi.fn().mockReturnValue('docker start -ai abc123def456'),
  injectCredentials: vi.fn(),
  injectChromeMcpBridge: vi.fn().mockReturnValue(false),
  injectFile: vi.fn().mockReturnValue(true),
  containerExists: vi.fn().mockReturnValue(true),
  stopContainer: vi.fn().mockReturnValue(true),
  removeContainer: vi.fn().mockReturnValue(true),
  findDockerSocket: vi.fn().mockReturnValue('/var/run/docker.sock'),
  isContainerRunning: vi.fn().mockReturnValue(true),
  ensureImage: vi.fn(),
  removeImage: vi.fn(),
  ChromeMcpProxy: class MockChromeMcpProxy {
    async start() { return false; }
    stop() {}
    isActive() { return false; }
    getPort() { return 18471; }
  },
  WORKSPACE_DIR: '/workspace',
  imageTagFor: (agentType: string) => `discode-agent-${agentType}:1`,
  IMAGE_PREFIX: 'discode-agent',
}));

const syncInstanceMethods = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  finalSync: vi.fn(),
  syncOnce: vi.fn(),
}));

const containerSyncCalls = vi.hoisted(() => ({ args: [] as any[] }));

vi.mock('../../src/container/index.js', () => containerMocks);

vi.mock('../../src/container/sync.js', () => ({
  ContainerSync: class MockContainerSync {
    start = syncInstanceMethods.start;
    stop = syncInstanceMethods.stop;
    finalSync = syncInstanceMethods.finalSync;
    syncOnce = syncInstanceMethods.syncOnce;
    constructor(options: any) {
      containerSyncCalls.args.push(options);
    }
  },
}));

// ── Mock plugin installers ───────────────────────────────────────────

const pluginInstallerMocks = vi.hoisted(() => ({
  installOpencodePlugin: vi.fn().mockReturnValue('/mock/opencode/plugin.ts'),
  installClaudePlugin: vi.fn().mockReturnValue('/mock/claude/plugin'),
  installGeminiHook: vi.fn().mockReturnValue('/mock/gemini/hook.js'),
}));

vi.mock('../../src/opencode/plugin-installer.js', () => ({
  installOpencodePlugin: pluginInstallerMocks.installOpencodePlugin,
  getPluginSourcePath: () => '/mock/src/opencode/plugin/agent-opencode-bridge-plugin.ts',
  OPENCODE_PLUGIN_FILENAME: 'agent-opencode-bridge-plugin.ts',
}));

vi.mock('../../src/claude/plugin-installer.js', () => ({
  installClaudePlugin: pluginInstallerMocks.installClaudePlugin,
}));

vi.mock('../../src/gemini/hook-installer.js', () => ({
  installGeminiHook: pluginInstallerMocks.installGeminiHook,
  getGeminiHookSourcePath: () => '/mock/src/gemini/hook/discode-after-agent-hook.js',
  GEMINI_AFTER_AGENT_HOOK_FILENAME: 'discode-after-agent-hook.js',
  GEMINI_NOTIFICATION_HOOK_FILENAME: 'discode-notification-hook.js',
  GEMINI_SESSION_HOOK_FILENAME: 'discode-session-hook.js',
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { AgentBridge } from '../../src/index.js';
import type { ProjectState } from '../../src/types/index.js';
import {
  createMockConfig,
  createMockStateManager,
  createMockMessaging,
  createMockRuntime,
  createMockRegistry,
} from './integration-helpers.js';

// ── Tests ────────────────────────────────────────────────────────────

describe('container lifecycle integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    containerMocks.isDockerAvailable.mockReturnValue(true);
    containerMocks.createContainer.mockReturnValue('abc123def456');
    containerMocks.buildDockerStartCommand.mockReturnValue('docker start -ai abc123def456');
    containerMocks.containerExists.mockReturnValue(true);
    syncInstanceMethods.start.mockClear();
    syncInstanceMethods.stop.mockClear();
    syncInstanceMethods.finalSync.mockClear();
    containerSyncCalls.args.length = 0;
  });

  describe('setupProject without container', () => {
    it('does not create a container in standard mode', async () => {
      const mockRuntime = createMockRuntime();
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: mockRuntime,
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      await bridge.setupProject('test-project', '/test/path', { claude: true });

      expect(containerMocks.createContainer).not.toHaveBeenCalled();
      expect(containerMocks.injectCredentials).not.toHaveBeenCalled();

      // Should use export prefix + agent command (standard mode)
      expect(mockRuntime.startAgentInWindow).toHaveBeenCalledWith(
        'agent-test',
        'test-project-claude',
        expect.stringContaining('export DISCODE_PROJECT='),
      );
    });

    it('does not save container fields in state', async () => {
      const mockStateManager = createMockStateManager();
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: mockStateManager,
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      await bridge.setupProject('test-project', '/test/path', { claude: true });

      const savedProject = mockStateManager.setProject.mock.calls[0][0];
      const instance = savedProject.instances.claude;
      expect(instance.containerMode).toBeUndefined();
      expect(instance.containerId).toBeUndefined();
    });
  });

  describe('stop cleans up container syncs', () => {
    it('stops all container syncs on bridge stop', async () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      // Create a project to start sync
      await bridge.setupProject('test', '/test', { claude: true });
      expect(syncInstanceMethods.start).toHaveBeenCalled();

      // Stop bridge
      await bridge.stop();

      expect(syncInstanceMethods.stop).toHaveBeenCalled();
    });
  });

  describe('restoreRuntimeWindows with container instances', () => {
    it('uses docker start command for container instances on restore', async () => {
      const mockRuntime = createMockRuntime();
      const mockStateManager = createMockStateManager();

      const existingProject: ProjectState = {
        projectName: 'test-project',
        projectPath: '/test',
        runtimeSession: 'agent-test',
        discordChannels: { claude: 'ch-123' },
        agents: { claude: true },
        instances: {
          claude: {
            instanceId: 'claude',
            agentType: 'claude',
            runtimeWindow: 'test-project-claude',
            channelId: 'ch-123',
            containerMode: true,
            containerId: 'existing-container-id',
            containerName: 'discode-test-project-claude',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      };
      mockStateManager.listProjects.mockReturnValue([existingProject]);

      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: mockRuntime,
        stateManager: mockStateManager,
        registry: createMockRegistry(),
        config: createMockConfig({
          runtimeMode: 'pty-rust',
          container: { enabled: true },
        }),
      });

      await bridge.start();

      // Should have restored window with docker start command
      expect(mockRuntime.startAgentInWindow).toHaveBeenCalledWith(
        'agent-test',
        'test-project-claude',
        'docker start -ai abc123def456',  // from buildDockerStartCommand mock
      );

      // Should have started sync for restored container
      expect(containerSyncCalls.args).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            containerId: 'existing-container-id',
            projectPath: '/test',
          }),
        ]),
      );

      await bridge.stop();
    });

    it('does not use container path for non-container instances on restore', async () => {
      const mockRuntime = createMockRuntime();
      const mockStateManager = createMockStateManager();

      const existingProject: ProjectState = {
        projectName: 'test-project',
        projectPath: '/test',
        runtimeSession: 'agent-test',
        discordChannels: { claude: 'ch-123' },
        agents: { claude: true },
        instances: {
          claude: {
            instanceId: 'claude',
            agentType: 'claude',
            runtimeWindow: 'test-project-claude',
            channelId: 'ch-123',
            // No containerMode — standard mode instance
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      };
      mockStateManager.listProjects.mockReturnValue([existingProject]);

      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: mockRuntime,
        stateManager: mockStateManager,
        registry: createMockRegistry(),
        config: createMockConfig({ runtimeMode: 'pty-rust' }),
      });

      await bridge.start();

      // Should use standard agent command, not docker start
      expect(containerMocks.buildDockerStartCommand).not.toHaveBeenCalled();
      expect(mockRuntime.startAgentInWindow).toHaveBeenCalledWith(
        'agent-test',
        'test-project-claude',
        expect.stringContaining('export DISCODE_PROJECT='),
      );

      // No container sync should have been started
      expect(containerSyncCalls.args).toHaveLength(0);

      await bridge.stop();
    });
  });
});

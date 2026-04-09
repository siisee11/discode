/**
 * Unit tests for setupProject — the core project creation flow.
 *
 * Covers standard (tmux) and container modes, error paths,
 * skipRuntimeStart, existing-project merging, and custom instanceId.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Top-level mocks ─────────────────────────────────────────────────

vi.mock('../../src/state/instances.js', () => ({
  buildNextInstanceId: vi.fn().mockReturnValue('opencode-1'),
  getProjectInstance: vi.fn().mockReturnValue(undefined),
  normalizeProjectState: vi.fn((s: any) => s),
}));

vi.mock('../../src/infra/file-instruction.js', () => ({
  installFileInstruction: vi.fn(),
}));

vi.mock('../../src/infra/send-script.js', () => ({
  installDiscodeSendScript: vi.fn(),
}));

vi.mock('../../src/policy/agent-launch.js', () => ({
  buildAgentLaunchEnv: vi.fn().mockReturnValue({}),
  buildContainerEnv: vi.fn().mockReturnValue({}),
  buildExportPrefix: vi.fn().mockReturnValue('export PREFIX; '),
  readHookToken: () => 'mock-hook-token',
}));

vi.mock('../../src/policy/agent-integration.js', () => ({
  installAgentIntegration: vi.fn().mockReturnValue({
    eventHookInstalled: true,
    infoMessages: [],
    warningMessages: [],
    claudePluginDir: undefined,
  }),
}));

vi.mock('../../src/policy/window-naming.js', () => ({
  toProjectScopedName: vi.fn(
    (proj: string, suffix: string, inst: string) => `${proj}-${suffix}-${inst}`,
  ),
}));

vi.mock('../../src/container/index.js', () => ({
  isDockerAvailable: vi.fn().mockReturnValue(true),
  createContainer: vi.fn().mockReturnValue('container-id-123'),
  buildDockerStartCommand: vi.fn().mockReturnValue('docker start -ai container-id-123'),
  injectCredentials: vi.fn(),
  injectChromeMcpBridge: vi.fn().mockReturnValue(true),
  WORKSPACE_DIR: '/workspace',
}));

vi.mock('../../src/container/sync.js', () => ({
  ContainerSync: vi.fn(function (this: any) {
    this.start = vi.fn();
    this.stop = vi.fn();
  }),
}));

// ── Imports (after mocks) ───────────────────────────────────────────

import { setupProject, type ProjectSetupDeps } from '../../src/bridge/project-setup.js';
import { buildNextInstanceId, getProjectInstance } from '../../src/state/instances.js';
import { isDockerAvailable, createContainer, injectCredentials, injectChromeMcpBridge, buildDockerStartCommand } from '../../src/container/index.js';
import { ContainerSync } from '../../src/container/sync.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createMockAdapter(overrides: Partial<Record<string, any>> = {}) {
  return {
    config: { name: 'opencode', displayName: 'OpenCode', channelSuffix: 'oc' },
    getStartCommand: vi.fn().mockReturnValue('opencode start'),
    buildLaunchCommand: vi.fn().mockReturnValue('launch cmd'),
    getExtraEnvVars: vi.fn().mockReturnValue({}),
    injectContainerPlugins: vi.fn(),
    ...overrides,
  };
}

function createMockDeps(overrides: Partial<ProjectSetupDeps> = {}): ProjectSetupDeps {
  const adapter = createMockAdapter();
  return {
    messaging: {
      platform: 'discord',
      createAgentChannels: vi.fn().mockResolvedValue({ opencode: 'ch-1' }),
      registerChannelMappings: vi.fn(),
      onMessage: vi.fn(),
      sendToChannel: vi.fn(),
    } as any,
    runtime: {
      getOrCreateSession: vi.fn().mockReturnValue('discode-bridge'),
      setSessionEnv: vi.fn(),
      windowExists: vi.fn().mockReturnValue(false),
      startAgentInWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
    } as any,
    stateManager: {
      getProject: vi.fn().mockReturnValue(undefined),
      setProject: vi.fn(),
      getGuildId: vi.fn().mockReturnValue('guild-1'),
      getWorkspaceId: vi.fn().mockReturnValue('workspace-1'),
      listProjects: vi.fn().mockReturnValue([]),
      removeProject: vi.fn(),
    } as any,
    registry: {
      getAll: vi.fn().mockReturnValue([adapter]),
      get: vi.fn().mockReturnValue(adapter),
    } as any,
    bridgeConfig: {
      tmux: { sessionPrefix: 'discode-', sharedSessionName: 'bridge' },
      hookServerPort: 18470,
      opencode: { permissionMode: 'default' },
    } as any,
    containerSyncs: new Map(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('setupProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock return values after clearAllMocks
    vi.mocked(buildNextInstanceId).mockReturnValue('opencode-1');
    vi.mocked(getProjectInstance).mockReturnValue(undefined);
    vi.mocked(isDockerAvailable).mockReturnValue(true);
    vi.mocked(createContainer).mockReturnValue('container-id-123');
    vi.mocked(buildDockerStartCommand).mockReturnValue('docker start -ai container-id-123');
    vi.mocked(injectChromeMcpBridge).mockReturnValue(true);
  });

  // ── Error paths ─────────────────────────────────────────────────

  it('throws when no guild/workspace ID is configured', async () => {
    const deps = createMockDeps();
    vi.mocked(deps.stateManager.getGuildId).mockReturnValue(undefined as any);

    await expect(
      setupProject(deps, 'my-proj', '/tmp/proj', { opencode: true }),
    ).rejects.toThrow('Server ID not configured');
  });

  it('throws when no agent matches the agents param', async () => {
    const deps = createMockDeps();
    // Request an agent that doesn't match any registered adapter
    await expect(
      setupProject(deps, 'my-proj', '/tmp/proj', { nonexistent: true }),
    ).rejects.toThrow('No agent specified');
  });

  it('throws when instance already exists', async () => {
    vi.mocked(getProjectInstance).mockReturnValue({
      instanceId: 'opencode-1',
      agentType: 'opencode',
    } as any);

    const deps = createMockDeps();
    // Provide existing project so normalizedExisting is truthy
    vi.mocked(deps.stateManager.getProject).mockReturnValue({
      projectName: 'my-proj',
      projectPath: '/tmp/proj',
      runtimeSession: 'discode-bridge',
      instances: { 'opencode-1': { instanceId: 'opencode-1', agentType: 'opencode' } },
      agents: {},
      discordChannels: {},
      createdAt: new Date(),
      lastActive: new Date(),
    });

    await expect(
      setupProject(deps, 'my-proj', '/tmp/proj', { opencode: true }),
    ).rejects.toThrow('Instance already exists: opencode-1');
  });

  // ── Standard (non-container) setup ──────────────────────────────

  it('creates channels, starts agent window, and saves state in standard mode', async () => {
    const deps = createMockDeps();

    const result = await setupProject(deps, 'my-proj', '/tmp/proj', { opencode: true });

    // Channel creation
    expect(deps.messaging.createAgentChannels).toHaveBeenCalledWith(
      'guild-1',
      'my-proj',
      [expect.objectContaining({ name: 'opencode' })],
      expect.any(String),
      expect.objectContaining({ opencode: 'opencode-1' }),
    );

    // Agent window started via runtime
    expect(deps.runtime.startAgentInWindow).toHaveBeenCalledWith(
      'discode-bridge',
      expect.any(String),
      expect.stringContaining('export PREFIX; '),
    );

    // State saved
    expect(deps.stateManager.setProject).toHaveBeenCalledTimes(1);
    const savedState = vi.mocked(deps.stateManager.setProject).mock.calls[0][0] as any;
    expect(savedState.instances['opencode-1']).toEqual(
      expect.objectContaining({
        instanceId: 'opencode-1',
        agentType: 'opencode',
        channelId: 'ch-1',
      }),
    );

    // Return values
    expect(result.channelId).toBe('ch-1');
    expect(result.agentName).toBe('OpenCode');
    expect(result.runtimeSession).toBe('discode-bridge');
  });

  // ── Container setup ─────────────────────────────────────────────

  it('creates a container and injects credentials in container mode', async () => {
    const deps = createMockDeps({
      bridgeConfig: {
        tmux: { sessionPrefix: 'discode-', sharedSessionName: 'bridge' },
        hookServerPort: 18470,
        opencode: { permissionMode: 'default' },
        container: { enabled: true },
      } as any,
    });

    await setupProject(deps, 'my-proj', '/tmp/proj', { opencode: true });

    expect(isDockerAvailable).toHaveBeenCalled();
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        containerName: expect.stringContaining('discode-my-proj'),
        projectPath: '/tmp/proj',
        agentType: 'opencode',
      }),
    );
    expect(injectCredentials).toHaveBeenCalledWith('container-id-123', undefined);
    expect(injectChromeMcpBridge).toHaveBeenCalled();

    // runtime starts the docker command
    expect(deps.runtime.startAgentInWindow).toHaveBeenCalledWith(
      'discode-bridge',
      expect.any(String),
      'docker start -ai container-id-123',
    );

    // ContainerSync is instantiated and started
    expect(ContainerSync).toHaveBeenCalled();

    // State includes container info
    const savedState = vi.mocked(deps.stateManager.setProject).mock.calls[0][0] as any;
    expect(savedState.instances['opencode-1']).toEqual(
      expect.objectContaining({
        containerMode: true,
        containerId: 'container-id-123',
      }),
    );
  });

  it('throws when Docker is unavailable in container mode', async () => {
    vi.mocked(isDockerAvailable).mockReturnValue(false);

    const deps = createMockDeps({
      bridgeConfig: {
        tmux: { sessionPrefix: 'discode-', sharedSessionName: 'bridge' },
        hookServerPort: 18470,
        opencode: { permissionMode: 'default' },
        container: { enabled: true },
      } as any,
    });

    await expect(
      setupProject(deps, 'my-proj', '/tmp/proj', { opencode: true }),
    ).rejects.toThrow('Docker is not available');
  });

  // ── skipRuntimeStart ────────────────────────────────────────────

  it('does not start agent window when skipRuntimeStart is true', async () => {
    const deps = createMockDeps();

    await setupProject(deps, 'my-proj', '/tmp/proj', { opencode: true }, undefined, undefined, {
      skipRuntimeStart: true,
    });

    expect(deps.runtime.startAgentInWindow).not.toHaveBeenCalled();
    // State should still be saved
    expect(deps.stateManager.setProject).toHaveBeenCalled();
  });

  it('does not start agent window when skipRuntimeStart is true (container mode)', async () => {
    const deps = createMockDeps({
      bridgeConfig: {
        tmux: { sessionPrefix: 'discode-', sharedSessionName: 'bridge' },
        hookServerPort: 18470,
        opencode: { permissionMode: 'default' },
        container: { enabled: true },
      } as any,
    });

    await setupProject(deps, 'my-proj', '/tmp/proj', { opencode: true }, undefined, undefined, {
      skipRuntimeStart: true,
    });

    expect(deps.runtime.startAgentInWindow).not.toHaveBeenCalled();
    // Container should still be created
    expect(createContainer).toHaveBeenCalled();
  });

  // ── Existing project state merging ──────────────────────────────

  it('merges new instance into existing project state', async () => {
    vi.mocked(buildNextInstanceId).mockReturnValue('opencode-2');

    const existingState = {
      projectName: 'my-proj',
      projectPath: '/tmp/proj',
      runtimeSession: 'discode-bridge',
      instances: {
        'opencode-1': {
          instanceId: 'opencode-1',
          agentType: 'opencode',
          runtimeWindow: 'my-proj-opencode-opencode-1',
          channelId: 'ch-existing',
        },
      },
      agents: { opencode: true },
      discordChannels: { opencode: 'ch-existing' },
      createdAt: new Date('2025-01-01'),
      lastActive: new Date('2025-01-01'),
    };

    const deps = createMockDeps();
    vi.mocked(deps.stateManager.getProject).mockReturnValue(existingState as any);

    await setupProject(deps, 'my-proj', '/tmp/proj', { opencode: true });

    const savedState = vi.mocked(deps.stateManager.setProject).mock.calls[0][0] as any;
    // Both old and new instance should be present
    expect(savedState.instances['opencode-1']).toBeDefined();
    expect(savedState.instances['opencode-2']).toBeDefined();
    expect(savedState.instances['opencode-2'].channelId).toBe('ch-1');
  });

  // ── Custom instanceId ───────────────────────────────────────────

  it('uses a custom instanceId when provided in options', async () => {
    const deps = createMockDeps();

    await setupProject(deps, 'my-proj', '/tmp/proj', { opencode: true }, undefined, undefined, {
      instanceId: 'my-custom-id',
    });

    // buildNextInstanceId should not determine the final id
    const savedState = vi.mocked(deps.stateManager.setProject).mock.calls[0][0] as any;
    expect(savedState.instances['my-custom-id']).toBeDefined();
    expect(savedState.instances['my-custom-id'].instanceId).toBe('my-custom-id');
  });

  it('trims whitespace from custom instanceId', async () => {
    const deps = createMockDeps();

    await setupProject(deps, 'my-proj', '/tmp/proj', { opencode: true }, undefined, undefined, {
      instanceId: '  trimmed-id  ',
    });

    const savedState = vi.mocked(deps.stateManager.setProject).mock.calls[0][0] as any;
    expect(savedState.instances['trimmed-id']).toBeDefined();
  });

  // ── Slack platform ────────────────────────────────────────────────

  it('uses workspaceId when messaging platform is slack', async () => {
    const deps = createMockDeps({
      bridgeConfig: {
        messagingPlatform: 'slack',
        tmux: { sessionPrefix: 'discode-', sharedSessionName: 'bridge' },
        hookServerPort: 18470,
        opencode: { permissionMode: 'default' },
      } as any,
    });
    vi.mocked(deps.stateManager.getGuildId).mockReturnValue(undefined as any);
    vi.mocked(deps.stateManager.getWorkspaceId).mockReturnValue('ws-slack-1');

    const result = await setupProject(deps, 'my-proj', '/tmp/proj', { opencode: true });

    expect(deps.messaging.createAgentChannels).toHaveBeenCalledWith(
      'ws-slack-1',
      expect.any(String),
      expect.any(Array),
      expect.any(String),
      expect.any(Object),
    );
    expect(result.channelId).toBe('ch-1');
  });
});

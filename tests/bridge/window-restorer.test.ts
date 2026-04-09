/**
 * Unit tests for restoreRuntimeWindowsIfNeeded.
 *
 * Tests the daemon-restart window restoration logic that re-creates
 * agent windows (standard, container, SDK) in the runtime backend.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────

const mockInstallAgentIntegration = vi.fn().mockReturnValue({
  eventHookInstalled: false,
  infoMessages: [],
  warningMessages: [],
  claudePluginDir: undefined,
});

const mockBuildAgentLaunchEnv = vi.fn().mockReturnValue({});
const mockBuildExportPrefix = vi.fn().mockReturnValue('export PREFIX; ');
const mockResolveProjectWindowName = vi.fn().mockReturnValue('win-name');
const mockBuildDockerStartCommand = vi.fn().mockReturnValue('docker start -ai cid');
const mockListProjectInstances = vi.fn().mockReturnValue([]);
const mockNormalizeProjectState = vi.fn((p: any) => p);

vi.mock('../../src/policy/agent-integration.js', () => ({
  installAgentIntegration: (...args: any[]) => mockInstallAgentIntegration(...args),
}));

vi.mock('../../src/policy/agent-launch.js', () => ({
  buildAgentLaunchEnv: (...args: any[]) => mockBuildAgentLaunchEnv(...args),
  buildExportPrefix: (...args: any[]) => mockBuildExportPrefix(...args),
  readHookToken: () => 'mock-hook-token',
}));

vi.mock('../../src/policy/window-naming.js', () => ({
  resolveProjectWindowName: (...args: any[]) => mockResolveProjectWindowName(...args),
}));

vi.mock('../../src/container/index.js', () => ({
  buildDockerStartCommand: (...args: any[]) => mockBuildDockerStartCommand(...args),
}));

vi.mock('../../src/container/sync.js', () => ({
  ContainerSync: vi.fn(function (this: any) {
    this.start = vi.fn();
  }),
}));

vi.mock('../../src/state/instances.js', () => ({
  getProjectRuntimeSession: vi.fn((project: any) => project.runtimeSession || project.runtimeSession),
  listProjectInstances: (...args: any[]) => mockListProjectInstances(...args),
  normalizeProjectState: (...args: any[]) => mockNormalizeProjectState(...args),
}));

// ── Imports ──────────────────────────────────────────────────────────

import { restoreRuntimeWindowsIfNeeded } from '../../src/bridge/window-restorer.js';
import { ContainerSync } from '../../src/container/sync.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createRuntime() {
  return {
    getOrCreateSession: vi.fn(),
    setSessionEnv: vi.fn(),
    windowExists: vi.fn().mockReturnValue(false),
    startAgentInWindow: vi.fn(),
    sendKeysToWindow: vi.fn(),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
  } as any;
}

function createStateManager(projects: any[] = []) {
  return {
    listProjects: vi.fn().mockReturnValue(projects),
    getProject: vi.fn(),
    setProject: vi.fn(),
    removeProject: vi.fn(),
    getGuildId: vi.fn(),
    getWorkspaceId: vi.fn(),
  } as any;
}

function createRegistry(adapter?: any) {
  return {
    get: vi.fn().mockReturnValue(adapter ?? {
      config: { name: 'opencode' },
      getStartCommand: vi.fn().mockReturnValue('opencode start'),
      buildLaunchCommand: vi.fn().mockReturnValue('launch cmd'),
      getExtraEnvVars: vi.fn().mockReturnValue({}),
    }),
    getAll: vi.fn().mockReturnValue([]),
  } as any;
}

function createBridgeConfig(overrides: any = {}): any {
  return {
    discord: { token: 'test-token' },
    tmux: { sessionPrefix: 'bridge-' },
    hookServerPort: 18470,
    runtimeMode: 'pty-rust',
    ...overrides,
  };
}

function createProject(overrides: any = {}) {
  return {
    projectName: 'myapp',
    projectPath: '/home/user/myapp',
    runtimeSession: 'bridge',
    agents: { opencode: true },
    discordChannels: { opencode: 'ch-opencode' },
    instances: {},
    createdAt: new Date(),
    lastActive: new Date(),
    ...overrides,
  };
}

function createDeps(overrides: any = {}) {
  const runtime = overrides.runtime ?? createRuntime();
  const project = overrides.project ?? createProject();
  const stateManager = overrides.stateManager ?? createStateManager([project]);
  const registry = overrides.registry ?? createRegistry();
  const bridgeConfig = overrides.bridgeConfig ?? createBridgeConfig();
  const containerSyncs = overrides.containerSyncs ?? new Map();
  const createSdkRunner = overrides.createSdkRunner ?? vi.fn();

  return {
    runtime,
    stateManager,
    registry,
    bridgeConfig,
    containerSyncs,
    createSdkRunner,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('restoreRuntimeWindowsIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstallAgentIntegration.mockReturnValue({
      eventHookInstalled: false,
      infoMessages: [],
      warningMessages: [],
      claudePluginDir: undefined,
    });
    mockBuildAgentLaunchEnv.mockReturnValue({});
    mockBuildExportPrefix.mockReturnValue('export PREFIX; ');
    mockResolveProjectWindowName.mockReturnValue('win-name');
    mockBuildDockerStartCommand.mockReturnValue('docker start -ai cid');
    mockNormalizeProjectState.mockImplementation((p: any) => p);
    mockListProjectInstances.mockReturnValue([]);
  });

  it('restores projects when runtimeMode is omitted', () => {
    const deps = createDeps({
      bridgeConfig: createBridgeConfig({ runtimeMode: undefined }),
    });

    restoreRuntimeWindowsIfNeeded(deps);

    expect(deps.stateManager.listProjects).toHaveBeenCalled();
  });

  it('restores projects when runtimeMode is explicitly pty-rust', () => {
    const deps = createDeps({
      bridgeConfig: createBridgeConfig({ runtimeMode: 'pty-rust' }),
    });

    restoreRuntimeWindowsIfNeeded(deps);

    expect(deps.stateManager.listProjects).toHaveBeenCalled();
  });

  it('skips instances where window already exists', () => {
    const instance = {
      instanceId: 'opencode',
      agentType: 'opencode',
    };
    const project = createProject();
    mockListProjectInstances.mockReturnValue([instance]);

    const runtime = createRuntime();
    runtime.windowExists.mockReturnValue(true);

    const deps = createDeps({
      runtime,
      stateManager: createStateManager([project]),
    });

    restoreRuntimeWindowsIfNeeded(deps);

    expect(runtime.startAgentInWindow).not.toHaveBeenCalled();
  });

  it('skips instances with no adapter', () => {
    const instance = {
      instanceId: 'unknown-agent',
      agentType: 'unknown-agent',
    };
    const project = createProject();
    mockListProjectInstances.mockReturnValue([instance]);

    const registry = createRegistry();
    registry.get.mockReturnValue(undefined);

    const deps = createDeps({
      registry,
      stateManager: createStateManager([project]),
    });

    restoreRuntimeWindowsIfNeeded(deps);

    expect(deps.runtime.startAgentInWindow).not.toHaveBeenCalled();
  });

  it('restores SDK instances via createSdkRunner', () => {
    const instance = {
      instanceId: 'claude',
      agentType: 'claude',
      runtimeType: 'sdk' as const,
    };
    const project = createProject({
      projectName: 'sdkapp',
      projectPath: '/home/user/sdkapp',
    });
    mockListProjectInstances.mockReturnValue([instance]);

    const createSdkRunner = vi.fn();
    const deps = createDeps({
      stateManager: createStateManager([project]),
      createSdkRunner,
    });

    restoreRuntimeWindowsIfNeeded(deps);

    expect(createSdkRunner).toHaveBeenCalledWith(
      'sdkapp',
      'claude',
      'claude',
      '/home/user/sdkapp',
      { permissionAllow: false },
    );
    expect(deps.runtime.startAgentInWindow).not.toHaveBeenCalled();
  });

  it('restores container instances', () => {
    const instance = {
      instanceId: 'opencode',
      agentType: 'opencode',
      containerMode: true,
      containerId: 'abc123',
    };
    const project = createProject();
    mockListProjectInstances.mockReturnValue([instance]);

    const containerSyncs = new Map();
    const deps = createDeps({
      stateManager: createStateManager([project]),
      containerSyncs,
    });

    restoreRuntimeWindowsIfNeeded(deps);

    expect(mockBuildDockerStartCommand).toHaveBeenCalledWith('abc123', undefined);
    expect(deps.runtime.startAgentInWindow).toHaveBeenCalledWith(
      'bridge',
      'win-name',
      'docker start -ai cid',
    );
    expect(ContainerSync).toHaveBeenCalledWith({
      containerId: 'abc123',
      projectPath: '/home/user/myapp',
      socketPath: undefined,
      intervalMs: undefined,
    });
    expect(containerSyncs.has('myapp#opencode')).toBe(true);
  });

  it('restores standard instances', () => {
    const instance = {
      instanceId: 'opencode',
      agentType: 'opencode',
    };
    const project = createProject();
    mockListProjectInstances.mockReturnValue([instance]);

    const adapter = {
      config: { name: 'opencode' },
      getStartCommand: vi.fn().mockReturnValue('opencode start'),
      buildLaunchCommand: vi.fn().mockReturnValue('launch cmd'),
      getExtraEnvVars: vi.fn().mockReturnValue({}),
    };
    const registry = createRegistry(adapter);

    const deps = createDeps({
      stateManager: createStateManager([project]),
      registry,
    });

    restoreRuntimeWindowsIfNeeded(deps);

    expect(mockInstallAgentIntegration).toHaveBeenCalledWith(
      'opencode',
      '/home/user/myapp',
      'reinstall',
    );
    expect(adapter.buildLaunchCommand).toHaveBeenCalledWith(
      'opencode start',
      expect.objectContaining({ eventHookInstalled: false }),
    );
    expect(adapter.getExtraEnvVars).toHaveBeenCalledWith({ permissionAllow: false });
    expect(mockBuildExportPrefix).toHaveBeenCalled();
    expect(deps.runtime.startAgentInWindow).toHaveBeenCalledWith(
      'bridge',
      'win-name',
      'export PREFIX; launch cmd',
    );
  });

  it('sets DISCODE_PORT env on session', () => {
    const project = createProject({ runtimeSession: 'my-session' });
    mockListProjectInstances.mockReturnValue([]);

    const runtime = createRuntime();
    const deps = createDeps({
      runtime,
      stateManager: createStateManager([project]),
      bridgeConfig: createBridgeConfig({ hookServerPort: 19000 }),
    });

    restoreRuntimeWindowsIfNeeded(deps);

    expect(runtime.setSessionEnv).toHaveBeenCalledWith(
      'my-session',
      'DISCODE_PORT',
      '19000',
    );
  });

  it('uses default port 18470 when hookServerPort is not set', () => {
    const project = createProject();
    mockListProjectInstances.mockReturnValue([]);

    const runtime = createRuntime();
    const deps = createDeps({
      runtime,
      stateManager: createStateManager([project]),
      bridgeConfig: createBridgeConfig({ hookServerPort: undefined }),
    });

    restoreRuntimeWindowsIfNeeded(deps);

    expect(runtime.setSessionEnv).toHaveBeenCalledWith(
      'bridge',
      'DISCODE_PORT',
      '18470',
    );
  });

  it('passes socketPath to buildDockerStartCommand for container instances', () => {
    const instance = {
      instanceId: 'opencode',
      agentType: 'opencode',
      containerMode: true,
      containerId: 'xyz789',
    };
    const project = createProject();
    mockListProjectInstances.mockReturnValue([instance]);

    const deps = createDeps({
      stateManager: createStateManager([project]),
      bridgeConfig: createBridgeConfig({
        container: { enabled: true, socketPath: '/var/run/docker.sock' },
      }),
    });

    restoreRuntimeWindowsIfNeeded(deps);

    expect(mockBuildDockerStartCommand).toHaveBeenCalledWith('xyz789', '/var/run/docker.sock');
  });

  it('resolves window name using project and instance context', () => {
    const instance = {
      instanceId: 'opencode',
      agentType: 'opencode',
    };
    const project = createProject();
    mockListProjectInstances.mockReturnValue([instance]);

    const bridgeConfig = createBridgeConfig();
    const deps = createDeps({
      stateManager: createStateManager([project]),
      bridgeConfig,
    });

    restoreRuntimeWindowsIfNeeded(deps);

    expect(mockResolveProjectWindowName).toHaveBeenCalledWith(
      project,
      'opencode',
      bridgeConfig.tmux,
      'opencode',
    );
  });

  it('iterates over multiple projects and instances', () => {
    const instance1 = { instanceId: 'claude', agentType: 'claude' };
    const instance2 = { instanceId: 'gemini', agentType: 'gemini' };
    const project1 = createProject({ projectName: 'proj1', runtimeSession: 'sess1' });
    const project2 = createProject({ projectName: 'proj2', runtimeSession: 'sess2' });

    mockListProjectInstances
      .mockReturnValueOnce([instance1])
      .mockReturnValueOnce([instance2]);

    const runtime = createRuntime();
    const deps = createDeps({
      runtime,
      stateManager: createStateManager([project1, project2]),
    });

    restoreRuntimeWindowsIfNeeded(deps);

    expect(runtime.setSessionEnv).toHaveBeenCalledTimes(2);
    expect(runtime.startAgentInWindow).toHaveBeenCalledTimes(2);
  });
});

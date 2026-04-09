/**
 * Unit tests for project-service module.
 *
 * Covers:
 * - removeInstanceFromProjectState  (synchronous state manipulation)
 * - removeProjectState              (synchronous state manipulation)
 * - resumeProjectInstance           (async, mocked runtime + adapters)
 *
 * setupProjectInstance is intentionally not tested here because it
 * orchestrates AgentBridge + HTTP calls that are better suited for
 * integration tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectState } from '../../src/state/index.js';
import type { BridgeConfig, ProjectInstanceState } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Mocks — declared before the module-under-test import
// ---------------------------------------------------------------------------

const mockGetProject = vi.fn();
const mockSetProject = vi.fn();
const mockRemoveProject = vi.fn();

vi.mock('../../src/state/index.js', () => ({
  stateManager: {
    getProject: (...args: any[]) => mockGetProject(...args),
    setProject: (...args: any[]) => mockSetProject(...args),
    removeProject: (...args: any[]) => mockRemoveProject(...args),
  },
}));

const mockNormalizeProjectState = vi.fn((p: any) => p);

vi.mock('../../src/state/instances.js', () => ({
  normalizeProjectState: (...args: any[]) => mockNormalizeProjectState(...args),
  buildNextInstanceId: vi.fn(),
  getProjectInstance: vi.fn(),
  getProjectRuntimeSession: vi.fn((project: any) => project.runtimeSession || project.runtimeSession),
  listProjectInstances: vi.fn(),
}));

const mockAgentRegistryGet = vi.fn();

vi.mock('../../src/agents/index.js', () => ({
  agentRegistry: {
    get: (...args: any[]) => mockAgentRegistryGet(...args),
  },
}));

const mockInstallAgentIntegration = vi.fn();

vi.mock('../../src/policy/agent-integration.js', () => ({
  installAgentIntegration: (...args: any[]) => mockInstallAgentIntegration(...args),
}));

const mockBuildAgentLaunchEnv = vi.fn(() => ({}));
const mockBuildExportPrefix = vi.fn(() => '');

vi.mock('../../src/policy/agent-launch.js', () => ({
  buildAgentLaunchEnv: (...args: any[]) => mockBuildAgentLaunchEnv(...args),
  buildExportPrefix: (...args: any[]) => mockBuildExportPrefix(...args),
  readHookToken: () => 'mock-hook-token',
}));

const mockResolveProjectWindowName = vi.fn(() => 'test-window');

vi.mock('../../src/policy/window-naming.js', () => ({
  resolveProjectWindowName: (...args: any[]) => mockResolveProjectWindowName(...args),
}));

vi.mock('../../src/runtime/factory.js', () => ({
  createRuntimeForMode: vi.fn(() => mockRuntime),
}));

const mockContainerExists = vi.fn(() => false);
const mockBuildDockerStartCommand = vi.fn(() => 'docker start -ai abc123');

vi.mock('../../src/container/index.js', () => ({
  containerExists: (...args: any[]) => mockContainerExists(...args),
  buildDockerStartCommand: (...args: any[]) => mockBuildDockerStartCommand(...args),
}));

vi.mock('../../src/index.js', () => ({
  AgentBridge: vi.fn(),
}));

vi.mock('http', () => ({
  request: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER all vi.mock() calls
// ---------------------------------------------------------------------------

import {
  removeInstanceFromProjectState,
  removeProjectState,
  resumeProjectInstance,
} from '../../src/app/project-service.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const mockRuntime = {
  getOrCreateSession: vi.fn(),
  setSessionEnv: vi.fn(),
  windowExists: vi.fn(() => false),
  startAgentInWindow: vi.fn(),
  sendKeysToWindow: vi.fn(),
  typeKeysToWindow: vi.fn(),
  sendEnterToWindow: vi.fn(),
};

function makeProject(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectName: 'myproject',
    projectPath: '/tmp/myproject',
    runtimeSession: 'discode_bridge',
    agents: { claude: true },
    discordChannels: { claude: 'ch-1' },
    createdAt: new Date(),
    lastActive: new Date(),
    instances: {
      claude: {
        instanceId: 'claude',
        agentType: 'claude',
        channelId: 'ch-1',
        runtimeWindow: 'myproject-claude',
      },
    },
    ...overrides,
  };
}

function makeInstance(overrides: Partial<ProjectInstanceState> = {}): ProjectInstanceState {
  return {
    instanceId: 'claude',
    agentType: 'claude',
    channelId: 'ch-1',
    runtimeWindow: 'myproject-claude',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    discord: { token: 'test-token' },
    tmux: {
      sessionPrefix: 'discode_',
      sharedSessionName: 'bridge',
    },
    hookServerPort: 18470,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // normalizeProjectState defaults to pass-through
  mockNormalizeProjectState.mockImplementation((p: any) => p);
});

// ===========================================================================
// removeInstanceFromProjectState
// ===========================================================================

describe('removeInstanceFromProjectState', () => {
  it('returns projectFound=false when project does not exist', () => {
    mockGetProject.mockReturnValue(undefined);

    const result = removeInstanceFromProjectState('nonexistent', 'claude');

    expect(result).toEqual({
      projectFound: false,
      instanceFound: false,
      removedProject: false,
    });
    expect(mockGetProject).toHaveBeenCalledWith('nonexistent');
    expect(mockSetProject).not.toHaveBeenCalled();
    expect(mockRemoveProject).not.toHaveBeenCalled();
  });

  it('returns instanceFound=false when instance does not exist in project', () => {
    const project = makeProject({
      instances: {
        gemini: {
          instanceId: 'gemini',
          agentType: 'gemini',
          channelId: 'ch-2',
        },
      },
    });
    mockGetProject.mockReturnValue(project);

    const result = removeInstanceFromProjectState('myproject', 'claude');

    expect(result).toEqual({
      projectFound: true,
      instanceFound: false,
      removedProject: false,
    });
    expect(mockRemoveProject).not.toHaveBeenCalled();
    expect(mockSetProject).not.toHaveBeenCalled();
  });

  it('removes entire project when last instance is removed', () => {
    const project = makeProject({
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          channelId: 'ch-1',
        },
      },
    });
    mockGetProject.mockReturnValue(project);

    const result = removeInstanceFromProjectState('myproject', 'claude');

    expect(result).toEqual({
      projectFound: true,
      instanceFound: true,
      removedProject: true,
    });
    expect(mockRemoveProject).toHaveBeenCalledWith('myproject');
    expect(mockSetProject).not.toHaveBeenCalled();
  });

  it('updates project without removed instance when other instances remain', () => {
    const project = makeProject({
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          channelId: 'ch-1',
        },
        gemini: {
          instanceId: 'gemini',
          agentType: 'gemini',
          channelId: 'ch-2',
        },
      },
    });
    mockGetProject.mockReturnValue(project);

    const result = removeInstanceFromProjectState('myproject', 'claude');

    expect(result).toEqual({
      projectFound: true,
      instanceFound: true,
      removedProject: false,
    });
    expect(mockRemoveProject).not.toHaveBeenCalled();
    expect(mockSetProject).toHaveBeenCalledTimes(1);

    const savedProject = mockSetProject.mock.calls[0][0] as ProjectState;
    expect(savedProject.instances).not.toHaveProperty('claude');
    expect(savedProject.instances).toHaveProperty('gemini');
    expect(savedProject.lastActive).toBeInstanceOf(Date);
  });

  it('calls normalizeProjectState on the retrieved project', () => {
    const project = makeProject();
    mockGetProject.mockReturnValue(project);

    removeInstanceFromProjectState('myproject', 'claude');

    expect(mockNormalizeProjectState).toHaveBeenCalledWith(project);
  });
});

// ===========================================================================
// removeProjectState
// ===========================================================================

describe('removeProjectState', () => {
  it('returns false when project does not exist', () => {
    mockGetProject.mockReturnValue(undefined);

    const result = removeProjectState('nonexistent');

    expect(result).toBe(false);
    expect(mockRemoveProject).not.toHaveBeenCalled();
  });

  it('removes project and returns true when project exists', () => {
    mockGetProject.mockReturnValue(makeProject());

    const result = removeProjectState('myproject');

    expect(result).toBe(true);
    expect(mockRemoveProject).toHaveBeenCalledWith('myproject');
  });
});

// ===========================================================================
// resumeProjectInstance
// ===========================================================================

describe('resumeProjectInstance', () => {
  const defaultAdapter = {
    config: { name: 'claude' },
    getStartCommand: vi.fn(() => 'claude-cli'),
    buildLaunchCommand: vi.fn((cmd: string) => cmd),
    getExtraEnvVars: vi.fn(() => ({})),
  };

  beforeEach(() => {
    mockAgentRegistryGet.mockReturnValue(defaultAdapter);
    mockInstallAgentIntegration.mockReturnValue({
      agentType: 'claude',
      eventHookInstalled: false,
      infoMessages: [],
      warningMessages: [],
    });
    mockBuildAgentLaunchEnv.mockReturnValue({});
    mockBuildExportPrefix.mockReturnValue('');
    mockResolveProjectWindowName.mockReturnValue('myproject-claude');
    mockRuntime.windowExists.mockReturnValue(false);
  });

  it('returns restoredWindow=false when window already exists', async () => {
    mockRuntime.windowExists.mockReturnValue(true);

    const result = await resumeProjectInstance({
      config: makeConfig(),
      projectName: 'myproject',
      project: makeProject(),
      instance: makeInstance(),
      port: 18470,
      runtime: mockRuntime,
    });

    expect(result.restoredWindow).toBe(false);
    expect(result.windowName).toBe('myproject-claude');
    expect(mockRuntime.startAgentInWindow).not.toHaveBeenCalled();
  });

  it('returns warning when no adapter is found for agent type', async () => {
    mockAgentRegistryGet.mockReturnValue(undefined);

    const result = await resumeProjectInstance({
      config: makeConfig(),
      projectName: 'myproject',
      project: makeProject(),
      instance: makeInstance({ agentType: 'unknown' }),
      port: 18470,
      runtime: mockRuntime,
    });

    expect(result.restoredWindow).toBe(false);
    expect(result.warningMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("No adapter found for 'unknown'"),
      ]),
    );
    expect(mockRuntime.startAgentInWindow).not.toHaveBeenCalled();
  });

  it('restores container-mode instance using docker start command', async () => {
    mockContainerExists.mockReturnValue(true);

    const result = await resumeProjectInstance({
      config: makeConfig(),
      projectName: 'myproject',
      project: makeProject(),
      instance: makeInstance({
        containerMode: true,
        containerId: 'abc123',
        containerName: 'myproject-claude-ctr',
      }),
      port: 18470,
      runtime: mockRuntime,
    });

    expect(result.restoredWindow).toBe(true);
    expect(mockContainerExists).toHaveBeenCalledWith('abc123', undefined);
    expect(mockBuildDockerStartCommand).toHaveBeenCalledWith('abc123', undefined);
    expect(mockRuntime.startAgentInWindow).toHaveBeenCalledWith(
      'discode_bridge',
      'myproject-claude',
      'docker start -ai abc123',
    );
    expect(result.infoMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Restored container runtime window'),
      ]),
    );
  });

  it('warns when container no longer exists', async () => {
    mockContainerExists.mockReturnValue(false);

    const result = await resumeProjectInstance({
      config: makeConfig(),
      projectName: 'myproject',
      project: makeProject(),
      instance: makeInstance({
        containerMode: true,
        containerId: 'gone456',
      }),
      port: 18470,
      runtime: mockRuntime,
    });

    expect(result.restoredWindow).toBe(true);
    expect(result.warningMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('no longer exists'),
      ]),
    );
    // startAgentInWindow should NOT be called for a missing container
    expect(mockRuntime.startAgentInWindow).not.toHaveBeenCalled();
  });

  it('restores standard (non-container) instance with launch command', async () => {
    const result = await resumeProjectInstance({
      config: makeConfig(),
      projectName: 'myproject',
      project: makeProject(),
      instance: makeInstance(),
      port: 18470,
      runtime: mockRuntime,
    });

    expect(result.restoredWindow).toBe(true);
    expect(mockInstallAgentIntegration).toHaveBeenCalledWith('claude', '/tmp/myproject', 'reinstall');
    expect(defaultAdapter.getStartCommand).toHaveBeenCalledWith('/tmp/myproject', false);
    expect(defaultAdapter.buildLaunchCommand).toHaveBeenCalled();
    expect(mockBuildAgentLaunchEnv).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: 'myproject',
        port: 18470,
        agentType: 'claude',
        instanceId: 'claude',
      }),
    );
    expect(mockBuildExportPrefix).toHaveBeenCalled();
    expect(mockRuntime.startAgentInWindow).toHaveBeenCalledWith(
      'discode_bridge',
      'myproject-claude',
      expect.any(String),
    );
    expect(result.infoMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Restored missing runtime window'),
      ]),
    );
  });

  it('updates project state when integration installs event hook on instance without one', async () => {
    mockInstallAgentIntegration.mockReturnValue({
      agentType: 'claude',
      eventHookInstalled: true,
      infoMessages: ['Hook installed'],
      warningMessages: [],
    });

    const instance = makeInstance({ eventHook: false });
    const project = makeProject();

    await resumeProjectInstance({
      config: makeConfig(),
      projectName: 'myproject',
      project,
      instance,
      port: 18470,
      runtime: mockRuntime,
    });

    expect(mockSetProject).toHaveBeenCalledTimes(1);
    const saved = mockSetProject.mock.calls[0][0] as ProjectState;
    expect(saved.instances?.claude?.eventHook).toBe(true);
  });

  it('does not update state when instance already has event hook', async () => {
    mockInstallAgentIntegration.mockReturnValue({
      agentType: 'claude',
      eventHookInstalled: false,
      infoMessages: [],
      warningMessages: [],
    });

    const instance = makeInstance({ eventHook: true });
    const project = makeProject();

    await resumeProjectInstance({
      config: makeConfig(),
      projectName: 'myproject',
      project,
      instance,
      port: 18470,
      runtime: mockRuntime,
    });

    // hookEnabled becomes true (from instance.eventHook), but since it was already true,
    // the condition `hookEnabled && !params.instance.eventHook` is false
    expect(mockSetProject).not.toHaveBeenCalled();
  });

  it('sets session env for non-shared session', async () => {
    mockRuntime.windowExists.mockReturnValue(true);

    await resumeProjectInstance({
      config: makeConfig(),
      projectName: 'myproject',
      project: makeProject({ runtimeSession: 'discode_myproject' }),
      instance: makeInstance(),
      port: 18470,
      runtime: mockRuntime,
    });

    expect(mockRuntime.setSessionEnv).toHaveBeenCalledWith(
      'discode_myproject',
      'DISCODE_PROJECT',
      'myproject',
    );
    expect(mockRuntime.setSessionEnv).toHaveBeenCalledWith(
      'discode_myproject',
      'DISCODE_PORT',
      '18470',
    );
  });

  it('skips DISCODE_PROJECT env for shared session', async () => {
    mockRuntime.windowExists.mockReturnValue(true);

    await resumeProjectInstance({
      config: makeConfig(),
      projectName: 'myproject',
      project: makeProject({ runtimeSession: 'discode_bridge' }),
      instance: makeInstance(),
      port: 18470,
      runtime: mockRuntime,
    });

    // Should NOT set DISCODE_PROJECT for shared session
    const projectEnvCalls = mockRuntime.setSessionEnv.mock.calls.filter(
      (c: any[]) => c[1] === 'DISCODE_PROJECT',
    );
    expect(projectEnvCalls).toHaveLength(0);

    // Should still set DISCODE_PORT
    expect(mockRuntime.setSessionEnv).toHaveBeenCalledWith(
      'discode_bridge',
      'DISCODE_PORT',
      '18470',
    );
  });

  it('passes container socketPath to containerExists and buildDockerStartCommand', async () => {
    mockContainerExists.mockReturnValue(true);

    await resumeProjectInstance({
      config: makeConfig({
        container: { enabled: true, socketPath: '/custom/docker.sock' },
      }),
      projectName: 'myproject',
      project: makeProject(),
      instance: makeInstance({
        containerMode: true,
        containerId: 'ctr789',
      }),
      port: 18470,
      runtime: mockRuntime,
    });

    expect(mockContainerExists).toHaveBeenCalledWith('ctr789', '/custom/docker.sock');
    expect(mockBuildDockerStartCommand).toHaveBeenCalledWith('ctr789', '/custom/docker.sock');
  });

  it('passes permissionAllow=true for opencode agent with allow mode', async () => {
    const opencodeAdapter = {
      config: { name: 'opencode' },
      getStartCommand: vi.fn(() => 'opencode-cli'),
      buildLaunchCommand: vi.fn((cmd: string) => cmd),
      getExtraEnvVars: vi.fn(() => ({})),
    };
    mockAgentRegistryGet.mockReturnValue(opencodeAdapter);

    await resumeProjectInstance({
      config: makeConfig({ opencode: { permissionMode: 'allow' } }),
      projectName: 'myproject',
      project: makeProject(),
      instance: makeInstance({ agentType: 'opencode', instanceId: 'opencode' }),
      port: 18470,
      runtime: mockRuntime,
    });

    expect(opencodeAdapter.getStartCommand).toHaveBeenCalledWith('/tmp/myproject', true);
    expect(opencodeAdapter.getExtraEnvVars).toHaveBeenCalledWith({ permissionAllow: true });
  });
});

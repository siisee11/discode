import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RuntimeRoutesDeps } from '../../src/bridge/hook-runtime-routes.js';
import { HookRuntimeRoutes } from '../../src/bridge/hook-runtime-routes.js';
import type { AgentRuntime } from '../../src/runtime/interface.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  realpathSync: vi.fn((p: string) => p),
}));

vi.mock('../../src/state/instances.js', () => ({
  normalizeProjectState: vi.fn((p: any) => p),
  getProjectInstance: vi.fn(),
  getPrimaryInstanceForAgent: vi.fn(),
  getInstanceRuntimeWindow: vi.fn((instance: any) => instance?.runtimeWindow),
  getProjectRuntimeSession: vi.fn((project: any) => project?.runtimeSession),
  listProjectInstances: vi.fn(() => []),
}));

vi.mock('../../src/agents/index.js', () => ({
  agentRegistry: { get: vi.fn() },
}));

vi.mock('../../src/policy/agent-integration.js', () => ({
  installAgentIntegration: vi.fn(() => ({
    agentType: 'opencode', eventHookInstalled: true, infoMessages: [], warningMessages: [],
  })),
}));

vi.mock('../../src/policy/agent-launch.js', () => ({
  buildAgentLaunchEnv: vi.fn(() => ({ DISCODE_PORT: '18470' })),
  buildExportPrefix: vi.fn(() => 'export DISCODE_PORT=18470; '),
  readHookToken: () => 'mock-hook-token',
}));

// Lazy imports so the mocks are wired before the module loads
import { existsSync, realpathSync } from 'fs';
import {
  normalizeProjectState,
  getProjectInstance,
  getPrimaryInstanceForAgent,
  listProjectInstances,
} from '../../src/state/instances.js';
import { agentRegistry } from '../../src/agents/index.js';
import { installAgentIntegration } from '../../src/policy/agent-integration.js';
import { buildAgentLaunchEnv, buildExportPrefix } from '../../src/policy/agent-launch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    getOrCreateSession: vi.fn().mockReturnValue('sess'),
    setSessionEnv: vi.fn(),
    windowExists: vi.fn().mockReturnValue(true),
    startAgentInWindow: vi.fn(),
    sendKeysToWindow: vi.fn(),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
    listWindows: vi.fn().mockReturnValue([
      { sessionName: 'sess', windowName: 'win1', status: 'running' },
    ]),
    getWindowBuffer: vi.fn().mockReturnValue('buffer-content-here'),
    stopWindow: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

function createMockMessaging() {
  return {
    platform: 'discord' as const,
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithId: vi.fn().mockResolvedValue('msg-id'),
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    replyInThread: vi.fn().mockResolvedValue(undefined),
    replyInThreadWithId: vi.fn().mockResolvedValue('reply-id'),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockStateManager() {
  return {
    reload: vi.fn(),
    getProject: vi.fn(),
    setProject: vi.fn(),
    removeProject: vi.fn(),
    listProjects: vi.fn().mockReturnValue([]),
    getGuildId: vi.fn(),
    setGuildId: vi.fn(),
    getWorkspaceId: vi.fn(),
    setWorkspaceId: vi.fn(),
  } as any;
}

function createDeps(overrides: Partial<RuntimeRoutesDeps> = {}): RuntimeRoutesDeps {
  return {
    port: 18470,
    messaging: createMockMessaging(),
    stateManager: createMockStateManager(),
    runtime: createMockRuntime(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HookRuntimeRoutes — handleRuntimeEnsure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // handleRuntimeEnsure
  // -------------------------------------------------------------------------
  describe('handleRuntimeEnsure', () => {
    it('returns 501 when runtime is unavailable', () => {
      const deps = createDeps({ runtime: undefined });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({ projectName: 'proj' });

      expect(result).toEqual({ status: 501, message: 'Runtime control unavailable' });
    });

    it('returns 400 when payload is null', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure(null);

      expect(result).toEqual({ status: 400, message: 'Invalid payload' });
    });

    it('returns 400 when projectName is missing', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({});

      expect(result).toEqual({ status: 400, message: 'Missing projectName' });
    });

    it('returns 404 when project is not found in state', () => {
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(undefined);
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({ projectName: 'unknown' });

      expect(result).toEqual({ status: 404, message: 'Project not found' });
    });

    it('returns 404 when instance is not found', () => {
      const project = { name: 'proj', projectPath: '/tmp/proj', runtimeSession: 'sess' };
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (listProjectInstances as any).mockReturnValue([]);
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({ projectName: 'proj' });

      expect(result).toEqual({ status: 404, message: 'Instance not found' });
    });

    it('returns 404 when agent adapter is not found', () => {
      const instance = { instanceId: 'opencode', agentType: 'opencode', runtimeWindow: 'win1', channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '/tmp/proj', runtimeSession: 'sess', instances: { opencode: instance } };
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (listProjectInstances as any).mockReturnValue([instance]);
      (agentRegistry.get as any).mockReturnValue(undefined);
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({ projectName: 'proj' });

      expect(result).toEqual({ status: 404, message: 'Agent adapter not found' });
    });

    it('returns 400 when runtimeWindow or runtimeSession is missing', () => {
      const instance = { instanceId: 'opencode', agentType: 'opencode', runtimeWindow: undefined, channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '/tmp/proj', runtimeSession: 'sess', instances: { opencode: instance } };
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (listProjectInstances as any).mockReturnValue([instance]);
      (agentRegistry.get as any).mockReturnValue({
        buildLaunchCommand: vi.fn((cmd: string) => cmd),
        getStartCommand: vi.fn(() => 'opencode'),
        getExtraEnvVars: vi.fn(() => ({})),
      });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({ projectName: 'proj' });

      expect(result).toEqual({ status: 400, message: 'Invalid project state' });
    });

    it('returns 200 when window already exists without starting agent', () => {
      const instance = { instanceId: 'opencode', agentType: 'opencode', runtimeWindow: 'win1', channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '/tmp/proj', runtimeSession: 'sess', instances: { opencode: instance } };
      const runtime = createMockRuntime({
        windowExists: vi.fn().mockReturnValue(true),
      });
      const deps = createDeps({ runtime });
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (listProjectInstances as any).mockReturnValue([instance]);
      (agentRegistry.get as any).mockReturnValue({
        buildLaunchCommand: vi.fn((cmd: string) => cmd),
        getStartCommand: vi.fn(() => 'opencode'),
        getExtraEnvVars: vi.fn(() => ({})),
      });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({ projectName: 'proj' });

      expect(result).toEqual({ status: 200, message: 'OK' });
      expect(runtime.startAgentInWindow).not.toHaveBeenCalled();
      expect(runtime.setSessionEnv).toHaveBeenCalledWith('sess', 'DISCODE_PORT', '18470');
    });

    it('starts agent in window when window does not exist', () => {
      const instance = { instanceId: 'opencode', agentType: 'opencode', runtimeWindow: 'win1', channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '/tmp/proj', runtimeSession: 'sess', instances: { opencode: instance } };
      const runtime = createMockRuntime({
        windowExists: vi.fn().mockReturnValue(false),
      });
      const deps = createDeps({ runtime });
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (listProjectInstances as any).mockReturnValue([instance]);
      const mockAdapter = {
        buildLaunchCommand: vi.fn((cmd: string) => cmd),
        getStartCommand: vi.fn(() => 'opencode'),
        getExtraEnvVars: vi.fn(() => ({})),
      };
      (agentRegistry.get as any).mockReturnValue(mockAdapter);
      (installAgentIntegration as any).mockReturnValue({
        agentType: 'opencode',
        eventHookInstalled: true,
        infoMessages: [],
        warningMessages: [],
      });
      (buildExportPrefix as any).mockReturnValue('export DISCODE_PORT=18470; ');
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({ projectName: 'proj' });

      expect(result).toEqual({ status: 200, message: 'OK' });
      expect(runtime.startAgentInWindow).toHaveBeenCalledWith(
        'sess',
        'win1',
        expect.stringContaining('export DISCODE_PORT=18470; '),
      );
      expect(installAgentIntegration).toHaveBeenCalledWith('opencode', '/tmp/proj', 'reinstall');
      expect(buildAgentLaunchEnv).toHaveBeenCalled();
    });

    it('looks up instance by instanceId when provided', () => {
      const instance = { instanceId: 'opencode-2', agentType: 'opencode', runtimeWindow: 'win2', channelId: 'ch-2' };
      const project = { name: 'proj', projectPath: '/tmp/proj', runtimeSession: 'sess', instances: { 'opencode-2': instance } };
      const runtime = createMockRuntime({
        windowExists: vi.fn().mockReturnValue(true),
      });
      const deps = createDeps({ runtime });
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (getProjectInstance as any).mockReturnValue(instance);
      (agentRegistry.get as any).mockReturnValue({
        buildLaunchCommand: vi.fn((cmd: string) => cmd),
        getStartCommand: vi.fn(() => 'opencode'),
        getExtraEnvVars: vi.fn(() => ({})),
      });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({
        projectName: 'proj',
        instanceId: 'opencode-2',
      });

      expect(result).toEqual({ status: 200, message: 'OK' });
      expect(getProjectInstance).toHaveBeenCalledWith(project, 'opencode-2');
    });

    it('passes permissionAllow to adapter.getExtraEnvVars', () => {
      const instance = { instanceId: 'opencode', agentType: 'opencode', runtimeWindow: 'win1', channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '/tmp/proj', runtimeSession: 'sess', instances: { opencode: instance } };
      const runtime = createMockRuntime({
        windowExists: vi.fn().mockReturnValue(false),
      });
      const deps = createDeps({ runtime });
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (listProjectInstances as any).mockReturnValue([instance]);
      const mockAdapter = {
        buildLaunchCommand: vi.fn((cmd: string) => cmd),
        getStartCommand: vi.fn(() => 'opencode'),
        getExtraEnvVars: vi.fn(() => ({})),
      };
      (agentRegistry.get as any).mockReturnValue(mockAdapter);
      const routes = new HookRuntimeRoutes(deps);

      routes.handleRuntimeEnsure({
        projectName: 'proj',
        permissionAllow: true,
      });

      expect(mockAdapter.getExtraEnvVars).toHaveBeenCalledWith({ permissionAllow: true });
      expect(mockAdapter.getStartCommand).toHaveBeenCalledWith('/tmp/proj', true);
    });
  });
});

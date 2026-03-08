import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const mocks = vi.hoisted(() => {
  const stateManager = {
    listProjects: vi.fn().mockReturnValue([]),
    getProject: vi.fn().mockReturnValue(undefined),
    setProject: vi.fn(),
    removeProject: vi.fn(),
    getGuildId: vi.fn().mockReturnValue('guild-1'),
    setGuildId: vi.fn(),
    updateLastActive: vi.fn(),
    reload: vi.fn(),
    findProjectByChannel: vi.fn(),
    getAgentTypeByChannel: vi.fn(),
  };

  const config = {
    discord: { token: 'token' },
    tmux: { sessionPrefix: 'agent-', sharedSessionName: 'bridge' },
    hookServerPort: 18470,
    defaultAgentCli: 'claude',
  };

  const agentAdapter = {
    config: { name: 'claude', displayName: 'Claude Code', command: 'claude', channelSuffix: 'claude' },
    isInstalled: vi.fn().mockReturnValue(true),
    getStartCommand: vi.fn().mockReturnValue('claude'),
    matchesChannel: vi.fn(),
  };

  const agentRegistry = {
    getAll: vi.fn().mockReturnValue([agentAdapter]),
    get: vi.fn((name: string) => (name === 'claude' ? agentAdapter : undefined)),
    parseChannelName: vi.fn(),
  };

  const tmux = {
    sessionExistsFull: vi.fn().mockReturnValue(true),
    windowExists: vi.fn().mockReturnValue(true),
    ensureTuiPane: vi.fn(),
    getOrCreateSession: vi.fn(),
    setSessionEnv: vi.fn(),
    startAgentInWindow: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
  };

  const TmuxManager = vi.fn().mockImplementation(function MockTmuxManager() {
    return tmux;
  });

  const bridgeInstances: any[] = [];
  const AgentBridge = vi.fn().mockImplementation(function MockAgentBridge() {
    const instance = {
      connect: vi.fn().mockResolvedValue(undefined),
      setupProject: vi.fn().mockResolvedValue({
        channelName: 'demo-claude',
        channelId: 'ch-1',
        agentName: 'Claude Code',
        tmuxSession: 'agent-bridge',
      }),
      stop: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
    };
    bridgeInstances.push(instance);
    return instance;
  });

  const daemonService = {
    ensureDaemonRunning: vi.fn().mockResolvedValue({
      alreadyRunning: false,
      ready: true,
      port: 18470,
      logFile: '/tmp/daemon.log',
      backend: 'rust',
    }),
    getDaemonStatus: vi.fn().mockResolvedValue({
      running: false,
      port: 18470,
      logFile: '/tmp/daemon.log',
      pidFile: '/tmp/daemon.pid',
      backend: 'rust',
    }),
    restartDaemonIfRunning: vi.fn().mockResolvedValue({
      restarted: false,
      ready: false,
      port: 18470,
      logFile: '/tmp/daemon.log',
      backend: 'rust',
    }),
    stopDaemon: vi.fn().mockReturnValue(true),
  };

  const runtimeApi = {
    runtimeApiRequest: vi.fn().mockResolvedValue({ status: 200, body: 'OK' }),
    listRuntimeWindows: vi.fn().mockResolvedValue({
      activeWindowId: undefined,
      windows: [],
    }),
  };

  const tuiCommand = vi.fn().mockResolvedValue(undefined);

  const execSync = vi.fn();
  const spawnSync = vi.fn().mockReturnValue({ status: null, error: new Error('spawn ENOENT') });

  return {
    stateManager,
    config,
    agentAdapter,
    agentRegistry,
    tmux,
    TmuxManager,
    AgentBridge,
    bridgeInstances,
    daemonService,
    runtimeApi,
    tuiCommand,
    execSync,
    spawnSync,
  };
});

vi.mock('../src/index.js', () => ({
  AgentBridge: mocks.AgentBridge,
}));

vi.mock('../src/state/index.js', () => ({
  stateManager: mocks.stateManager,
}));

vi.mock('../src/config/index.js', () => ({
  validateConfig: vi.fn(),
  config: mocks.config,
  saveConfig: vi.fn(),
  getConfigPath: vi.fn().mockReturnValue('/tmp/discode/config.json'),
  getConfigValue: vi.fn(),
}));

vi.mock('../src/tmux/manager.js', () => ({
  TmuxManager: mocks.TmuxManager,
}));

vi.mock('../src/agents/index.js', () => ({
  agentRegistry: mocks.agentRegistry,
}));

vi.mock('../src/app/daemon-service.js', () => ({
  ensureDaemonRunning: mocks.daemonService.ensureDaemonRunning,
  getDaemonStatus: mocks.daemonService.getDaemonStatus,
  restartDaemonIfRunning: mocks.daemonService.restartDaemonIfRunning,
  stopDaemon: mocks.daemonService.stopDaemon,
}));

vi.mock('../src/cli/common/runtime-api.js', () => ({
  runtimeApiRequest: mocks.runtimeApi.runtimeApiRequest,
  listRuntimeWindows: mocks.runtimeApi.listRuntimeWindows,
}));

vi.mock('../src/cli/commands/tui.js', () => ({
  tuiCommand: mocks.tuiCommand,
}));

vi.mock('../src/discord/client.js', () => ({
  DiscordClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    deleteChannel: vi.fn().mockResolvedValue(true),
    getGuilds: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../src/opencode/plugin-installer.js', () => ({
  installOpencodePlugin: vi.fn().mockReturnValue('/tmp/opencode-plugin.ts'),
}));

vi.mock('../src/claude/plugin-installer.js', () => ({
  installClaudePlugin: vi.fn().mockReturnValue('/tmp/claude-plugin'),
}));

vi.mock('../src/gemini/hook-installer.js', () => ({
  installGeminiHook: vi.fn().mockReturnValue('/tmp/gemini-hook.js'),
  removeGeminiHook: vi.fn().mockReturnValue(true),
}));

vi.mock('child_process', () => ({
  execSync: mocks.execSync,
  spawnSync: mocks.spawnSync,
}));

vi.mock('http', () => ({
  request: vi.fn((_url: string, _options: any, callback?: () => void) => {
    callback?.();
    return {
      on: vi.fn(),
      setTimeout: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
  }),
}));

function applyExecSyncDefaults() {
  mocks.execSync.mockImplementation((command: string) => {
    if (command === 'tmux -V') return 'tmux 3.4';
    if (command.startsWith('tmux list-panes -a -F "#{pane_tty}"')) {
      throw new Error('no active panes');
    }
    if (command.startsWith('tmux list-panes -t ')) return '';
    if (command.startsWith('tmux kill-window -t ')) return '';
    if (command.startsWith('tmux kill-session -t ')) return '';
    if (command.startsWith('tmux attach-session -t ')) return '';
    if (command.startsWith('tmux switch-client -t ')) return '';
    if (command.startsWith('tmux display-message -p -t ')) return '';
    return '';
  });
}

describe('CLI flow safety (stage 1)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.bridgeInstances.length = 0;
    applyExecSyncDefaults();
    mocks.stateManager.listProjects.mockReturnValue([]);
    mocks.stateManager.getProject.mockReturnValue(undefined);
    mocks.stateManager.getGuildId.mockReturnValue('guild-1');
    mocks.tmux.sessionExistsFull.mockReturnValue(true);
    mocks.tmux.windowExists.mockReturnValue(true);
    delete (mocks.config as { runtimeMode?: string }).runtimeMode;
    mocks.runtimeApi.runtimeApiRequest.mockResolvedValue({ status: 200, body: 'OK' });
    mocks.runtimeApi.listRuntimeWindows.mockResolvedValue({
      activeWindowId: undefined,
      windows: [],
    });
    mocks.daemonService.ensureDaemonRunning.mockResolvedValue({
      alreadyRunning: false,
      ready: true,
      port: 18470,
      logFile: '/tmp/daemon.log',
      backend: 'rust',
    });
  });

  it('new: starts daemon and sets up a new instance', async () => {
    const mod = await import('../bin/discode.ts');

    await mod.newCommand('claude', { name: 'demo', attach: false });

    expect(mocks.daemonService.ensureDaemonRunning).toHaveBeenCalledOnce();
    expect(mocks.AgentBridge).toHaveBeenCalledOnce();

    const bridge = mocks.bridgeInstances[0];
    expect(bridge.connect).toHaveBeenCalledOnce();
    expect(bridge.setupProject).toHaveBeenCalledWith(
      'demo',
      process.cwd(),
      { claude: true },
      undefined,
      18470,
      { instanceId: 'claude', skipRuntimeStart: false },
    );
    expect(bridge.stop).toHaveBeenCalledOnce();
  });

  it('attach: attaches to requested instance window', async () => {
    const mod = await import('../bin/discode.ts');
    const project = {
      projectName: 'demo',
      projectPath: '/work/demo',
      tmuxSession: 'agent-bridge',
      createdAt: new Date(),
      lastActive: new Date(),
      agents: { claude: true },
      discordChannels: { claude: 'ch-1' },
      instances: {
        claude: { instanceId: 'claude', agentType: 'claude', tmuxWindow: 'demo-claude', channelId: 'ch-1' },
        'claude-2': { instanceId: 'claude-2', agentType: 'claude', tmuxWindow: 'demo-claude-2', channelId: 'ch-2' },
      },
    };
    mocks.stateManager.getProject.mockReturnValue(project);

    mod.attachCommand('demo', { instance: 'claude-2' });

    const attachOrSwitchCall = mocks.execSync.mock.calls.find(([command]) =>
      typeof command === 'string' &&
      (
        command.includes("tmux attach-session -t 'agent-bridge:demo-claude-2'") ||
        command.includes("tmux switch-client -t 'agent-bridge:demo-claude-2'")
      )
    );
    expect(attachOrSwitchCall).toBeTruthy();
    expect(attachOrSwitchCall?.[1]).toEqual(expect.objectContaining({ stdio: 'inherit' }));
  });

  it('stop: stops one instance and keeps remaining instances in state', async () => {
    const mod = await import('../bin/discode.ts');
    const project = {
      projectName: 'demo',
      projectPath: '/work/demo',
      tmuxSession: 'agent-bridge',
      createdAt: new Date(),
      lastActive: new Date(),
      agents: { claude: true },
      discordChannels: { claude: 'ch-1' },
      instances: {
        claude: { instanceId: 'claude', agentType: 'claude', tmuxWindow: 'demo-claude', channelId: 'ch-1' },
        'claude-2': { instanceId: 'claude-2', agentType: 'claude', tmuxWindow: 'demo-claude-2', channelId: 'ch-2' },
      },
    };
    mocks.stateManager.getProject.mockReturnValue(project);

    await mod.stopCommand('demo', { instance: 'claude-2', keepChannel: true });

    expect(mocks.execSync).toHaveBeenCalledWith(
      expect.stringContaining("tmux kill-window -t 'agent-bridge:demo-claude-2'"),
      expect.objectContaining({ stdio: 'ignore' }),
    );
    expect(mocks.stateManager.setProject).toHaveBeenCalledOnce();
    expect(mocks.stateManager.removeProject).not.toHaveBeenCalled();
  });

  it('new: shows install guidance when no agents installed', async () => {
    mocks.agentAdapter.isInstalled.mockReturnValue(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const mod = await import('../bin/discode.ts');

    await expect(mod.newCommand(undefined, { name: 'demo', attach: false }))
      .rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);

    // Verify error message
    const errorCall = errorSpy.mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('No agent CLIs found')
    );
    expect(errorCall).toBeDefined();

    // Verify install instructions for all three agents
    const allLogs = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(allLogs).toContain('npm install -g @anthropic-ai/claude-code');
    expect(allLogs).toContain('npm install -g @anthropic-ai/gemini-cli');
    expect(allLogs).toContain('go install github.com/anthropics/opencode@latest');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('attach (pty-rust): retries runtime focus before opening tui', async () => {
    const mod = await import('../bin/discode.ts');
    const project = {
      projectName: 'demo',
      projectPath: '/work/demo',
      tmuxSession: 'agent-bridge',
      createdAt: new Date(),
      lastActive: new Date(),
      agents: { claude: true },
      discordChannels: { claude: 'ch-1' },
      instances: {
        claude: { instanceId: 'claude', agentType: 'claude', tmuxWindow: 'demo-claude', channelId: 'ch-1' },
      },
    };
    mocks.config.runtimeMode = 'pty-rust';
    mocks.stateManager.getProject.mockReturnValue(project);
    const focusStatuses = [404, 404, 200];
    mocks.runtimeApi.runtimeApiRequest.mockImplementation(async (params: { path: string }) => {
      if (params.path === '/runtime/focus') {
        const status = focusStatuses.shift() ?? 404;
        return { status, body: status === 200 ? 'OK' : 'Window not found' };
      }
      if (params.path === '/runtime/ensure') {
        return { status: 200, body: 'OK' };
      }
      return { status: 200, body: 'OK' };
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mod.attachCommand('demo', { instance: 'claude' });

    const runtimeCalls = mocks.runtimeApi.runtimeApiRequest.mock.calls.map((call) => call[0] as { path: string });
    const focusCalls = runtimeCalls.filter((call) => call.path === '/runtime/focus');
    const ensureCalls = runtimeCalls.filter((call) => call.path === '/runtime/ensure');
    expect(ensureCalls).toHaveLength(1);
    expect(focusCalls).toHaveLength(3);
    expect(mocks.tuiCommand).toHaveBeenCalledOnce();
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Could not focus runtime window'));
    logSpy.mockRestore();
  });

  it('attach (pty-rust): uses native attach when enabled and available', async () => {
    const mod = await import('../bin/discode.ts');
    const project = {
      projectName: 'demo',
      projectPath: '/work/demo',
      tmuxSession: 'agent-bridge',
      createdAt: new Date(),
      lastActive: new Date(),
      agents: { claude: true },
      discordChannels: { claude: 'ch-1' },
      instances: {
        claude: { instanceId: 'claude', agentType: 'claude', tmuxWindow: 'demo-claude', channelId: 'ch-1' },
      },
    };
    const oldNative = process.env.DISCODE_NATIVE_ATTACH;
    process.env.DISCODE_NATIVE_ATTACH = '1';
    mocks.config.runtimeMode = 'pty-rust';
    mocks.stateManager.getProject.mockReturnValue(project);
    mocks.spawnSync.mockReturnValueOnce({ status: 0, error: undefined });

    await mod.attachCommand('demo', { instance: 'claude' });

    expect(mocks.spawnSync).toHaveBeenCalledOnce();
    expect(mocks.tuiCommand).not.toHaveBeenCalled();
    if (oldNative === undefined) delete process.env.DISCODE_NATIVE_ATTACH;
    else process.env.DISCODE_NATIVE_ATTACH = oldNative;
  });

  it('attach (pty-rust): uses native attach in auto mode with explicit runtime client binary', async () => {
    const mod = await import('../bin/discode.ts');
    const project = {
      projectName: 'demo',
      projectPath: '/work/demo',
      tmuxSession: 'agent-bridge',
      createdAt: new Date(),
      lastActive: new Date(),
      agents: { claude: true },
      discordChannels: { claude: 'ch-1' },
      instances: {
        claude: { instanceId: 'claude', agentType: 'claude', tmuxWindow: 'demo-claude', channelId: 'ch-1' },
      },
    };
    const oldNative = process.env.DISCODE_NATIVE_ATTACH;
    const oldBin = process.env.DISCODE_RUNTIME_CLIENT_BIN;
    delete process.env.DISCODE_NATIVE_ATTACH;
    process.env.DISCODE_RUNTIME_CLIENT_BIN = '/tmp/discode-runtime-client-test';
    mocks.config.runtimeMode = 'pty-rust';
    mocks.stateManager.getProject.mockReturnValue(project);
    mocks.spawnSync.mockReturnValueOnce({ status: 0, error: undefined });

    await mod.attachCommand('demo', { instance: 'claude' });

    expect(mocks.spawnSync).toHaveBeenCalledWith(
      '/tmp/discode-runtime-client-test',
      ['--socket', expect.any(String), '--window-id', 'agent-bridge:demo-claude', '--daemon-port', '18470'],
      { stdio: 'inherit' },
    );
    expect(mocks.tuiCommand).not.toHaveBeenCalled();
    if (oldNative === undefined) delete process.env.DISCODE_NATIVE_ATTACH;
    else process.env.DISCODE_NATIVE_ATTACH = oldNative;
    if (oldBin === undefined) delete process.env.DISCODE_RUNTIME_CLIENT_BIN;
    else process.env.DISCODE_RUNTIME_CLIENT_BIN = oldBin;
  });

  it('attach (pty-rust): discovers packaged runtime client artifact in dist/release layout', async () => {
    const mod = await import('../bin/discode.ts');
    const project = {
      projectName: 'demo',
      projectPath: '/work/demo',
      tmuxSession: 'agent-bridge',
      createdAt: new Date(),
      lastActive: new Date(),
      agents: { claude: true },
      discordChannels: { claude: 'ch-1' },
      instances: {
        claude: { instanceId: 'claude', agentType: 'claude', tmuxWindow: 'demo-claude', channelId: 'ch-1' },
      },
    };
    const oldRepo = process.env.DISCODE_REPO;
    const oldNative = process.env.DISCODE_NATIVE_ATTACH;
    const oldBin = process.env.DISCODE_RUNTIME_CLIENT_BIN;
    const tempRoot = mkdtempSync(join(tmpdir(), 'discode-native-attach-layout-'));

    const platformTag = process.platform === 'win32' ? 'windows' : process.platform;
    const archTag = process.arch;
    const binaryName = process.platform === 'win32' ? 'discode-runtime-client.exe' : 'discode-runtime-client';
    const binaryPath = join(
      tempRoot,
      'dist',
      'release',
      'runtime-client',
      `discode-runtime-client-${platformTag}-${archTag}`,
      'bin',
      binaryName,
    );
    mkdirSync(join(binaryPath, '..'), { recursive: true });
    writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n');

    try {
      process.env.DISCODE_REPO = tempRoot;
      delete process.env.DISCODE_NATIVE_ATTACH;
      delete process.env.DISCODE_RUNTIME_CLIENT_BIN;
      mocks.config.runtimeMode = 'pty-rust';
      mocks.stateManager.getProject.mockReturnValue(project);
      mocks.spawnSync.mockReturnValueOnce({ status: 0, error: undefined });

      await mod.attachCommand('demo', { instance: 'claude' });

      expect(mocks.spawnSync).toHaveBeenCalledWith(
        binaryPath,
        ['--socket', expect.any(String), '--window-id', 'agent-bridge:demo-claude', '--daemon-port', '18470'],
        { stdio: 'inherit' },
      );
      expect(mocks.tuiCommand).not.toHaveBeenCalled();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      if (oldRepo === undefined) delete process.env.DISCODE_REPO;
      else process.env.DISCODE_REPO = oldRepo;
      if (oldNative === undefined) delete process.env.DISCODE_NATIVE_ATTACH;
      else process.env.DISCODE_NATIVE_ATTACH = oldNative;
      if (oldBin === undefined) delete process.env.DISCODE_RUNTIME_CLIENT_BIN;
      else process.env.DISCODE_RUNTIME_CLIENT_BIN = oldBin;
    }
  });

  it('attach (pty-rust): falls back to tui when native attach exits non-zero', async () => {
    const mod = await import('../bin/discode.ts');
    const project = {
      projectName: 'demo',
      projectPath: '/work/demo',
      tmuxSession: 'agent-bridge',
      createdAt: new Date(),
      lastActive: new Date(),
      agents: { claude: true },
      discordChannels: { claude: 'ch-1' },
      instances: {
        claude: { instanceId: 'claude', agentType: 'claude', tmuxWindow: 'demo-claude', channelId: 'ch-1' },
      },
    };
    const oldNative = process.env.DISCODE_NATIVE_ATTACH;
    process.env.DISCODE_NATIVE_ATTACH = '1';
    mocks.config.runtimeMode = 'pty-rust';
    mocks.stateManager.getProject.mockReturnValue(project);
    mocks.spawnSync.mockReturnValueOnce({ status: 1, error: undefined });

    await mod.attachCommand('demo', { instance: 'claude' });

    expect(mocks.spawnSync).toHaveBeenCalledOnce();
    expect(mocks.tuiCommand).toHaveBeenCalledOnce();
    if (oldNative === undefined) delete process.env.DISCODE_NATIVE_ATTACH;
    else process.env.DISCODE_NATIVE_ATTACH = oldNative;
  });
});

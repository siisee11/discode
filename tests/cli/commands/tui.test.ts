import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const connect = vi.fn().mockResolvedValue(undefined);
  const fetchWindows = vi.fn().mockResolvedValue(null);
  const disconnect = vi.fn();
  const focusWindow = vi.fn().mockResolvedValue(false);
  const spawnSync = vi.fn().mockReturnValue({ status: 0 });

  return {
    connect,
    fetchWindows,
    disconnect,
    focusWindow,
    spawnSync,
  };
});

vi.mock('../../../src/config/index.js', () => ({
  config: {
    hookServerPort: 18470,
    runtimeMode: 'pty-rust',
    tmux: {
      sessionPrefix: '',
      sharedSessionName: 'bridge',
    },
  },
  getConfigValue: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/state/index.js', () => ({
  stateManager: {
    getProject: vi.fn().mockReturnValue(null),
    reload: vi.fn(),
    listProjects: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../../../src/agents/index.js', () => ({
  agentRegistry: {
    get: vi.fn(),
  },
}));

vi.mock('../../../src/tmux/manager.js', () => ({
  TmuxManager: class {
    getCurrentSession(): string | undefined {
      return undefined;
    }

    getCurrentWindow(): string | undefined {
      return undefined;
    }

    sessionExistsFull(): boolean {
      return false;
    }

    windowExists(): boolean {
      return false;
    }
  },
}));

vi.mock('../../../src/state/instances.js', () => ({
  listProjectInstances: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/app/daemon-service.js', () => ({
  ensureDaemonRunning: vi.fn().mockResolvedValue({
    alreadyRunning: false,
    ready: true,
    port: 18470,
    logFile: '/tmp/daemon.log',
    backend: 'rust',
  }),
  getDaemonLogFilePath: vi.fn().mockReturnValue('/tmp/daemon.log'),
  getDaemonStatus: vi.fn().mockResolvedValue({
    running: true,
    port: 18470,
    logFile: '/tmp/daemon.log',
    pidFile: '/tmp/daemon.pid',
    backend: 'rust',
  }),
  restartDaemonIfRunning: vi.fn(),
}));

vi.mock('../../../src/cli/common/tmux.js', () => ({
  applyTmuxCliOverrides: vi.fn((base: unknown) => base),
  getEnabledAgentNames: vi.fn().mockReturnValue([]),
  isTmuxPaneAlive: vi.fn().mockReturnValue(false),
  resolveProjectWindowName: vi.fn().mockReturnValue('demo'),
  waitForTmuxPaneAlive: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../../src/cli/common/runtime-session-manager.js', () => ({
  RuntimeSessionManager: class {
    connect = mocks.connect;
    fetchWindows = mocks.fetchWindows;
    disconnect = mocks.disconnect;
    focusWindow = mocks.focusWindow;
  },
}));

vi.mock('../../../src/cli/commands/stop.js', () => ({
  stopCommand: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: mocks.spawnSync,
  };
});

describe('tuiCommand', () => {
  const originalVersions = process.versions;
  const originalRuntimeClientBin = process.env.DISCODE_RUNTIME_CLIENT_BIN;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.DISCODE_RUNTIME_CLIENT_BIN;
    mocks.fetchWindows.mockResolvedValue(null);
    mocks.focusWindow.mockResolvedValue(false);
    mocks.spawnSync.mockReturnValue({ status: 0, error: undefined });
    Object.defineProperty(process, 'versions', {
      configurable: true,
      value: {
        ...originalVersions,
        bun: '1.0.0',
      },
    });
  });

  afterEach(() => {
    if (originalRuntimeClientBin === undefined) {
      delete process.env.DISCODE_RUNTIME_CLIENT_BIN;
    } else {
      process.env.DISCODE_RUNTIME_CLIENT_BIN = originalRuntimeClientBin;
    }
    Object.defineProperty(process, 'versions', {
      configurable: true,
      value: originalVersions,
    });
  });

  it('uses the native Rust client when a runtime window is available', async () => {
    process.env.DISCODE_RUNTIME_CLIENT_BIN = '/tmp/discode-runtime-client-test';
    mocks.fetchWindows.mockResolvedValue({
      activeWindowId: 'bridge:demo',
      windows: [
        { windowId: 'bridge:demo', sessionName: 'bridge', windowName: 'demo' },
      ],
    });
    mocks.focusWindow.mockResolvedValue(true);
    mocks.spawnSync.mockReturnValue({ status: 0, error: undefined });

    const { tuiCommand } = await import('../../../src/cli/commands/tui.js');

    await tuiCommand({});

    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      '/tmp/discode-runtime-client-test',
      ['--socket', expect.any(String), '--window-id', 'bridge:demo', '--daemon-port', '18470'],
      { stdio: 'inherit' },
    );
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it('prints guidance when no runtime window is available', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { tuiCommand } = await import('../../../src/cli/commands/tui.js');

    await tuiCommand({});

    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No active runtime window found.'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('discode attach <project>'));
    logSpy.mockRestore();
  });
});

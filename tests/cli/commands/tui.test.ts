import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const connect = vi.fn().mockResolvedValue(undefined);
  const fetchWindows = vi.fn().mockResolvedValue(null);
  const disconnect = vi.fn();
  const focusWindow = vi.fn().mockResolvedValue(false);
  const ensureConnected = vi.fn().mockResolvedValue(false);
  const getTransportStatus = vi.fn().mockReturnValue({
    mode: 'stream',
    connected: false,
    detail: 'stream disconnected',
  });
  const runTui = vi.fn().mockResolvedValue(undefined);

  return {
    connect,
    fetchWindows,
    disconnect,
    focusWindow,
    ensureConnected,
    getTransportStatus,
    runTui,
  };
});

vi.mock('@opentui/solid/preload', () => ({}));

vi.mock('../../../bin/tui.tsx', () => ({
  runTui: mocks.runTui,
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    hookServerPort: 18470,
    runtimeMode: 'tmux',
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
  ensureDaemonRunning: vi.fn(),
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

vi.mock('../../../src/runtime/mode.js', () => ({
  isPtyRuntimeMode: (value: string | undefined) => value === 'pty-rust',
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
    ensureConnected = mocks.ensureConnected;
    getTransportStatus = mocks.getTransportStatus;

    isSupported(): boolean | undefined {
      return undefined;
    }

    readWindowOutput(): Promise<string | undefined> {
      return Promise.resolve(undefined);
    }

    sendRawKey(): Promise<void> {
      return Promise.resolve();
    }

    sendResize(): Promise<void> {
      return Promise.resolve();
    }

    registerFrameListener(): () => void {
      return () => {};
    }
  },
}));

vi.mock('../../../src/cli/commands/attach.js', () => ({
  attachCommand: vi.fn(),
}));

vi.mock('../../../src/cli/commands/stop.js', () => ({
  stopCommand: vi.fn(),
}));

describe('tuiCommand', () => {
  const originalVersions = process.versions;
  const originalTmux = process.env.TMUX;
  const originalTmuxPane = process.env.TMUX_PANE;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    Object.defineProperty(process, 'versions', {
      configurable: true,
      value: {
        ...originalVersions,
        bun: '1.0.0',
      },
    });
  });

  afterEach(() => {
    if (originalTmux === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = originalTmux;
    }
    if (originalTmuxPane === undefined) {
      delete process.env.TMUX_PANE;
    } else {
      process.env.TMUX_PANE = originalTmuxPane;
    }
    Object.defineProperty(process, 'versions', {
      configurable: true,
      value: originalVersions,
    });
  });

  it('skips runtime stream connection for tmux mode', async () => {
    const { tuiCommand } = await import('../../../src/cli/commands/tui.js');

    await tuiCommand({});

    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.runTui).toHaveBeenCalledOnce();

    const tuiInput = mocks.runTui.mock.calls[0]?.[0];
    expect(tuiInput.runtimeMode).toBe('tmux');
    await expect(tuiInput.getRuntimeStatus()).resolves.toEqual({
      mode: 'stream',
      connected: false,
      detail: 'disabled for tmux runtime',
    });
    expect(mocks.ensureConnected).not.toHaveBeenCalled();
  });
});

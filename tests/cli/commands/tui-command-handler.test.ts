import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleTuiCommand, type TuiCommandDeps } from '../../../src/cli/commands/tui-command-handler.js';

const mockNewCommand = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockStopCommand = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockOnboardCommand = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockValidateConfig = vi.hoisted(() => vi.fn());
const mockHandleConfigShow = vi.hoisted(() => vi.fn().mockReturnValue('handled'));
const mockHandleConfigSet = vi.hoisted(() => vi.fn().mockReturnValue('handled'));

vi.mock('../../../src/cli/commands/new.js', () => ({ newCommand: mockNewCommand }));
vi.mock('../../../src/cli/commands/stop.js', () => ({ stopCommand: mockStopCommand }));
vi.mock('../../../src/cli/commands/onboard.js', () => ({ onboardCommand: mockOnboardCommand }));
vi.mock('../../../src/cli/commands/tui-config-commands.js', () => ({
  handleConfigShow: mockHandleConfigShow,
  handleConfigSet: mockHandleConfigSet,
}));
vi.mock('../../../src/config/index.js', () => ({
  config: {
    tmux: { sessionPrefix: 'discode-' },
    discord: {},
    defaultAgentCli: 'claude',
    runtimeMode: 'tmux',
  },
  validateConfig: mockValidateConfig,
}));
vi.mock('../../../src/state/index.js', () => ({
  stateManager: {
    listProjects: vi.fn().mockReturnValue([]),
    getWorkspaceId: vi.fn().mockReturnValue('guild-1'),
    getGuildId: vi.fn().mockReturnValue('guild-1'),
  },
}));
vi.mock('../../../src/agents/index.js', () => ({
  agentRegistry: {
    getAll: vi.fn().mockReturnValue([
      {
        config: { name: 'claude', displayName: 'Claude' },
        isInstalled: () => true,
      },
    ]),
    get: vi.fn(),
  },
}));
vi.mock('../../../src/state/instances.js', () => ({
  listProjectInstances: vi.fn().mockReturnValue([]),
}));
vi.mock('../../../src/tmux/manager.js', () => ({
  TmuxManager: class {
    sessionExistsFull() { return false; }
  },
}));

function createMockDeps(): TuiCommandDeps {
  return {
    session: {
      isSupported: vi.fn().mockReturnValue(false),
      getWindowsCache: vi.fn().mockReturnValue(null),
      requireConnected: vi.fn().mockResolvedValue(undefined),
      sendInput: vi.fn(),
      fetchWindows: vi.fn().mockResolvedValue(null),
    } as any,
    options: {} as any,
    effectiveConfig: {} as any,
    getKeepChannelOnStop: vi.fn().mockReturnValue(false),
    setKeepChannelOnStop: vi.fn(),
    nextProjectName: vi.fn().mockReturnValue('project-1'),
    reloadStateFromDisk: vi.fn(),
  };
}

describe('handleTuiCommand', () => {
  let lines: string[];
  let append: (line: string) => void;

  beforeEach(() => {
    lines = [];
    append = (line: string) => lines.push(line);
    vi.clearAllMocks();
  });

  it('/exit returns "exit"', async () => {
    const deps = createMockDeps();
    const result = await handleTuiCommand('/exit', append, deps);
    expect(result).toBe('exit');
  });

  it('/quit returns "exit"', async () => {
    const deps = createMockDeps();
    const result = await handleTuiCommand('/quit', append, deps);
    expect(result).toBe('exit');
  });

  it('/help appends help text', async () => {
    const deps = createMockDeps();
    const result = await handleTuiCommand('/help', append, deps);
    expect(result).toBe('handled');
    expect(lines.some((l) => l.includes('/new'))).toBe(true);
    expect(lines.some((l) => l.includes('/exit'))).toBe(true);
  });

  it('/config delegates to handleConfigShow', async () => {
    const deps = createMockDeps();
    await handleTuiCommand('/config', append, deps);
    expect(mockHandleConfigShow).toHaveBeenCalled();
  });

  it('/config keepChannel on delegates to handleConfigSet', async () => {
    const deps = createMockDeps();
    await handleTuiCommand('/config keepChannel on', append, deps);
    expect(mockHandleConfigSet).toHaveBeenCalledWith('/config keepChannel on', append, deps);
  });

  it('/list reloads state from disk', async () => {
    const deps = createMockDeps();
    await handleTuiCommand('/list', append, deps);
    expect(deps.reloadStateFromDisk).toHaveBeenCalled();
  });

  it('/projects reloads state from disk', async () => {
    const deps = createMockDeps();
    await handleTuiCommand('/projects', append, deps);
    expect(deps.reloadStateFromDisk).toHaveBeenCalled();
  });

  it('bare /stop shows usage', async () => {
    const deps = createMockDeps();
    await handleTuiCommand('/stop', append, deps);
    expect(lines[0]).toContain('Use stop dialog');
  });

  it('/stop projectName calls stopCommand', async () => {
    const deps = createMockDeps();
    await handleTuiCommand('/stop myProject', append, deps);
    expect(mockStopCommand).toHaveBeenCalledWith('myProject', expect.objectContaining({
      instance: undefined,
      keepChannel: false,
    }));
    expect(lines.some((l) => l.includes('Stopped'))).toBe(true);
  });

  it('/stop projectName --instance inst-1 passes instanceId', async () => {
    const deps = createMockDeps();
    await handleTuiCommand('/stop myProject --instance inst-1', append, deps);
    expect(mockStopCommand).toHaveBeenCalledWith('myProject', expect.objectContaining({
      instance: 'inst-1',
    }));
  });

  it('/new calls newCommand with parsed args', async () => {
    const deps = createMockDeps();
    await handleTuiCommand('/new myProject', append, deps);
    expect(mockNewCommand).toHaveBeenCalledWith('claude', expect.objectContaining({
      name: 'myProject',
    }));
    expect(lines.some((l) => l.includes('Session created'))).toBe(true);
  });

  it('/new --path passes cwd override', async () => {
    const deps = createMockDeps();
    await handleTuiCommand('/new --path "/tmp/work dir"', append, deps);
    expect(mockNewCommand).toHaveBeenCalledWith('claude', expect.objectContaining({
      cwd: '/tmp/work dir',
    }));
  });


  it('/onboard --help shows usage', async () => {
    const deps = createMockDeps();
    await handleTuiCommand('/onboard --help', append, deps);
    expect(lines.some((l) => l.includes('Usage:'))).toBe(true);
  });

  it('/onboard with invalid flag shows error', async () => {
    const deps = createMockDeps();
    await handleTuiCommand('/onboard --invalid-flag', append, deps);
    expect(lines.some((l) => l.includes('Unknown option'))).toBe(true);
  });

  it('/onboard with valid flags calls onboardCommand', async () => {
    const deps = createMockDeps();
    await handleTuiCommand('/onboard --platform discord', append, deps);
    expect(mockOnboardCommand).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'discord',
      nonInteractive: true,
      exitOnError: false,
    }));
    expect(lines.some((l) => l.includes('Onboarding complete'))).toBe(true);
  });

  it('unknown command without focused window shows error', async () => {
    const deps = createMockDeps();
    await handleTuiCommand('unknown-cmd', append, deps);
    expect(lines.some((l) => l.includes('Unknown command'))).toBe(true);
  });

  it('raw input with focused window sends to window', async () => {
    const deps = createMockDeps();
    (deps.session.isSupported as any).mockReturnValue(true);
    (deps.session.getWindowsCache as any).mockReturnValue({ activeWindowId: 'sess:win1' });
    await handleTuiCommand('hello world', append, deps);
    expect(deps.session.sendInput).toHaveBeenCalledWith('sess:win1', expect.any(Buffer));
    expect(lines[0]).toContain('sent to sess:win1');
  });
});

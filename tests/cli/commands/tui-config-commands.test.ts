import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleConfigShow, handleConfigSet } from '../../../src/cli/commands/tui-config-commands.js';
import type { TuiCommandDeps } from '../../../src/cli/commands/tui-command-handler.js';

const mockSaveConfig = vi.hoisted(() => vi.fn());
const mockConfig = vi.hoisted(() => ({
  defaultAgentCli: 'claude',
  discord: { channelId: '' },
  runtimeMode: 'pty-rust' as 'pty-rust',
}));

vi.mock('../../../src/config/index.js', () => ({
  config: mockConfig,
  saveConfig: mockSaveConfig,
}));

vi.mock('../../../src/agents/index.js', () => ({
  agentRegistry: {
    getAll: vi.fn().mockReturnValue([
      { config: { name: 'claude' } },
      { config: { name: 'gemini' } },
    ]),
    get: vi.fn((name: string) => {
      if (name === 'claude') return { config: { name: 'claude' } };
      if (name === 'gemini') return { config: { name: 'gemini' } };
      return undefined;
    }),
  },
}));

function createMockDeps(keepChannel = false): TuiCommandDeps {
  return {
    session: {} as any,
    options: {} as any,
    effectiveConfig: {} as any,
    getKeepChannelOnStop: vi.fn().mockReturnValue(keepChannel),
    setKeepChannelOnStop: vi.fn(),
    nextProjectName: vi.fn(),
    reloadStateFromDisk: vi.fn(),
  };
}

describe('handleConfigShow', () => {
  let lines: string[];
  let append: (line: string) => void;

  beforeEach(() => {
    lines = [];
    append = (line: string) => lines.push(line);
    mockConfig.defaultAgentCli = 'claude';
    mockConfig.discord.channelId = '';
    mockConfig.runtimeMode = 'pty-rust';
  });

  it('shows keepChannel off', () => {
    const deps = createMockDeps(false);
    handleConfigShow(append, deps);
    expect(lines[0]).toContain('keepChannel: off');
  });

  it('shows keepChannel on', () => {
    const deps = createMockDeps(true);
    handleConfigShow(append, deps);
    expect(lines[0]).toContain('keepChannel: on');
  });

  it('shows defaultAgent', () => {
    const deps = createMockDeps();
    handleConfigShow(append, deps);
    expect(lines[1]).toContain('defaultAgent: claude');
  });

  it('shows (auto) when defaultAgent is empty', () => {
    mockConfig.defaultAgentCli = '';
    const deps = createMockDeps();
    handleConfigShow(append, deps);
    expect(lines[1]).toContain('(auto)');
  });

  it('shows runtimeMode', () => {
    const deps = createMockDeps();
    handleConfigShow(append, deps);
    expect(lines[3]).toContain('runtimeMode: pty-rust');
  });

  it('returns "handled"', () => {
    const deps = createMockDeps();
    expect(handleConfigShow(append, deps)).toBe('handled');
  });
});

describe('handleConfigSet', () => {
  let lines: string[];
  let append: (line: string) => void;

  beforeEach(() => {
    lines = [];
    append = (line: string) => lines.push(line);
    vi.clearAllMocks();
    mockConfig.defaultAgentCli = 'claude';
    mockConfig.discord.channelId = '';
    mockConfig.runtimeMode = 'pty-rust';
  });

  describe('keepChannel', () => {
    it('toggles keepChannel on', () => {
      const deps = createMockDeps(false);
      handleConfigSet('/config keepChannel toggle', append, deps);
      expect(deps.setKeepChannelOnStop).toHaveBeenCalledWith(true);
      expect(mockSaveConfig).toHaveBeenCalledWith({ keepChannelOnStop: true });
      expect(lines[0]).toContain('keepChannel is now on');
    });

    it('sets keepChannel off', () => {
      const deps = createMockDeps(true);
      handleConfigSet('/config keepChannel off', append, deps);
      expect(deps.setKeepChannelOnStop).toHaveBeenCalledWith(false);
      expect(mockSaveConfig).toHaveBeenCalledWith({ keepChannelOnStop: false });
    });

    it('sets keepChannel on explicitly', () => {
      const deps = createMockDeps(false);
      handleConfigSet('/config keepChannel on', append, deps);
      expect(deps.setKeepChannelOnStop).toHaveBeenCalledWith(true);
    });

    it('defaults to toggle when no value given', () => {
      const deps = createMockDeps(false);
      handleConfigSet('/config keepChannel', append, deps);
      expect(deps.setKeepChannelOnStop).toHaveBeenCalledWith(true);
    });

    it('shows error for unknown keepChannel value', () => {
      const deps = createMockDeps();
      handleConfigSet('/config keepChannel maybe', append, deps);
      expect(lines[0]).toContain('Unknown mode');
    });

    it('accepts keep-channel alias', () => {
      const deps = createMockDeps(false);
      handleConfigSet('/config keep-channel on', append, deps);
      expect(deps.setKeepChannelOnStop).toHaveBeenCalledWith(true);
    });
  });

  describe('defaultAgent', () => {
    it('sets defaultAgent to claude', () => {
      const deps = createMockDeps();
      handleConfigSet('/config defaultAgent claude', append, deps);
      expect(mockSaveConfig).toHaveBeenCalledWith({ defaultAgentCli: 'claude' });
      expect(lines[0]).toContain('defaultAgent is now claude');
    });

    it('clears defaultAgent with auto', () => {
      const deps = createMockDeps();
      handleConfigSet('/config defaultAgent auto', append, deps);
      expect(mockSaveConfig).toHaveBeenCalledWith({ defaultAgentCli: undefined });
    });

    it('shows error for unknown agent', () => {
      const deps = createMockDeps();
      handleConfigSet('/config defaultAgent unknown', append, deps);
      expect(lines[0]).toContain('Unknown agent');
    });

    it('shows current value when no argument', () => {
      const deps = createMockDeps();
      handleConfigSet('/config defaultAgent', append, deps);
      expect(lines[0]).toContain('defaultAgent: claude');
    });

    it('accepts default-agent alias', () => {
      const deps = createMockDeps();
      handleConfigSet('/config default-agent claude', append, deps);
      expect(mockSaveConfig).toHaveBeenCalledWith({ defaultAgentCli: 'claude' });
    });
  });

  describe('defaultChannel', () => {
    it('sets defaultChannel to an ID', () => {
      const deps = createMockDeps();
      handleConfigSet('/config defaultChannel 12345', append, deps);
      expect(mockSaveConfig).toHaveBeenCalledWith({ channelId: '12345' });
      expect(lines[0]).toContain('defaultChannel is now 12345');
    });

    it('normalizes Discord channel mention format', () => {
      const deps = createMockDeps();
      handleConfigSet('/config defaultChannel <#12345>', append, deps);
      expect(mockSaveConfig).toHaveBeenCalledWith({ channelId: '12345' });
    });

    it('clears defaultChannel with auto', () => {
      const deps = createMockDeps();
      handleConfigSet('/config defaultChannel auto', append, deps);
      expect(mockSaveConfig).toHaveBeenCalledWith({ channelId: undefined });
    });

    it('shows current value when no argument', () => {
      const deps = createMockDeps();
      handleConfigSet('/config defaultChannel', append, deps);
      expect(lines[0]).toContain('defaultChannel:');
    });
  });

  describe('runtimeMode', () => {
    it('sets runtimeMode to pty-rust', () => {
      const deps = createMockDeps();
      handleConfigSet('/config runtimeMode pty-rust', append, deps);
      expect(mockSaveConfig).toHaveBeenCalledWith({ runtimeMode: 'pty-rust' });
      expect(lines[0]).toContain('runtimeMode is now pty-rust');
    });

    it('shows error for unknown runtime mode', () => {
      const deps = createMockDeps();
      handleConfigSet('/config runtimeMode screen', append, deps);
      expect(lines[0]).toContain('Unknown runtime mode');
    });

    it('shows current value when no argument', () => {
      const deps = createMockDeps();
      handleConfigSet('/config runtimeMode', append, deps);
      expect(lines[0]).toContain('runtimeMode: pty-rust');
    });

    it('accepts runtime-mode key alias', () => {
      const deps = createMockDeps();
      handleConfigSet('/config runtime-mode pty-rust', append, deps);
      expect(mockSaveConfig).toHaveBeenCalledWith({ runtimeMode: 'pty-rust' });
    });

    it('rejects legacy runtime mode aliases', () => {
      const deps = createMockDeps();
      handleConfigSet('/config runtimeMode pty', append, deps);
      expect(lines[0]).toContain('Unknown runtime mode');
      handleConfigSet('/config runtimeMode pty-ts', append, deps);
      expect(lines[2]).toContain('Unknown runtime mode');
    });

    it('rejects removed tmux runtime mode', () => {
      const deps = createMockDeps();
      handleConfigSet('/config runtimeMode tmux', append, deps);
      expect(lines[0]).toContain('Unknown runtime mode');
    });
  });

  describe('unknown key', () => {
    it('shows error for unknown config key', () => {
      const deps = createMockDeps();
      handleConfigSet('/config unknownKey', append, deps);
      expect(lines[0]).toContain('Unknown config key');
    });

    it('shows supported keys in error', () => {
      const deps = createMockDeps();
      handleConfigSet('/config badKey', append, deps);
      expect(lines[1]).toContain('Supported keys');
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const stateManager = {
    getGuildId: vi.fn().mockReturnValue(undefined),
    setGuildId: vi.fn(),
    setWorkspaceId: vi.fn(),
  };

  const saveConfig = vi.fn();
  const getConfigPath = vi.fn().mockReturnValue('/tmp/discode/config.json');
  const getConfigValue = vi.fn().mockReturnValue(undefined);

  const agentRegistry = {
    getAll: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(undefined),
  };

  const resolveTelemetrySettings = vi.fn().mockReturnValue({
    enabled: false,
    installId: undefined,
    endpoint: undefined,
  });
  const isValidTelemetryEndpoint = vi.fn().mockReturnValue(true);
  const ensureTelemetryInstallId = vi.fn().mockReturnValue(undefined);

  const parseRuntimeModeInput = vi.fn().mockReturnValue(undefined);
  const normalizeDiscordToken = vi.fn((t: string | undefined) => t?.trim() || undefined);

  return {
    stateManager,
    saveConfig,
    getConfigPath,
    getConfigValue,
    agentRegistry,
    resolveTelemetrySettings,
    isValidTelemetryEndpoint,
    ensureTelemetryInstallId,
    parseRuntimeModeInput,
    normalizeDiscordToken,
  };
});

vi.mock('../../../src/state/index.js', () => ({ stateManager: mocks.stateManager }));
vi.mock('../../../src/agents/index.js', () => ({ agentRegistry: mocks.agentRegistry }));
vi.mock('../../../src/telemetry/index.js', () => ({
  resolveTelemetrySettings: mocks.resolveTelemetrySettings,
  isValidTelemetryEndpoint: mocks.isValidTelemetryEndpoint,
  ensureTelemetryInstallId: mocks.ensureTelemetryInstallId,
}));
vi.mock('../../../src/runtime/mode.js', () => ({
  parseRuntimeModeInput: mocks.parseRuntimeModeInput,
}));
vi.mock('../../../src/config/token.js', () => ({
  normalizeDiscordToken: mocks.normalizeDiscordToken,
}));

// config mock must expose a mutable `messagingPlatform` property
let configMessagingPlatform: string | undefined = undefined;
vi.mock('../../../src/config/index.js', () => ({
  get config() {
    return { messagingPlatform: configMessagingPlatform };
  },
  saveConfig: mocks.saveConfig,
  getConfigPath: mocks.getConfigPath,
  getConfigValue: mocks.getConfigValue,
}));

describe('configCommand --server validation', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    configMessagingPlatform = undefined;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('Discord (default platform)', () => {
    it('accepts a valid 19-digit Discord server ID', async () => {
      const { configCommand } = await import('../../../src/cli/commands/config.js');
      await configCommand({ server: '1234567890123456789' });
      expect(mocks.stateManager.setGuildId).toHaveBeenCalledWith('1234567890123456789');
      expect(mocks.saveConfig).toHaveBeenCalledWith({ serverId: '1234567890123456789' });
    });

    it('accepts a valid 17-digit Discord server ID', async () => {
      const { configCommand } = await import('../../../src/cli/commands/config.js');
      await configCommand({ server: '12345678901234567' });
      expect(mocks.stateManager.setGuildId).toHaveBeenCalledWith('12345678901234567');
    });

    it('rejects a doubled Discord server ID (38 digits)', async () => {
      const { configCommand } = await import('../../../src/cli/commands/config.js');
      await expect(
        configCommand({ server: '12345678901234567891234567890123456789' })
      ).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const allErrors = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(allErrors).toContain('Invalid Discord server ID');
    });

    it('rejects a non-numeric server ID on Discord platform', async () => {
      const { configCommand } = await import('../../../src/cli/commands/config.js');
      await expect(
        configCommand({ server: 'not-a-snowflake' })
      ).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects a 16-digit ID (too short for a snowflake)', async () => {
      const { configCommand } = await import('../../../src/cli/commands/config.js');
      await expect(
        configCommand({ server: '1234567890123456' })
      ).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects a 21-digit ID (too long for a snowflake)', async () => {
      const { configCommand } = await import('../../../src/cli/commands/config.js');
      await expect(
        configCommand({ server: '123456789012345678901' })
      ).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('Slack platform (via --platform slack in same command)', () => {
    it('accepts a valid Slack workspace ID', async () => {
      const { configCommand } = await import('../../../src/cli/commands/config.js');
      await configCommand({ server: 'T01ABCDEFG', platform: 'slack' });
      expect(mocks.stateManager.setGuildId).toHaveBeenCalledWith('T01ABCDEFG');
      expect(mocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'T01ABCDEFG' }));
    });

    it('rejects a doubled Slack workspace ID', async () => {
      const { configCommand } = await import('../../../src/cli/commands/config.js');
      await expect(
        configCommand({ server: 'T01ABCDEFGT01ABCDEFG', platform: 'slack' })
      ).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const allErrors = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(allErrors).toContain('Invalid Slack workspace ID');
    });

    it('rejects a Discord-style ID when platform is slack', async () => {
      const { configCommand } = await import('../../../src/cli/commands/config.js');
      await expect(
        configCommand({ server: '1234567890123456789', platform: 'slack' })
      ).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('Slack platform (pre-configured in config)', () => {
    it('accepts a valid Slack workspace ID when platform already configured as slack', async () => {
      configMessagingPlatform = 'slack';
      const { configCommand } = await import('../../../src/cli/commands/config.js');
      await configCommand({ server: 'TABCDE12345' });
      expect(mocks.stateManager.setGuildId).toHaveBeenCalledWith('TABCDE12345');
    });

    it('rejects invalid Slack workspace ID when platform already configured as slack', async () => {
      configMessagingPlatform = 'slack';
      const { configCommand } = await import('../../../src/cli/commands/config.js');
      await expect(
        configCommand({ server: 'TABCDE12345TABCDE12345' })
      ).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});

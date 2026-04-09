import { describe, expect, it } from 'vitest';
import { parseNewCommand, parseOnboardCommand } from '../../../src/cli/common/tui-command-parsers.js';

describe('parseNewCommand', () => {
  it('parses bare /new with no arguments', () => {
    const result = parseNewCommand('/new');
    expect(result).toEqual({
      projectName: undefined,
      agentName: undefined,
      attach: false,
      instanceId: undefined,
      projectPath: undefined,
    });
  });

  it('parses /new with project name', () => {
    const result = parseNewCommand('/new myProject');
    expect(result.projectName).toBe('myProject');
    expect(result.agentName).toBeUndefined();
  });

  it('parses /new with project name and agent name', () => {
    const result = parseNewCommand('/new myProject claude');
    expect(result.projectName).toBe('myProject');
    expect(result.agentName).toBe('claude');
  });

  it('parses --attach flag', () => {
    const result = parseNewCommand('/new myProject --attach');
    expect(result.attach).toBe(true);
    expect(result.projectName).toBe('myProject');
  });

  it('parses --instance with space-separated value', () => {
    const result = parseNewCommand('/new myProject --instance inst-1');
    expect(result.instanceId).toBe('inst-1');
    expect(result.projectName).toBe('myProject');
  });

  it('parses --instance= with equals sign', () => {
    const result = parseNewCommand('/new myProject --instance=inst-2');
    expect(result.instanceId).toBe('inst-2');
  });

  it('ignores --instance= with empty value', () => {
    const result = parseNewCommand('/new myProject --instance=');
    expect(result.instanceId).toBeUndefined();
  });

  it('ignores unknown flags', () => {
    const result = parseNewCommand('/new --verbose myProject');
    expect(result.projectName).toBe('myProject');
  });

  it('handles multiple flags together', () => {
    const result = parseNewCommand('/new --attach myProject claude --instance abc');
    expect(result.attach).toBe(true);
    expect(result.projectName).toBe('myProject');
    expect(result.agentName).toBe('claude');
    expect(result.instanceId).toBe('abc');
  });

  it('handles extra whitespace', () => {
    const result = parseNewCommand('  /new   myProject   ');
    expect(result.projectName).toBe('myProject');
  });

  it('parses --path with quoted value', () => {
    const result = parseNewCommand('/new --path "/tmp/my folder"');
    expect(result.projectPath).toBe('/tmp/my folder');
  });

  it('parses --path= with escaped spaces', () => {
    const result = parseNewCommand('/new --path=/tmp/my\\ folder');
    expect(result.projectPath).toBe('/tmp/my folder');
  });
});

describe('parseOnboardCommand', () => {
  it('parses bare /onboard with no arguments', () => {
    const result = parseOnboardCommand('/onboard');
    expect(result.options).toEqual({});
    expect(result.showUsage).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('detects --help flag', () => {
    expect(parseOnboardCommand('/onboard --help').showUsage).toBe(true);
  });

  it('detects -h flag', () => {
    expect(parseOnboardCommand('/onboard -h').showUsage).toBe(true);
  });

  it('parses positional platform argument (discord)', () => {
    const result = parseOnboardCommand('/onboard discord');
    expect(result.options.platform).toBe('discord');
  });

  it('parses positional platform argument (slack)', () => {
    const result = parseOnboardCommand('/onboard slack');
    expect(result.options.platform).toBe('slack');
  });

  it('returns error for unknown positional argument', () => {
    const result = parseOnboardCommand('/onboard telegram');
    expect(result.error).toBe('Unknown option: telegram');
  });

  it('parses --platform discord', () => {
    const result = parseOnboardCommand('/onboard --platform discord');
    expect(result.options.platform).toBe('discord');
  });

  it('parses --platform=slack', () => {
    const result = parseOnboardCommand('/onboard --platform=slack');
    expect(result.options.platform).toBe('slack');
  });

  it('returns error for invalid platform', () => {
    const result = parseOnboardCommand('/onboard --platform teams');
    expect(result.error).toBe('platform must be discord or slack.');
  });

  it('parses --runtime-mode pty-rust', () => {
    const result = parseOnboardCommand('/onboard --runtime-mode pty-rust');
    expect(result.options.runtimeMode).toBe('pty-rust');
  });

  it('rejects legacy runtime-mode aliases', () => {
    expect(parseOnboardCommand('/onboard --runtime-mode pty').error).toBe('runtime mode must be pty-rust.');
    expect(parseOnboardCommand('/onboard --runtime-mode pty-ts').error).toBe('runtime mode must be pty-rust.');
  });

  it('returns error for invalid runtime-mode', () => {
    const result = parseOnboardCommand('/onboard --runtime-mode screen');
    expect(result.error).toBe('runtime mode must be pty-rust.');
  });

  it('returns error for removed tmux runtime-mode', () => {
    const result = parseOnboardCommand('/onboard --runtime-mode tmux');
    expect(result.error).toBe('runtime mode must be pty-rust.');
  });

  it('parses --token', () => {
    const result = parseOnboardCommand('/onboard --token abc123');
    expect(result.options.token).toBe('abc123');
  });

  it('returns error for --token without value', () => {
    const result = parseOnboardCommand('/onboard --token');
    expect(result.error).toBe('token requires a value.');
  });

  it('parses --slack-bot-token', () => {
    const result = parseOnboardCommand('/onboard --slack-bot-token xoxb-123');
    expect(result.options.slackBotToken).toBe('xoxb-123');
  });

  it('returns error for --slack-bot-token without value', () => {
    const result = parseOnboardCommand('/onboard --slack-bot-token');
    expect(result.error).toBe('slack-bot-token requires a value.');
  });

  it('parses --slack-app-token', () => {
    const result = parseOnboardCommand('/onboard --slack-app-token xapp-456');
    expect(result.options.slackAppToken).toBe('xapp-456');
  });

  it('returns error for --slack-app-token without value', () => {
    const result = parseOnboardCommand('/onboard --slack-app-token');
    expect(result.error).toBe('slack-app-token requires a value.');
  });

  it('parses --default-agent', () => {
    const result = parseOnboardCommand('/onboard --default-agent claude');
    expect(result.options.defaultAgentCli).toBe('claude');
  });

  it('returns error for --default-agent without value', () => {
    const result = parseOnboardCommand('/onboard --default-agent');
    expect(result.error).toBe('default-agent requires a value.');
  });

  it('parses --telemetry on', () => {
    const result = parseOnboardCommand('/onboard --telemetry on');
    expect(result.options.telemetryEnabled).toBe(true);
  });

  it('parses --telemetry off', () => {
    const result = parseOnboardCommand('/onboard --telemetry off');
    expect(result.options.telemetryEnabled).toBe(false);
  });

  it('parses --telemetry true/false', () => {
    expect(parseOnboardCommand('/onboard --telemetry true').options.telemetryEnabled).toBe(true);
    expect(parseOnboardCommand('/onboard --telemetry false').options.telemetryEnabled).toBe(false);
  });

  it('parses --telemetry 1/0', () => {
    expect(parseOnboardCommand('/onboard --telemetry 1').options.telemetryEnabled).toBe(true);
    expect(parseOnboardCommand('/onboard --telemetry 0').options.telemetryEnabled).toBe(false);
  });

  it('parses --telemetry yes/no', () => {
    expect(parseOnboardCommand('/onboard --telemetry yes').options.telemetryEnabled).toBe(true);
    expect(parseOnboardCommand('/onboard --telemetry no').options.telemetryEnabled).toBe(false);
  });

  it('returns error for invalid telemetry value', () => {
    const result = parseOnboardCommand('/onboard --telemetry maybe');
    expect(result.error).toBe('telemetry must be on/off/true/false.');
  });

  it('returns error for --telemetry without value', () => {
    const result = parseOnboardCommand('/onboard --telemetry');
    expect(result.error).toBe('telemetry requires a value (on/off).');
  });

  it('parses --opencode-permission allow', () => {
    const result = parseOnboardCommand('/onboard --opencode-permission allow');
    expect(result.options.opencodePermissionMode).toBe('allow');
  });

  it('parses --opencode-permission default', () => {
    const result = parseOnboardCommand('/onboard --opencode-permission default');
    expect(result.options.opencodePermissionMode).toBe('default');
  });

  it('returns error for invalid opencode-permission value', () => {
    const result = parseOnboardCommand('/onboard --opencode-permission deny');
    expect(result.error).toBe('opencode-permission must be allow or default.');
  });

  it('returns error for unknown flag', () => {
    const result = parseOnboardCommand('/onboard --unknown-flag');
    expect(result.error).toBe('Unknown option: --unknown-flag');
  });

  it('parses multiple flags together', () => {
    const result = parseOnboardCommand('/onboard --platform discord --token abc --runtime-mode pty-rust --telemetry on');
    expect(result.options.platform).toBe('discord');
    expect(result.options.token).toBe('abc');
    expect(result.options.runtimeMode).toBe('pty-rust');
    expect(result.options.telemetryEnabled).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('parses --platform with equals and case insensitivity', () => {
    const result = parseOnboardCommand('/onboard --platform=Discord');
    expect(result.options.platform).toBe('discord');
  });

  it('stops parsing at --help even with prior flags', () => {
    const result = parseOnboardCommand('/onboard --platform discord --help');
    expect(result.showUsage).toBe(true);
  });
});

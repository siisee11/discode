import { config, saveConfig } from '../../config/index.js';
import { agentRegistry } from '../../agents/index.js';
import type { TuiCommandDeps } from './tui-command-handler.js';

export function handleConfigShow(append: (line: string) => void, deps: TuiCommandDeps): 'handled' {
  const keepChannelOnStop = deps.getKeepChannelOnStop();
  append(`keepChannel: ${keepChannelOnStop ? 'on' : 'off'}`);
  append(`defaultAgent: ${config.defaultAgentCli || '(auto)'}`);
  append(`defaultChannel: ${config.discord.channelId || '(auto)'}`);
  append('runtimeMode: pty-rust');
  append('Usage: /config keepChannel [on|off|toggle]');
  append('Usage: /config defaultAgent [agent|auto]');
  append('Usage: /config defaultChannel [channelId|auto]');
  append('Usage: /config runtimeMode [pty-rust]');
  return 'handled';
}

export function handleConfigSet(command: string, append: (line: string) => void, deps: TuiCommandDeps): 'handled' {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  const key = (parts[1] || '').toLowerCase();

  if (key === 'defaultagent' || key === 'default-agent') {
    return handleConfigDefaultAgent(parts, append);
  }
  if (key === 'defaultchannel' || key === 'default-channel' || key === 'channel') {
    return handleConfigDefaultChannel(parts, append);
  }
  if (key === 'runtimemode' || key === 'runtime-mode' || key === 'runtime') {
    return handleConfigRuntimeMode(parts, append);
  }
  if (key !== 'keepchannel' && key !== 'keep-channel') {
    append(`⚠️ Unknown config key: ${parts[1] || '(empty)'}`);
    append('Supported keys: keepChannel, defaultAgent, defaultChannel, runtimeMode');
    return 'handled';
  }

  return handleConfigKeepChannel(parts, append, deps);
}

function handleConfigDefaultAgent(parts: string[], append: (line: string) => void): 'handled' {
  const availableAgents = agentRegistry.getAll().map((agent) => agent.config.name).sort((a, b) => a.localeCompare(b));
  const value = (parts[2] || '').trim().toLowerCase();

  if (!value) {
    append(`defaultAgent: ${config.defaultAgentCli || '(auto)'}`);
    append(`Available: ${availableAgents.join(', ')}`);
    append('Use: /config defaultAgent [agent|auto]');
    return 'handled';
  }

  if (value === 'auto' || value === 'clear' || value === 'unset') {
    try {
      saveConfig({ defaultAgentCli: undefined });
      append('✅ defaultAgent is now auto (first installed agent).');
    } catch (error) {
      append(`⚠️ Failed to persist config: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 'handled';
  }

  const selected = agentRegistry.get(value);
  if (!selected) {
    append(`⚠️ Unknown agent: ${value}`);
    append(`Available: ${availableAgents.join(', ')}`);
    return 'handled';
  }

  try {
    saveConfig({ defaultAgentCli: selected.config.name });
    append(`✅ defaultAgent is now ${selected.config.name}`);
  } catch (error) {
    append(`⚠️ Failed to persist config: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 'handled';
}

function handleConfigDefaultChannel(parts: string[], append: (line: string) => void): 'handled' {
  const value = (parts[2] || '').trim();
  const lowered = value.toLowerCase();
  if (!value) {
    append(`defaultChannel: ${config.discord.channelId || '(auto)'}`);
    append('Use: /config defaultChannel [channelId|auto]');
    return 'handled';
  }

  if (lowered === 'auto' || lowered === 'clear' || lowered === 'unset') {
    try {
      saveConfig({ channelId: undefined });
      append('✅ defaultChannel is now auto (per-project channel).');
    } catch (error) {
      append(`⚠️ Failed to persist config: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 'handled';
  }

  const normalized = value.replace(/^<#(\d+)>$/, '$1');
  try {
    saveConfig({ channelId: normalized });
    append(`✅ defaultChannel is now ${normalized}`);
  } catch (error) {
    append(`⚠️ Failed to persist config: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 'handled';
}

function handleConfigRuntimeMode(parts: string[], append: (line: string) => void): 'handled' {
  const value = (parts[2] || '').trim().toLowerCase();

  if (!value) {
    append('runtimeMode: pty-rust');
    append('Use: /config runtimeMode [pty-rust]');
    return 'handled';
  }

  if (value !== 'pty-rust') {
    append(`⚠️ Unknown runtime mode: ${parts[2]}`);
    append('Use pty-rust');
    return 'handled';
  }

  try {
    saveConfig({ runtimeMode: 'pty-rust' });
    append('✅ runtimeMode is now pty-rust');
  } catch (error) {
    append(`⚠️ Failed to persist config: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 'handled';
}

function handleConfigKeepChannel(parts: string[], append: (line: string) => void, deps: TuiCommandDeps): 'handled' {
  let keepChannelOnStop = deps.getKeepChannelOnStop();
  const modeRaw = (parts[2] || 'toggle').toLowerCase();
  if (modeRaw === 'on' || modeRaw === 'true' || modeRaw === '1') {
    keepChannelOnStop = true;
  } else if (modeRaw === 'off' || modeRaw === 'false' || modeRaw === '0') {
    keepChannelOnStop = false;
  } else if (modeRaw === 'toggle') {
    keepChannelOnStop = !keepChannelOnStop;
  } else {
    append(`⚠️ Unknown mode: ${parts[2]}`);
    append('Use on, off, or toggle');
    return 'handled';
  }

  deps.setKeepChannelOnStop(keepChannelOnStop);

  try {
    saveConfig({ keepChannelOnStop });
  } catch (error) {
    append(`⚠️ Failed to persist config: ${error instanceof Error ? error.message : String(error)}`);
  }

  append(`✅ keepChannel is now ${keepChannelOnStop ? 'on' : 'off'}`);
  append(
    keepChannelOnStop
      ? 'stop will preserve Discord channels.'
      : 'stop will delete Discord channels (default).',
  );
  return 'handled';
}

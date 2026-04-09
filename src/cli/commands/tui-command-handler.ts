import { basename } from 'path';
import { config, validateConfig } from '../../config/index.js';
import { stateManager } from '../../state/index.js';
import { agentRegistry } from '../../agents/index.js';
import { listProjectInstances } from '../../state/instances.js';
import type { BridgeConfig } from '../../types/index.js';
import type { TmuxCliOptions } from '../common/types.js';
import { parseNewCommand, parseOnboardCommand } from '../common/tui-command-parsers.js';
import type { RuntimeSessionManager } from '../common/runtime-session-manager.js';
import { handleConfigShow, handleConfigSet } from './tui-config-commands.js';
import { newCommand } from './new.js';
import { stopCommand } from './stop.js';
import { onboardCommand } from './onboard.js';

export type TuiCommandDeps = {
  session: RuntimeSessionManager;
  options: TmuxCliOptions;
  effectiveConfig: BridgeConfig;
  getKeepChannelOnStop: () => boolean;
  setKeepChannelOnStop: (value: boolean) => void;
  nextProjectName: (baseName: string) => string;
  reloadStateFromDisk: () => void;
};

const DISCODE_SUBCOMMANDS = new Set([
  'new',
  'onboard',
  'list',
  'projects',
  'config',
  'stop',
  'help',
  'exit',
  'quit',
]);

function normalizeCommand(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith('discode ')) return raw;
  const rest = trimmed.slice('discode '.length).trim();
  if (!rest) return raw;
  const first = rest.split(/\s+/, 1)[0]?.toLowerCase() || '';
  if (!DISCODE_SUBCOMMANDS.has(first)) return raw;
  return `/${rest}`;
}

export async function handleTuiCommand(
  command: string,
  append: (line: string) => void,
  deps: TuiCommandDeps,
): Promise<'exit' | 'handled'> {
  const trimmedCommand = command.trim();
  const normalizedCommand = normalizeCommand(trimmedCommand);
  const { session } = deps;

  if (normalizedCommand === '/exit' || normalizedCommand === '/quit') {
    append('Exiting TUI...');
    return 'exit';
  }

  if (normalizedCommand === '/help') {
    append('Commands: /new [name] [agent] [--path dir] [--instance id] [--attach], /onboard [options], /list, /projects, /config [keepChannel [on|off|toggle] | defaultAgent [agent|auto] | defaultChannel [channelId|auto] | runtimeMode [pty-rust]], /help, /exit');
    append('Onboard options: --platform [discord|slack], --runtime-mode [pty-rust], --token, --slack-bot-token, --slack-app-token, --default-agent [name|auto], --telemetry [on|off], --opencode-permission [allow|default]');
    return 'handled';
  }

  if (
    normalizedCommand === '/onboard' ||
    normalizedCommand.startsWith('/onboard ') ||
    trimmedCommand === 'onboard' ||
    trimmedCommand.startsWith('onboard ')
  ) {
    const onboardCommand = normalizedCommand.startsWith('/onboard') ? normalizedCommand : trimmedCommand;
    return handleOnboard(onboardCommand, append);
  }

  if (normalizedCommand === '/config' || trimmedCommand === 'config') {
    return handleConfigShow(append, deps);
  }

  if (normalizedCommand.startsWith('/config ') || trimmedCommand.startsWith('config ')) {
    const configCommand = normalizedCommand.startsWith('/config ') ? normalizedCommand : trimmedCommand;
    return handleConfigSet(configCommand, append, deps);
  }

  if (normalizedCommand === '/list') {
    return handleList(append, deps);
  }

  if (normalizedCommand === '/projects') {
    return handleProjects(append, deps);
  }

  if (normalizedCommand === '/stop' || trimmedCommand === 'stop') {
    append('Use stop dialog to choose a project.');
    return 'handled';
  }

  if (normalizedCommand.startsWith('/stop ') || trimmedCommand.startsWith('stop ')) {
    const stopCommand = normalizedCommand.startsWith('/stop ') ? normalizedCommand : trimmedCommand;
    return handleStop(stopCommand, append, deps);
  }

  if (normalizedCommand.startsWith('/new')) {
    return handleNew(normalizedCommand, append, deps);
  }

  if (session.isSupported() !== false) {
    const windowsCache = session.getWindowsCache();
    const focusedWindowId = windowsCache?.activeWindowId;
    if (focusedWindowId) {
      await session.requireConnected('command input');
      session.sendInput(focusedWindowId, Buffer.from(`${command}\r`, 'utf8'));
      append(`→ sent to ${focusedWindowId}`);
      return 'handled';
    }
  }

  append(`Unknown command: ${command}`);
  append('Try /help (or focus a runtime window to send direct input)');
  return 'handled';
}

async function handleOnboard(command: string, append: (line: string) => void): Promise<'handled'> {
  const parsed = parseOnboardCommand(command);
  if (parsed.showUsage) {
    append('Usage: /onboard [discord|slack] [--platform discord|slack] [--runtime-mode pty-rust]');
    append('       [--token TOKEN] [--slack-bot-token TOKEN] [--slack-app-token TOKEN]');
    append('       [--default-agent claude|gemini|opencode|auto] [--telemetry on|off]');
    append('       [--opencode-permission allow|default]');
    append('Discord bot token guide: https://discode.chat/docs/discord-bot');
    append('TUI onboard runs in non-interactive mode and uses saved values when omitted.');
    return 'handled';
  }
  if (parsed.error) {
    append(`⚠️ ${parsed.error}`);
    append('Try: /onboard --help');
    return 'handled';
  }

  try {
    append('Running onboarding inside TUI...');
    await onboardCommand({
      ...parsed.options,
      nonInteractive: true,
      exitOnError: false,
    });
    append('✅ Onboarding complete.');
  } catch (error) {
    append(`⚠️ Onboarding failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 'handled';
}

async function handleList(append: (line: string) => void, deps: TuiCommandDeps): Promise<'handled'> {
  deps.reloadStateFromDisk();
  const runtimeWindows = await deps.session.fetchWindows();
  if (runtimeWindows && runtimeWindows.windows.length > 0) {
    const sessions = new Map<string, number>();
    for (const window of runtimeWindows.windows) {
      sessions.set(window.sessionName, (sessions.get(window.sessionName) || 0) + 1);
    }
    [...sessions.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([sessionName, count]) => {
        append(`[session] ${sessionName} (${count} windows)`);
      });
    return 'handled';
  }

  append('No running sessions.');
  return 'handled';
}

async function handleProjects(append: (line: string) => void, deps: TuiCommandDeps): Promise<'handled'> {
  deps.reloadStateFromDisk();
  const projects = stateManager.listProjects();
  if (projects.length === 0) {
    append('No projects configured.');
    return 'handled';
  }
  projects.forEach((project) => {
    const instances = listProjectInstances(project);
    const label = instances.length > 0
      ? instances.map((instance) => `${instance.agentType}#${instance.instanceId}`).join(', ')
      : 'none';
    append(`[project] ${project.projectName} (${label})`);
  });
  return 'handled';
}

async function handleStop(command: string, append: (line: string) => void, deps: TuiCommandDeps): Promise<'handled'> {
  const args = command.replace(/^\/?stop\s+/, '').trim().split(/\s+/).filter(Boolean);
  let projectName = '';
  let instanceId: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--instance' && args[i + 1]) {
      instanceId = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--instance=')) {
      const value = arg.slice('--instance='.length).trim();
      if (value) instanceId = value;
      continue;
    }
    if (arg.startsWith('--')) continue;
    if (!projectName) projectName = arg;
  }
  if (!projectName) {
    append('⚠️ Project name is required. Example: stop my-project --instance gemini-2');
    return 'handled';
  }
  await stopCommand(projectName, {
    instance: instanceId,
    keepChannel: deps.getKeepChannelOnStop(),
    tmuxSharedSessionName: deps.options.tmuxSharedSessionName,
  });
  append(`✅ Stopped ${instanceId ? `instance ${instanceId}` : 'project'}: ${projectName}`);
  return 'handled';
}

async function handleNew(command: string, append: (line: string) => void, deps: TuiCommandDeps): Promise<'handled'> {
  try {
    deps.reloadStateFromDisk();
    validateConfig();
    const workspaceId = typeof stateManager.getWorkspaceId === 'function'
      ? stateManager.getWorkspaceId()
      : stateManager.getGuildId();
    if (!workspaceId) {
      append('⚠️ Not set up yet. Run /onboard in TUI.');
      return 'handled';
    }

    const installed = agentRegistry.getAll().filter((agent) => agent.isInstalled());
    if (installed.length === 0) {
      append('⚠️ No agent CLIs found. Install one first (claude, gemini, opencode).');
      return 'handled';
    }

    const parsed = parseNewCommand(command);
    const cwdName = basename(parsed.projectPath || process.cwd()) || 'project';
    const projectName = parsed.projectName && parsed.projectName.trim().length > 0
      ? parsed.projectName.trim()
      : deps.nextProjectName(cwdName);

    const selected = parsed.agentName
      ? installed.find((agent) => agent.config.name === parsed.agentName)
      : installed.find((agent) => agent.config.name === config.defaultAgentCli) || installed[0];

    if (!selected) {
      append(`⚠️ Unknown agent '${parsed.agentName}'. Try claude, gemini, or opencode.`);
      return 'handled';
    }

    append(`Creating session '${projectName}' with ${selected.config.displayName}...`);
    await newCommand(selected.config.name, {
      name: projectName,
      instance: parsed.instanceId,
      attach: parsed.attach,
      cwd: parsed.projectPath,
      tmuxSharedSessionName: deps.options.tmuxSharedSessionName,
    });
    append(`✅ Session created: ${projectName}`);
    append(`[project] ${projectName} (${selected.config.name})`);
  } catch (error) {
    append(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
  }
  return 'handled';
}

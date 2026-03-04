import chalk from 'chalk';
import { agentRegistry } from '../../agents/index.js';
import { getConfigValue, saveConfig } from '../../config/index.js';
import { normalizeDiscordToken } from '../../config/token.js';
import { ensureOpencodePermissionChoice } from '../common/opencode-permission.js';
import { confirmYesNo, isInteractiveShell, prompt } from '../common/interactive.js';
import { printCliError } from '../common/error-guide.js';
import { ensureTelemetryInstallId } from '../../telemetry/index.js';
import { onboardDiscord } from './onboard-discord.js';
import { onboardSlack } from './onboard-slack.js';
import { parseRuntimeModeInput } from '../../runtime/mode.js';
import type { RuntimeMode } from '../../types/index.js';

type RegisteredAgentAdapter = ReturnType<typeof agentRegistry.getAll>[number];

async function chooseDefaultAgentCli(
  installedAgents: RegisteredAgentAdapter[],
  interactive: boolean = isInteractiveShell()
): Promise<string | undefined> {
  if (installedAgents.length === 0) {
    console.log(chalk.yellow('⚠️ No installed AI CLI detected. Install one of: claude, gemini, opencode.'));
    return undefined;
  }

  const configured = getConfigValue('defaultAgentCli');
  const configuredIndex = configured
    ? installedAgents.findIndex((agent) => agent.config.name === configured)
    : -1;
  const defaultIndex = configuredIndex >= 0 ? configuredIndex : 0;

  if (!interactive) {
    const selected = installedAgents[defaultIndex];
    console.log(chalk.yellow(`⚠️ Non-interactive shell: default AI CLI set to ${selected.config.name}.`));
    return selected.config.name;
  }

  console.log(chalk.white('\nChoose default AI CLI'));
  installedAgents.forEach((agent, index) => {
    const marker = index === defaultIndex ? ' (default)' : '';
    console.log(chalk.gray(`   ${index + 1}. ${agent.config.displayName} (${agent.config.name})${marker}`));
  });

  while (true) {
    const answer = await prompt(chalk.white(`\nSelect default AI CLI [1-${installedAgents.length}] (Enter = default): `));
    if (!answer) {
      return installedAgents[defaultIndex].config.name;
    }

    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < installedAgents.length) {
      return installedAgents[idx].config.name;
    }

    console.log(chalk.yellow('Please enter a valid number.'));
  }
}

async function choosePlatform(interactive: boolean = isInteractiveShell()): Promise<'discord' | 'slack'> {
  const configured = getConfigValue('messagingPlatform');
  if (!interactive) {
    const platform = configured || 'discord';
    console.log(chalk.yellow(`⚠️ Non-interactive shell: using platform ${platform}.`));
    return platform;
  }

  console.log(chalk.white('\nChoose messaging platform'));
  console.log(chalk.gray(`   1. Discord${configured === 'discord' || !configured ? ' (default)' : ''}`));
  console.log(chalk.gray(`   2. Slack${configured === 'slack' ? ' (default)' : ''}`));

  const answer = await prompt(chalk.white('\nSelect platform [1-2] (Enter = default): '));
  if (!answer) return configured || 'discord';
  if (answer === '2') return 'slack';
  return 'discord';
}

async function chooseRuntimeMode(
  explicitMode?: string,
  interactive: boolean = isInteractiveShell()
): Promise<RuntimeMode> {
  const parsedExplicit = parseRuntimeModeInput(explicitMode);
  if (parsedExplicit) {
    return parsedExplicit;
  }

  if (!interactive) {
    console.log(chalk.yellow('⚠️ Non-interactive shell: using runtime mode tmux.'));
    return 'tmux';
  }

  console.log(chalk.white('\nChoose runtime mode'));
  console.log(chalk.gray('   1. tmux (default)'));
  console.log(chalk.gray('   2. pty-rust'));

  while (true) {
    const answer = await prompt(chalk.white('\nSelect runtime mode [1-2] (Enter = default): '));
    if (!answer || answer === '1') return 'tmux';
    if (answer === '2') return 'pty-rust';
    console.log(chalk.yellow('Please enter a valid number.'));
  }
}

async function chooseTelemetryOptIn(interactive: boolean = isInteractiveShell()): Promise<boolean> {
  const configured = getConfigValue('telemetryEnabled');
  const defaultEnabled = configured === true;

  if (!interactive) {
    const enabled = configured === true;
    console.log(chalk.yellow(`⚠️ Non-interactive shell: telemetry ${enabled ? 'on' : 'off'}.`));
    return enabled;
  }

  console.log(chalk.white('\nAnonymous telemetry (optional)'));
  console.log(chalk.gray('   Sends only command usage metadata (command, success/failure, duration).'));
  console.log(chalk.gray('   Never sends bot tokens, prompts, paths, project names, or message contents.'));

  return confirmYesNo(chalk.white('Enable anonymous CLI telemetry? [y/N]: '), defaultEnabled);
}

export async function onboardCommand(options: {
  token?: string;
  platform?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  runtimeMode?: string;
  defaultAgentCli?: string;
  telemetryEnabled?: boolean;
  opencodePermissionMode?: 'allow' | 'default';
  nonInteractive?: boolean;
  exitOnError?: boolean;
}) {
  try {
    const interactive = options.nonInteractive ? false : isInteractiveShell();
    console.log(chalk.cyan('\n🚀 Discode Onboarding\n'));

    const platform = (options.platform as 'discord' | 'slack')
      || (interactive ? await choosePlatform(interactive) : await choosePlatform(false));
    saveConfig({ messagingPlatform: platform });
    console.log(chalk.green(`✅ Platform: ${platform}`));

    if (platform === 'slack') {
      const botToken = options.slackBotToken || (interactive ? undefined : getConfigValue('slackBotToken'));
      const appToken = options.slackAppToken || (interactive ? undefined : getConfigValue('slackAppToken'));
      await onboardSlack({ botToken, appToken }, interactive);
    } else {
      const token = options.token || (interactive ? undefined : normalizeDiscordToken(getConfigValue('token')));
      await onboardDiscord(token, interactive);
    }

    const runtimeMode = await chooseRuntimeMode(
      options.runtimeMode || (!interactive ? getConfigValue('runtimeMode') : undefined),
      interactive
    );
    saveConfig({ runtimeMode });
    console.log(chalk.green(`✅ Runtime mode saved: ${runtimeMode}`));

    const installedAgents = agentRegistry.getAll().filter((a) => a.isInstalled());
    let defaultAgentCli: string | undefined;
    if (typeof options.defaultAgentCli === 'string' && options.defaultAgentCli.trim().toLowerCase() === 'auto') {
      saveConfig({ defaultAgentCli: undefined });
      console.log(chalk.green('✅ Default AI CLI saved: auto'));
    } else if (typeof options.defaultAgentCli === 'string' && options.defaultAgentCli.trim().length > 0) {
      const requested = options.defaultAgentCli.trim().toLowerCase();
      const matched = installedAgents.find((agent) => agent.config.name === requested);
      if (!matched) {
        throw new Error(`Unknown or not-installed default agent: ${requested}`);
      }
      defaultAgentCli = matched.config.name;
    } else {
      defaultAgentCli = await chooseDefaultAgentCli(installedAgents, interactive);
    }

    if (defaultAgentCli) {
      saveConfig({ defaultAgentCli });
      console.log(chalk.green(`✅ Default AI CLI saved: ${defaultAgentCli}`));
    }

    if (options.opencodePermissionMode) {
      saveConfig({ opencodePermissionMode: options.opencodePermissionMode });
      console.log(chalk.green(`✅ OpenCode permission mode saved: ${options.opencodePermissionMode}`));
    } else if (interactive) {
      await ensureOpencodePermissionChoice({ shouldPrompt: true, forcePrompt: true });
    } else if (!getConfigValue('opencodePermissionMode')) {
      saveConfig({ opencodePermissionMode: 'default' });
      console.log(chalk.yellow('⚠️ Non-interactive shell: OpenCode permission mode set to default.'));
    }

    const telemetryEnabled = typeof options.telemetryEnabled === 'boolean'
      ? options.telemetryEnabled
      : await chooseTelemetryOptIn(interactive);
    saveConfig({ telemetryEnabled });
    if (telemetryEnabled) {
      const installId = ensureTelemetryInstallId();
      console.log(chalk.green('✅ Anonymous telemetry enabled'));
      if (installId) {
        console.log(chalk.gray(`   Install ID: ${installId.slice(0, 8)}...${installId.slice(-4)}`));
      }
    } else {
      console.log(chalk.green('✅ Anonymous telemetry disabled'));
    }

    console.log(chalk.cyan('\n✨ Onboarding complete!\n'));
    console.log(chalk.white('Next step:'));
    console.log(chalk.gray('   cd <your-project>'));
    console.log(chalk.gray('   discode new\n'));
  } catch (error) {
    if (options.exitOnError === false) {
      throw error;
    }
    printCliError(error, 'Onboarding failed');
    process.exit(1);
  }
}

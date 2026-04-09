import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, extname, resolve } from 'path';
import chalk from 'chalk';
import type { BridgeConfig } from '../../types/index.js';
import { TmuxManager } from '../../tmux/manager.js';
import { stateManager, type ProjectState } from '../../state/index.js';
import {
  getProjectRuntimeSession,
  listProjectAgentTypes,
  listProjectInstances,
  normalizeProjectState,
} from '../../state/instances.js';
import { escapeShellArg } from '../../infra/shell-escape.js';
import { resolveProjectWindowName, toSharedWindowName } from '../../policy/window-naming.js';
import type { TmuxCliOptions } from './types.js';

export { escapeShellArg, resolveProjectWindowName, toSharedWindowName };
export { terminateTmuxPaneProcesses, cleanupStaleDiscodeTuiProcesses } from './tmux-process-ops.js';

export function attachToTmux(sessionName: string, windowName?: string): void {
  const sessionTarget = sessionName;
  const windowTarget = windowName ? `${sessionName}:${windowName}` : undefined;
  const tmuxAction = process.env.TMUX ? 'switch-client' : 'attach-session';

  if (!windowTarget) {
    execSync(`tmux ${tmuxAction} -t ${escapeShellArg(sessionTarget)}`, { stdio: 'inherit' });
    return;
  }

  try {
    execSync(`tmux ${tmuxAction} -t ${escapeShellArg(windowTarget)}`, { stdio: 'inherit' });
  } catch {
    console.log(chalk.yellow(`⚠️ Window '${windowName}' not found, attaching to session '${sessionName}' instead.`));
    execSync(`tmux ${tmuxAction} -t ${escapeShellArg(sessionTarget)}`, { stdio: 'inherit' });
  }
}

function resolveBunCommand(): string {
  if ((process as { versions?: { bun?: string } }).versions?.bun && process.execPath) {
    return process.execPath;
  }

  try {
    const output = execSync('command -v bun', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
    if (output.length > 0) return output;
  } catch {
    // Fallback to PATH lookup at execution time.
  }

  return 'bun';
}

export function ensureTmuxInstalled(): void {
  if (process.platform === 'win32') {
    console.error(chalk.red('tmux is required but not available on native Windows.'));
    console.log(chalk.gray('Use WSL, or run on macOS/Linux with tmux installed.'));
    process.exit(1);
  }

  try {
    execSync('tmux -V', { stdio: ['ignore', 'pipe', 'ignore'] });
    return;
  } catch {
    console.error(chalk.red('tmux is required but not installed (or not in PATH).'));
    console.log(chalk.gray('Install tmux and retry:'));
    if (process.platform === 'darwin') {
      console.log(chalk.gray('  brew install tmux'));
    } else {
      console.log(chalk.gray('  sudo apt-get install -y tmux   # Debian/Ubuntu'));
      console.log(chalk.gray('  sudo dnf install -y tmux       # Fedora/RHEL'));
    }
    process.exit(1);
  }
}

export function applyTmuxCliOverrides(base: BridgeConfig, options: TmuxCliOptions): BridgeConfig {
  const baseDiscord = base.discord;
  const baseTmux = base.tmux;
  const baseHookPort = base.hookServerPort;
  const baseDefaultAgentCli = base.defaultAgentCli;
  const baseOpencode = base.opencode;
  const baseRuntimeMode = base.runtimeMode;

  const sharedNameRaw = options?.tmuxSharedSessionName as string | undefined;

  return {
    discord: baseDiscord,
    ...(base.slack ? { slack: base.slack } : {}),
    ...(base.messagingPlatform ? { messagingPlatform: base.messagingPlatform } : {}),
    ...(baseRuntimeMode ? { runtimeMode: baseRuntimeMode } : {}),
    hookServerPort: baseHookPort,
    defaultAgentCli: baseDefaultAgentCli,
    opencode: baseOpencode,
    tmux: {
      ...baseTmux,
      ...(sharedNameRaw !== undefined ? { sharedSessionName: sharedNameRaw } : {}),
    },
  };
}

export function getEnabledAgentNames(project?: ProjectState): string[] {
  if (!project) return [];
  return listProjectAgentTypes(normalizeProjectState(project));
}

export function pruneStaleProjects(tmux: TmuxManager, tmuxConfig: BridgeConfig['tmux']): string[] {
  const removed: string[] = [];
  for (const project of stateManager.listProjects()) {
    const instances = listProjectInstances(project);
    if (instances.length === 0) {
      stateManager.removeProject(project.projectName);
      removed.push(project.projectName);
      continue;
    }

    const sessionName = getProjectRuntimeSession(project);
    if (!sessionName) {
      stateManager.removeProject(project.projectName);
      removed.push(project.projectName);
      continue;
    }

    const sessionUp = tmux.sessionExistsFull(sessionName);
    const hasLiveWindow = sessionUp && instances.some((instance) => {
      const windowName = resolveProjectWindowName(project, instance.agentType, tmuxConfig, instance.instanceId);
      return tmux.windowExists(sessionName, windowName);
    });
    if (hasLiveWindow) continue;

    stateManager.removeProject(project.projectName);
    removed.push(project.projectName);
  }
  return removed;
}

export function isTmuxPaneAlive(paneTarget?: string): boolean {
  if (!paneTarget || paneTarget.trim().length === 0) return false;
  try {
    execSync(`tmux display-message -p -t ${escapeShellArg(paneTarget)} "#{pane_id}"`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export async function waitForTmuxPaneAlive(paneTarget: string, timeoutMs: number = 1200, intervalMs: number = 100): Promise<boolean> {
  if (!paneTarget || paneTarget.trim().length === 0) return false;
  if (isTmuxPaneAlive(paneTarget)) return true;

  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (isTmuxPaneAlive(paneTarget)) return true;
  }
  return false;
}

export function ensureProjectTuiPane(
  tmux: TmuxManager,
  sessionName: string,
  windowName: string,
  options: TmuxCliOptions,
): void {
  const argvRunner = process.argv[1] ? resolve(process.argv[1]) : undefined;
  const bunCommand = resolveBunCommand();
  const scriptRunnerExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']);
  let commandParts: string[] | undefined;

  if (argvRunner && existsSync(argvRunner)) {
    const runnerExt = extname(argvRunner).toLowerCase();
    if (scriptRunnerExtensions.has(runnerExt)) {
      commandParts = [bunCommand, argvRunner, 'tui'];
    } else {
      const runnerDir = dirname(argvRunner);
      const sourceRunner = resolve(runnerDir, 'discode.ts');
      const distRunner = resolve(runnerDir, '../dist/bin/discode.js');
      if (existsSync(sourceRunner)) {
        commandParts = [bunCommand, sourceRunner, 'tui'];
      } else if (existsSync(distRunner)) {
        commandParts = [bunCommand, distRunner, 'tui'];
      } else {
        commandParts = [argvRunner, 'tui'];
      }
    }
  }

  if (!commandParts) {
    const fallbackRunners = [
      resolve(import.meta.dirname, '../../../dist/bin/discode.js'),
      resolve(import.meta.dirname, '../../../bin/discode.ts'),
      resolve(import.meta.dirname, '../../../bin/discode.js'),
    ];
    const fallbackRunner = fallbackRunners.find((runner) => existsSync(runner));
    commandParts = fallbackRunner ? [bunCommand, fallbackRunner, 'tui'] : [process.execPath, 'tui'];
  }

  if (options.tmuxSharedSessionName) {
    commandParts.push('--tmux-shared-session-name', options.tmuxSharedSessionName);
  }
  const primaryWindowName = '0';
  if (!tmux.windowExists(sessionName, primaryWindowName) && windowName !== primaryWindowName) {
    tmux.ensureWindowAtIndex(sessionName, 0);
  }

  try {
    tmux.ensureTuiPane(sessionName, primaryWindowName, commandParts);
    return;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const missingWindowZero = /can't find window:\s*0\b/.test(errorMessage);
    if (!missingWindowZero || windowName === primaryWindowName) {
      throw error;
    }
  }

  tmux.ensureTuiPane(sessionName, windowName, commandParts);
}

import { basename } from 'path';
import chalk from 'chalk';
import { stateManager } from '../../state/index.js';
import { config } from '../../config/index.js';
import { TmuxManager } from '../../tmux/manager.js';
import { listProjectInstances, getProjectInstance } from '../../state/instances.js';
import type { TmuxCliOptions } from '../common/types.js';
import {
  applyTmuxCliOverrides,
  attachToTmux,
  ensureTmuxInstalled,
  resolveProjectWindowName,
} from '../common/tmux.js';
import { ensureRuntimeWindow, focusRuntimeWindow } from '../common/runtime-api.js';
import { isPtyRuntimeMode } from '../../runtime/mode.js';

const RUNTIME_FOCUS_RETRY_ATTEMPTS = 6;
const RUNTIME_FOCUS_RETRY_DELAY_MS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function focusRuntimeWindowWithRetry(params: {
  port: number;
  windowId: string;
  projectName: string;
  instanceId?: string;
  permissionAllow?: boolean;
}): Promise<boolean> {
  if (await focusRuntimeWindow(params.port, params.windowId)) {
    return true;
  }

  await ensureRuntimeWindow({
    port: params.port,
    projectName: params.projectName,
    instanceId: params.instanceId,
    permissionAllow: params.permissionAllow,
  });

  for (let attempt = 0; attempt < RUNTIME_FOCUS_RETRY_ATTEMPTS; attempt += 1) {
    if (await focusRuntimeWindow(params.port, params.windowId)) {
      return true;
    }
    if (attempt < RUNTIME_FOCUS_RETRY_ATTEMPTS - 1) {
      await sleep(RUNTIME_FOCUS_RETRY_DELAY_MS);
    }
  }

  return false;
}

export async function attachCommand(projectName: string | undefined, options: TmuxCliOptions & { instance?: string }) {
  const effectiveConfig = applyTmuxCliOverrides(config, options);
  const runtimeMode = effectiveConfig.runtimeMode || 'tmux';
  if (!isPtyRuntimeMode(runtimeMode)) {
    ensureTmuxInstalled();
  }
  const tmux = new TmuxManager(effectiveConfig.tmux.sessionPrefix);

  if (!projectName) {
    projectName = basename(process.cwd());
  }

  const project = stateManager.getProject(projectName);
  const sessionName = project?.tmuxSession || `${effectiveConfig.tmux.sessionPrefix}${projectName}`;
  const requestedInstanceId = options.instance?.trim();
  const instances = project ? listProjectInstances(project) : [];
  const firstInstance = project
    ? (
      (requestedInstanceId ? getProjectInstance(project, requestedInstanceId) : undefined) ||
      instances[0]
    )
    : undefined;
  if (project && requestedInstanceId && !firstInstance) {
    console.error(chalk.red(`Instance '${requestedInstanceId}' not found in project '${projectName}'.`));
    const hints = instances.map((instance) => instance.instanceId).join(', ');
    if (hints) {
      console.log(chalk.gray(`Available instances: ${hints}`));
    }
    process.exit(1);
  }
  if (project && !requestedInstanceId && instances.length > 1) {
    console.log(chalk.yellow(`⚠️ Multiple instances found. Attaching first instance '${firstInstance?.instanceId}'.`));
    console.log(chalk.gray('   Use --instance <id> to select a specific instance.'));
  }
  const windowName =
    project && firstInstance
      ? resolveProjectWindowName(project, firstInstance.agentType, effectiveConfig.tmux, firstInstance.instanceId)
      : undefined;
  const attachTarget = windowName ? `${sessionName}:${windowName}` : sessionName;

  if (isPtyRuntimeMode(runtimeMode)) {
    if (windowName) {
      const windowId = `${sessionName}:${windowName}`;
      const port = effectiveConfig.hookServerPort || 18470;
      const focused = await focusRuntimeWindowWithRetry({
        port,
        windowId,
        projectName,
        instanceId: requestedInstanceId || firstInstance?.instanceId,
        permissionAllow: effectiveConfig.opencode?.permissionMode === 'allow',
      });
      if (!focused) {
        console.log(chalk.yellow('⚠️ Could not focus runtime window. Opening TUI anyway.'));
      }
    }

    const { tuiCommand } = await import('./tui.js');
    await tuiCommand(options);
    return;
  }

  if (!tmux.sessionExistsFull(sessionName)) {
    console.error(chalk.red(`Session ${sessionName} not found`));
    console.log(chalk.gray('Available sessions:'));
    const sessions = tmux.listSessions();
    for (const s of sessions) {
      console.log(chalk.gray(`  - ${s.name}`));
    }
    process.exit(1);
  }

  console.log(chalk.cyan(`\n📺 Attaching to ${attachTarget}...\n`));
  attachToTmux(sessionName, windowName);
}

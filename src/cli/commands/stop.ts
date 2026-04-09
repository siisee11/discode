import { basename } from 'path';
import chalk from 'chalk';
import { stateManager } from '../../state/index.js';
import { config, getConfigValue } from '../../config/index.js';
import { getProjectInstance, getProjectRuntimeSession, listProjectInstances } from '../../state/instances.js';
import { deleteChannels } from '../../app/channel-service.js';
import { removeInstanceFromProjectState, removeProjectState } from '../../app/project-service.js';
import type { TmuxCliOptions } from '../common/types.js';
import {
  applyTmuxCliOverrides,
  cleanupStaleDiscodeTuiProcesses,
  resolveProjectWindowName,
} from '../common/tmux.js';
import { stopRuntimeWindow } from '../common/runtime-api.js';
import { removeContainer, stopContainer } from '../../container/index.js';
import { ContainerSync } from '../../container/sync.js';
import type { ProjectInstanceState } from '../../types/index.js';

function cleanupContainerInstance(instance: ProjectInstanceState, projectPath: string, socketPath?: string): void {
  if (!instance.containerMode || !instance.containerId) return;

  try {
    const sync = new ContainerSync({
      containerId: instance.containerId,
      projectPath,
      socketPath,
    });
    sync.finalSync();
  } catch (error) {
    console.log(chalk.yellow(`⚠️  Container file sync failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  const stopped = stopContainer(instance.containerId, socketPath);
  if (stopped) {
    console.log(chalk.green(`✅ Container stopped: ${instance.containerName || instance.containerId}`));
  }
  const removed = removeContainer(instance.containerId, socketPath);
  if (removed) {
    console.log(chalk.green(`✅ Container removed: ${instance.containerName || instance.containerId}`));
  }
}

async function deleteChannelsForInstances(instances: ProjectInstanceState[]): Promise<void> {
  const channelIds = instances
    .map((instance) => instance.channelId)
    .filter((channelId): channelId is string => !!channelId);
  if (channelIds.length === 0) return;

  try {
    const deleted = await deleteChannels(channelIds);
    for (const channelId of deleted) {
      console.log(chalk.green(`✅ Discord channel deleted: ${channelId}`));
    }
  } catch (error) {
    console.log(chalk.yellow(`⚠️  Could not delete Discord channel: ${error instanceof Error ? error.message : String(error)}`));
  }
}

export async function stopCommand(
  projectName: string | undefined,
  options: TmuxCliOptions & { keepChannel?: boolean; instance?: string },
) {
  if (!projectName) {
    projectName = basename(process.cwd());
  }

  console.log(chalk.cyan(`\n🛑 Stopping project: ${projectName}\n`));

  const project = stateManager.getProject(projectName);
  const effectiveConfig = applyTmuxCliOverrides(config, options);
  const requestedInstanceId = options.instance?.trim();
  const runtimePort = effectiveConfig.hookServerPort || 18470;
  const effectiveKeepChannel = options.keepChannel ?? getConfigValue('keepChannelOnStop') ?? false;
  const runtimeSession = project ? getProjectRuntimeSession(project) : undefined;

  if (project && requestedInstanceId) {
    const instance = getProjectInstance(project, requestedInstanceId);
    if (!instance) {
      const known = listProjectInstances(project).map((item) => item.instanceId).join(', ');
      console.error(chalk.red(`Instance '${requestedInstanceId}' not found in project '${projectName}'.`));
      if (known) {
        console.log(chalk.gray(`Available instances: ${known}`));
      }
      process.exit(1);
    }

    if (!runtimeSession) {
      console.log(chalk.yellow('⚠️ Project state is missing a runtime session; cleaning up persisted state only.'));
    } else {
      const windowName = resolveProjectWindowName(project, instance.agentType, effectiveConfig.tmux, instance.instanceId);
      const target = `${runtimeSession}:${windowName}`;
      const stopped = await stopRuntimeWindow(runtimePort, target);
      if (stopped) {
        console.log(chalk.green(`✅ runtime window stopped: ${target}`));
      } else {
        console.log(chalk.gray(`   runtime window ${target} not running`));
      }
    }

    cleanupContainerInstance(instance, project.projectPath, effectiveConfig.container?.socketPath);

    if (!effectiveKeepChannel && instance.channelId) {
      await deleteChannelsForInstances([instance]);
    } else if (effectiveKeepChannel && instance.channelId) {
      console.log(chalk.gray('   Channel preserved (keepChannelOnStop config)'));
    }

    const stateUpdate = removeInstanceFromProjectState(projectName, instance.instanceId);
    if (stateUpdate.removedProject) {
      console.log(chalk.green('✅ Project removed from state (last instance stopped)'));
    } else {
      console.log(chalk.green(`✅ Instance removed from state: ${instance.instanceId}`));
    }

    const staleTuiCount = cleanupStaleDiscodeTuiProcesses();
    if (staleTuiCount > 0) {
      console.log(chalk.yellow(`⚠️ Cleaned ${staleTuiCount} stale discode TUI process(es).`));
    }

    console.log(chalk.cyan('\n✨ Done\n'));
    return;
  }

  if (project) {
    const instances = listProjectInstances(project);

    if (!runtimeSession) {
      console.log(chalk.yellow('⚠️ Project state is missing a runtime session; cleaning up persisted state only.'));
    } else {
      for (const instance of instances) {
        const windowName = resolveProjectWindowName(project, instance.agentType, effectiveConfig.tmux, instance.instanceId);
        const target = `${runtimeSession}:${windowName}`;
        const stopped = await stopRuntimeWindow(runtimePort, target);
        if (stopped) {
          console.log(chalk.green(`✅ runtime window stopped: ${target}`));
        } else {
          console.log(chalk.gray(`   runtime window ${target} not running`));
        }
        cleanupContainerInstance(instance, project.projectPath, effectiveConfig.container?.socketPath);
      }
    }

    if (!effectiveKeepChannel) {
      await deleteChannelsForInstances(instances);
    } else if (instances.some((instance) => !!instance.channelId)) {
      console.log(chalk.gray('   Channels preserved (keepChannelOnStop config)'));
    }

    removeProjectState(projectName);
    console.log(chalk.green('✅ Project removed from state'));
  }

  const staleTuiCount = cleanupStaleDiscodeTuiProcesses();
  if (staleTuiCount > 0) {
    console.log(chalk.yellow(`⚠️ Cleaned ${staleTuiCount} stale discode TUI process(es).`));
  }

  console.log(chalk.cyan('\n✨ Done\n'));
}

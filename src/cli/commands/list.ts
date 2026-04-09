import chalk from 'chalk';
import { stateManager } from '../../state/index.js';
import { config } from '../../config/index.js';
import { getProjectRuntimeSession, listProjectInstances } from '../../state/instances.js';
import { agentRegistry } from '../../agents/index.js';
import { resolveProjectWindowName } from '../common/tmux.js';
import { listRuntimeWindows } from '../common/runtime-api.js';

export async function listCommand(options?: { prune?: boolean }) {
  const projects = stateManager.listProjects();
  const runtimeWindows = await listRuntimeWindows(config.hookServerPort || 18470);
  const runtimeSet = new Set((runtimeWindows?.windows || []).map((window) => `${window.sessionName}:${window.windowName}`));
  const prune = !!options?.prune;

  if (projects.length === 0) {
    console.log(chalk.gray('No projects configured.'));
    return;
  }

  const pruned: string[] = [];
  console.log(chalk.cyan('\n📂 Configured Projects:\n'));
  for (const project of projects) {
    const sessionName = getProjectRuntimeSession(project);
    const instances = listProjectInstances(project);
    const labels = instances.map((instance) => {
      const agentLabel = agentRegistry.get(instance.agentType)?.config.displayName || instance.agentType;
      return `${agentLabel}#${instance.instanceId}`;
    });
    const windows = instances.map((instance) => ({
      instanceId: instance.instanceId,
      agentName: instance.agentType,
      windowName: resolveProjectWindowName(project, instance.agentType, config.tmux, instance.instanceId),
    }));
    const runningWindows = sessionName
      ? windows.filter((window) => runtimeSet.has(`${sessionName}:${window.windowName}`))
      : [];
    const sessionUp = runningWindows.length > 0;
    const status = runningWindows.length > 0 ? 'running' : sessionUp ? 'session only' : 'stale';

    if (prune && status !== 'running') {
      stateManager.removeProject(project.projectName);
      pruned.push(project.projectName);
      continue;
    }

    console.log(chalk.white(`  • ${project.projectName}`));
    console.log(chalk.gray(`    Instances: ${labels.length > 0 ? labels.join(', ') : 'none'}`));
    console.log(chalk.gray(`    Path: ${project.projectPath}`));
    console.log(chalk.gray(`    Status: ${status}`));
    if (windows.length > 0) {
      for (const window of windows) {
        console.log(chalk.gray(`    pty-rust(${window.instanceId}): ${(sessionName || '(missing-session)')}:${window.windowName}`));
      }
    }
  }

  if (prune) {
    if (pruned.length > 0) {
      console.log(chalk.green(`\n✅ Pruned ${pruned.length} project(s): ${pruned.join(', ')}`));
    } else {
      console.log(chalk.gray('\nNo stale projects to prune.'));
    }
  }
  console.log('');
}

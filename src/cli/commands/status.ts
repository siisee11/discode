import chalk from 'chalk';
import { stateManager } from '../../state/index.js';
import { config, getConfigPath } from '../../config/index.js';
import { getProjectRuntimeSession, listProjectInstances } from '../../state/instances.js';
import { agentRegistry } from '../../agents/index.js';
import type { TmuxCliOptions } from '../common/types.js';
import { applyTmuxCliOverrides, resolveProjectWindowName } from '../common/tmux.js';
import { listRuntimeWindows } from '../common/runtime-api.js';

export async function statusCommand(options: TmuxCliOptions) {
  const effectiveConfig = applyTmuxCliOverrides(config, options);
  const projects = stateManager.listProjects();
  const runtimeWindows = await listRuntimeWindows(effectiveConfig.hookServerPort || 18470);
  const runtimeSet = new Set((runtimeWindows?.windows || []).map((window) => `${window.sessionName}:${window.windowName}`));

  console.log(chalk.cyan('\n📊 Discode Status\n'));

  console.log(chalk.white('Configuration:'));
  console.log(chalk.gray(`   Config file: ${getConfigPath()}`));
  console.log(chalk.gray(`   Server ID: ${stateManager.getGuildId() || '(not configured)'}`));
  console.log(chalk.gray(`   Token: ${config.discord.token ? '****' + config.discord.token.slice(-4) : '(not set)'}`));
  console.log(chalk.gray(`   Hook Port: ${config.hookServerPort || 18470}`));
  console.log(chalk.gray('   Runtime Backend: pty-rust'));

  console.log(chalk.cyan('\n🤖 Registered Agents:\n'));
  for (const adapter of agentRegistry.getAll()) {
    console.log(chalk.gray(`   ${adapter.config.displayName} (${adapter.config.command})`));
  }

  console.log(chalk.cyan('\n📂 Projects:\n'));

  if (projects.length === 0) {
    console.log(chalk.gray('   No projects configured. Run `discode new` in a project directory.'));
  } else {
    for (const project of projects) {
      const sessionName = getProjectRuntimeSession(project);
      const instances = listProjectInstances(project);
      const sessionActive = instances.some((instance) => {
        const windowName = resolveProjectWindowName(project, instance.agentType, effectiveConfig.tmux, instance.instanceId);
        return !!sessionName && runtimeSet.has(`${sessionName}:${windowName}`);
      });
      const status = sessionActive ? chalk.green('● active') : chalk.gray('○ inactive');

      console.log(chalk.white(`   ${project.projectName}`), status);
      console.log(chalk.gray(`     Path: ${project.projectPath}`));

      const labels = instances.map((instance) => {
        const agentLabel = agentRegistry.get(instance.agentType)?.config.displayName || instance.agentType;
        return `${agentLabel}#${instance.instanceId}`;
      });
      console.log(chalk.gray(`     Instances: ${labels.length > 0 ? labels.join(', ') : 'none'}`));
      console.log('');
    }
  }

  console.log(chalk.cyan('📺 Runtime Windows:\n'));
  if (runtimeWindows?.windows.length) {
    for (const window of runtimeWindows.windows) {
      console.log(chalk.white(`   ${window.sessionName}:${window.windowName}`), chalk.gray(`(${window.status || 'running'})`));
    }
  } else {
    console.log(chalk.gray('   No active runtime windows'));
  }
  console.log('');
}

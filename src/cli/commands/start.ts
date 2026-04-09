import chalk from 'chalk';
import { AgentBridge } from '../../index.js';
import { stateManager } from '../../state/index.js';
import { config, getConfigPath, validateConfig } from '../../config/index.js';
import { agentRegistry } from '../../agents/index.js';
import { getProjectRuntimeSession, listProjectInstances } from '../../state/instances.js';
import type { TmuxCliOptions } from '../common/types.js';
import { applyTmuxCliOverrides, resolveProjectWindowName } from '../common/tmux.js';
import { printCliError } from '../common/error-guide.js';

export async function startCommand(options: TmuxCliOptions & { project?: string; attach?: boolean }) {
  try {
    validateConfig();
    const effectiveConfig = applyTmuxCliOverrides(config, options);

    const projects = stateManager.listProjects();

    if (projects.length === 0) {
      console.log(chalk.yellow('⚠️  No projects configured.'));
      console.log(chalk.gray('   Run `discode new` in a project directory first.'));
      process.exit(1);
    }

    const activeProjects = options.project
      ? projects.filter((p) => p.projectName === options.project)
      : projects;

    if (activeProjects.length === 0) {
      console.log(chalk.red(`Project "${options.project}" not found.`));
      process.exit(1);
    }

    if (options.attach && !options.project) {
      console.log(chalk.red('--attach requires --project option'));
      console.log(chalk.gray('Example: discode start -p myproject --attach'));
      process.exit(1);
    }

    console.log(chalk.cyan('\n🚀 Starting Discode\n'));
    console.log(chalk.white('Configuration:'));
    console.log(chalk.gray(`   Config file: ${getConfigPath()}`));
    console.log(chalk.gray(`   Server ID: ${stateManager.getGuildId()}`));
    console.log(chalk.gray(`   Hook port: ${config.hookServerPort || 18470}`));

    console.log(chalk.white('\nProjects to bridge:'));
    for (const project of activeProjects) {
      const instances = listProjectInstances(project);
      const labels = instances.map((instance) => {
        const adapter = agentRegistry.get(instance.agentType);
        const display = adapter?.config.displayName || instance.agentType;
        return `${display}#${instance.instanceId}`;
      });

      console.log(chalk.green(`   ✓ ${project.projectName}`));
      console.log(chalk.gray(`     Instances: ${labels.length > 0 ? labels.join(', ') : 'none'}`));
      console.log(chalk.gray(`     Path: ${project.projectPath}`));
    }
    console.log('');

    const bridge = new AgentBridge({ config: effectiveConfig });

    if (options.attach) {
      const project = activeProjects[0];
      const sessionName = getProjectRuntimeSession(project);
      if (!sessionName) {
        throw new Error(`Project '${project.projectName}' is missing a runtime session.`);
      }
      const firstInstance = listProjectInstances(project)[0];
      const windowName = firstInstance
        ? resolveProjectWindowName(project, firstInstance.agentType, effectiveConfig.tmux, firstInstance.instanceId)
        : undefined;
      const attachTarget = windowName ? `${sessionName}:${windowName}` : sessionName;

      await bridge.start();
      console.log(chalk.cyan(`\n🧭 Runtime window ready: ${attachTarget}`));
      console.log(chalk.cyan('📺 Opening runtime UI...\n'));
      const { tuiCommand } = await import('./tui.js');
      await tuiCommand(options);
      return;
    }

    await bridge.start();
  } catch (error) {
    printCliError(error, 'Error starting bridge');
    process.exit(1);
  }
}

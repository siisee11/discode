/**
 * Window restoration logic — restoring runtime windows on daemon restart.
 */

import type { AgentRuntime } from '../runtime/interface.js';
import type { IStateManager } from '../types/interfaces.js';
import type { BridgeConfig } from '../types/index.js';
import type { AgentRegistry } from '../agents/index.js';
import type { ClaudeSdkRunner } from '../sdk/index.js';
import { installAgentIntegration } from '../policy/agent-integration.js';
import { buildAgentLaunchEnv, buildExportPrefix, readHookToken } from '../policy/agent-launch.js';
import { resolveProjectWindowName } from '../policy/window-naming.js';
import { buildDockerStartCommand } from '../container/index.js';
import { ContainerSync } from '../container/sync.js';
import {
  getProjectRuntimeSession,
  listProjectInstances,
  normalizeProjectState,
} from '../state/instances.js';

export interface WindowRestorerDeps {
  runtime: AgentRuntime;
  stateManager: IStateManager;
  registry: AgentRegistry;
  bridgeConfig: BridgeConfig;
  containerSyncs: Map<string, ContainerSync>;
  createSdkRunner: (
    projectName: string,
    instanceId: string,
    agentType: string,
    projectPath: string,
    options?: { model?: string; permissionAllow?: boolean },
  ) => ClaudeSdkRunner;
}

export function restoreRuntimeWindowsIfNeeded(deps: WindowRestorerDeps): void {
  const port = deps.bridgeConfig.hookServerPort || 18470;
  const permissionAllow = deps.bridgeConfig.opencode?.permissionMode === 'allow';
  const socketPath = deps.bridgeConfig.container?.socketPath || undefined;

  for (const raw of deps.stateManager.listProjects()) {
    const project = normalizeProjectState(raw);
    const runtimeSession = getProjectRuntimeSession(project);
    if (!runtimeSession) continue;
    deps.runtime.setSessionEnv(runtimeSession, 'DISCODE_PORT', String(port));

    for (const instance of listProjectInstances(project)) {
      const adapter = deps.registry.get(instance.agentType);
      if (!adapter) continue;

      if (instance.runtimeType === 'sdk') {
        deps.createSdkRunner(
          project.projectName,
          instance.instanceId,
          instance.agentType,
          project.projectPath,
          { permissionAllow },
        );
        console.log(`🔄 Restored SDK runner for ${project.projectName}#${instance.instanceId}`);
        continue;
      }

      const windowName = resolveProjectWindowName(
        project,
        instance.agentType,
        deps.bridgeConfig.tmux,
        instance.instanceId,
      );

      if (deps.runtime.windowExists(runtimeSession, windowName)) continue;

      if (instance.containerMode && instance.containerId) {
        restoreContainerInstance(deps, project, runtimeSession, { ...instance, containerId: instance.containerId }, windowName, socketPath);
        continue;
      }

      restoreStandardInstance(deps, project, runtimeSession, instance, windowName, port, permissionAllow, adapter);
    }
  }
}

function restoreContainerInstance(
  deps: WindowRestorerDeps,
  project: ReturnType<typeof normalizeProjectState>,
  runtimeSession: string,
  instance: { instanceId: string; containerId: string },
  windowName: string,
  socketPath: string | undefined,
): void {
  const dockerStartCmd = buildDockerStartCommand(instance.containerId, socketPath);
  deps.runtime.startAgentInWindow(runtimeSession, windowName, dockerStartCmd);

  const sync = new ContainerSync({
    containerId: instance.containerId,
    projectPath: project.projectPath,
    socketPath,
    intervalMs: deps.bridgeConfig.container?.syncIntervalMs,
  });
  sync.start();
  deps.containerSyncs.set(`${project.projectName}#${instance.instanceId}`, sync);
}

function restoreStandardInstance(
  deps: WindowRestorerDeps,
  project: ReturnType<typeof normalizeProjectState>,
  runtimeSession: string,
  instance: { instanceId: string; agentType: string },
  windowName: string,
  port: number,
  permissionAllow: boolean,
  adapter: { getStartCommand(path: string, permAllow: boolean): string } & import('../agents/base.js').BaseAgentAdapter,
): void {
  const integration = installAgentIntegration(instance.agentType, project.projectPath, 'reinstall');
  const startCommand = adapter.buildLaunchCommand(
    adapter.getStartCommand(project.projectPath, permissionAllow),
    integration,
  );
  const extraEnv = adapter.getExtraEnvVars({ permissionAllow });
  const exportPrefix = buildExportPrefix({
    ...buildAgentLaunchEnv({
      projectName: project.projectName,
      port,
      agentType: instance.agentType,
      instanceId: instance.instanceId,
      hookToken: readHookToken(),
    }),
    ...extraEnv,
  });

  deps.runtime.startAgentInWindow(runtimeSession, windowName, `${exportPrefix}${startCommand}`);
}

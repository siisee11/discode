/**
 * Project setup logic — creating new project instances (container or standard).
 */

import type { MessagingClient } from '../messaging/interface.js';
import type { AgentRuntime } from '../runtime/interface.js';
import type { IStateManager } from '../types/interfaces.js';
import type { ProjectAgents, BridgeConfig } from '../types/index.js';
import type { AgentRegistry, AgentIntegrationResult, BaseAgentAdapter } from '../agents/index.js';
import {
  buildNextInstanceId,
  getProjectInstance,
  normalizeProjectState,
} from '../state/instances.js';
import { installFileInstruction } from '../infra/file-instruction.js';
import { installDiscodeSendScript } from '../infra/send-script.js';
import { buildAgentLaunchEnv, buildContainerEnv, buildExportPrefix, readHookToken } from '../policy/agent-launch.js';
import { installAgentIntegration } from '../policy/agent-integration.js';
import { sanitizePath } from '../infra/log-sanitizer.js';
import { toProjectScopedName } from '../policy/window-naming.js';
import {
  isDockerAvailable,
  createContainer,
  buildDockerStartCommand,
  injectCredentials,
  injectChromeMcpBridge,
  WORKSPACE_DIR,
} from '../container/index.js';
import { ContainerSync } from '../container/sync.js';

export interface ProjectSetupDeps {
  messaging: MessagingClient;
  runtime: AgentRuntime;
  stateManager: IStateManager;
  registry: AgentRegistry;
  bridgeConfig: BridgeConfig;
  containerSyncs: Map<string, ContainerSync>;
}

interface SetupParams {
  agentName: string;
  projectName: string;
  projectPath: string;
  instanceId: string;
  runtimeSession: string;
  windowName: string;
  port: number;
  permissionAllow: boolean;
  integration: AgentIntegrationResult;
  adapter: BaseAgentAdapter;
  skipRuntimeStart?: boolean;
}

export async function setupProject(
  deps: ProjectSetupDeps,
  projectName: string,
  projectPath: string,
  agents: ProjectAgents,
  channelDisplayName?: string,
  overridePort?: number,
  options?: { instanceId?: string; skipRuntimeStart?: boolean },
): Promise<{ channelName: string; channelId: string; agentName: string; runtimeSession: string }> {
  const isSlack = deps.bridgeConfig.messagingPlatform === 'slack';
  const guildId = isSlack ? deps.stateManager.getWorkspaceId() : deps.stateManager.getGuildId();
  if (!guildId) {
    throw new Error('Server ID not configured. Run: discode config --server <id>');
  }

  const enabledAgents = deps.registry.getAll().filter(a => agents[a.config.name]);
  const adapter = enabledAgents[0];
  if (!adapter) {
    throw new Error('No agent specified');
  }

  const existingProject = deps.stateManager.getProject(projectName);
  const normalizedExisting = existingProject ? normalizeProjectState(existingProject) : undefined;

  const requestedInstanceId = options?.instanceId?.trim();
  const instanceId = requestedInstanceId || buildNextInstanceId(normalizedExisting, adapter.config.name);
  if (normalizedExisting && getProjectInstance(normalizedExisting, instanceId)) {
    throw new Error(`Instance already exists: ${instanceId}`);
  }

  const sharedSessionName = deps.bridgeConfig.tmux.sharedSessionName || 'bridge';
  const windowName = toProjectScopedName(projectName, adapter.config.name, instanceId);
  const runtimeSession = deps.runtime.getOrCreateSession(sharedSessionName, windowName);

  const channelName = channelDisplayName || toProjectScopedName(projectName, adapter.config.channelSuffix, instanceId);
  const channels = await deps.messaging.createAgentChannels(
    guildId,
    projectName,
    [adapter.config],
    channelName,
    { [adapter.config.name]: instanceId },
  );

  const channelId = channels[adapter.config.name];
  const port = overridePort || deps.bridgeConfig.hookServerPort || 18470;
  deps.runtime.setSessionEnv(runtimeSession, 'DISCODE_PORT', String(port));

  const permissionAllow = deps.bridgeConfig.opencode?.permissionMode === 'allow';
  const integration = installAgentIntegration(adapter.config.name, projectPath, 'install');
  for (const message of integration.infoMessages) console.log(sanitizePath(message));
  for (const message of integration.warningMessages) console.warn(sanitizePath(message));

  try {
    installFileInstruction(projectPath, adapter.config.name);
    console.log(`📎 Installed file instructions for ${adapter.config.displayName}`);
  } catch (error) {
    console.warn(`Failed to install file instructions: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    installDiscodeSendScript(projectPath, { projectName, port });
  } catch {
    // Non-critical.
  }

  const setupParams: SetupParams = {
    agentName: adapter.config.name,
    projectName,
    projectPath,
    instanceId,
    runtimeSession,
    windowName,
    port,
    permissionAllow,
    integration,
    adapter,
    skipRuntimeStart: options?.skipRuntimeStart,
  };

  const containerMode = !!deps.bridgeConfig.container?.enabled;
  let containerId: string | undefined;
  let containerName: string | undefined;

  if (containerMode) {
    const result = setupContainerInstance(deps, setupParams);
    containerId = result.containerId;
    containerName = result.containerName;
  } else {
    setupStandardInstance(deps, setupParams);
  }

  saveProjectState(deps.stateManager, {
    normalizedExisting,
    projectName,
    projectPath,
    runtimeSession,
    instanceId,
    agentName: adapter.config.name,
    windowName,
    channelId,
    eventHookInstalled: integration.eventHookInstalled,
    containerMode,
    containerId,
    containerName,
  });

  return {
    channelName,
    channelId,
    agentName: adapter.config.displayName,
    runtimeSession,
  };
}

function setupContainerInstance(
  deps: ProjectSetupDeps,
  p: SetupParams,
): { containerId: string; containerName: string } {
  const socketPath = deps.bridgeConfig.container?.socketPath || undefined;
  if (!isDockerAvailable(socketPath)) {
    throw new Error('Container mode is enabled but Docker is not available. Is Docker running?');
  }

  const containerName = `discode-${p.projectName}-${p.instanceId}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
  const extraEnv = p.adapter.getExtraEnvVars({ permissionAllow: p.permissionAllow });
  const containerEnv = {
    ...buildContainerEnv({
      projectName: p.projectName,
      port: p.port,
      agentType: p.agentName,
      instanceId: p.instanceId,
      hookToken: readHookToken(),
    }),
    ...extraEnv,
  };

  const containerAgentCmd = p.adapter.getStartCommand(WORKSPACE_DIR, p.permissionAllow);
  const containerPluginDir = '/home/coder/.claude/plugins/discode-claude-bridge';
  const agentCommand = p.adapter.buildLaunchCommand(
    containerAgentCmd,
    p.integration.claudePluginDir ? { ...p.integration, claudePluginDir: containerPluginDir } : p.integration,
  );

  const volumes: string[] = [];
  if (p.integration.claudePluginDir) {
    volumes.push(`${p.integration.claudePluginDir}:${containerPluginDir}:ro`);
  }

  const containerId = createContainer({
    containerName,
    projectPath: p.projectPath,
    agentType: p.agentName,
    socketPath,
    env: containerEnv,
    command: agentCommand,
    volumes,
  });

  injectCredentials(containerId, socketPath);

  const chromeMcpPort = (deps.bridgeConfig.hookServerPort || 18470) + 1;
  if (injectChromeMcpBridge(containerId, chromeMcpPort, p.agentName, socketPath)) {
    console.log('🌐 Injected Chrome MCP bridge into container');
  }

  // Delegate agent-specific container injection to the adapter
  p.adapter.injectContainerPlugins(containerId, socketPath);

  const dockerStartCmd = buildDockerStartCommand(containerId, socketPath);
  if (!p.skipRuntimeStart) {
    deps.runtime.startAgentInWindow(p.runtimeSession, p.windowName, dockerStartCmd);
  }

  const sync = new ContainerSync({
    containerId,
    projectPath: p.projectPath,
    socketPath,
    intervalMs: deps.bridgeConfig.container?.syncIntervalMs,
  });
  sync.start();
  deps.containerSyncs.set(`${p.projectName}#${p.instanceId}`, sync);

  return { containerId, containerName };
}

function setupStandardInstance(deps: ProjectSetupDeps, p: SetupParams): void {
  const extraEnv = p.adapter.getExtraEnvVars({ permissionAllow: p.permissionAllow });
  const exportPrefix = buildExportPrefix({
    ...buildAgentLaunchEnv({
      projectName: p.projectName,
      port: p.port,
      agentType: p.agentName,
      instanceId: p.instanceId,
      hookToken: readHookToken(),
    }),
    ...extraEnv,
  });
  const startCommand = p.adapter.buildLaunchCommand(
    p.adapter.getStartCommand(p.projectPath, p.permissionAllow),
    p.integration,
  );

  if (!p.skipRuntimeStart) {
    deps.runtime.startAgentInWindow(p.runtimeSession, p.windowName, `${exportPrefix}${startCommand}`);
  }
}

function saveProjectState(
  stateManager: IStateManager,
  p: {
    normalizedExisting: ReturnType<typeof normalizeProjectState> | undefined;
    projectName: string;
    projectPath: string;
    runtimeSession: string;
    instanceId: string;
    agentName: string;
    windowName: string;
    channelId: string;
    eventHookInstalled: boolean;
    containerMode: boolean;
    containerId?: string;
    containerName?: string;
  },
): void {
  const baseProject = p.normalizedExisting || {
    projectName: p.projectName,
    projectPath: p.projectPath,
    runtimeSession: p.runtimeSession,
    createdAt: new Date(),
    lastActive: new Date(),
    agents: {},
    discordChannels: {},
    instances: {},
  };
  const nextInstances = {
    ...(baseProject.instances || {}),
    [p.instanceId]: {
      instanceId: p.instanceId,
      agentType: p.agentName,
      runtimeWindow: p.windowName,
      channelId: p.channelId,
      eventHook: p.agentName === 'opencode' || p.eventHookInstalled,
      ...(p.containerMode ? { containerMode: true, containerId: p.containerId, containerName: p.containerName } : {}),
    },
  };
  const projectState = normalizeProjectState({
    ...baseProject,
    projectName: p.projectName,
    projectPath: p.projectPath,
    runtimeSession: p.runtimeSession,
    instances: nextInstances,
    lastActive: new Date(),
  });
  stateManager.setProject(projectState);
}

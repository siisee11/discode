import type { ProjectInstanceState, ProjectState } from '../types/index.js';

function sortInstances(a: ProjectInstanceState, b: ProjectInstanceState): number {
  return a.instanceId.localeCompare(b.instanceId);
}

export function getProjectRuntimeSession(project: ProjectState): string | undefined {
  const runtimeSession = typeof project.runtimeSession === 'string' ? project.runtimeSession.trim() : '';
  return runtimeSession || undefined;
}

export function getProjectRuntimeWindows(project: ProjectState): Record<string, string | undefined> | undefined {
  return project.runtimeWindows;
}

export function getInstanceRuntimeWindow(instance: ProjectInstanceState | undefined): string | undefined {
  if (!instance) return undefined;
  const runtimeWindow = typeof instance.runtimeWindow === 'string' ? instance.runtimeWindow.trim() : '';
  return runtimeWindow || undefined;
}

function normalizeLegacyInstances(project: ProjectState): Record<string, ProjectInstanceState> {
  const keys = new Set<string>();
  const runtimeWindows = getProjectRuntimeWindows(project) || {};

  for (const [agentType, enabled] of Object.entries(project.agents || {})) {
    if (enabled) keys.add(agentType);
  }
  for (const agentType of Object.keys(project.discordChannels || {})) {
    if (project.agents?.[agentType] === false) continue;
    keys.add(agentType);
  }
  for (const agentType of Object.keys(runtimeWindows)) {
    if (project.agents?.[agentType] === false) continue;
    keys.add(agentType);
  }
  for (const agentType of Object.keys(project.eventHooks || {})) {
    if (project.agents?.[agentType] === false) continue;
    keys.add(agentType);
  }

  const instances: Record<string, ProjectInstanceState> = {};
  for (const agentType of keys) {
    if (!agentType || agentType.trim().length === 0) continue;
    const runtimeWindow = runtimeWindows[agentType];
    instances[agentType] = {
      instanceId: agentType,
      agentType,
      ...(runtimeWindow ? { runtimeWindow } : {}),
      channelId: project.discordChannels?.[agentType],
      eventHook: project.eventHooks?.[agentType],
    };
  }

  return instances;
}

function normalizeInstanceMap(project: ProjectState): Record<string, ProjectInstanceState> {
  const instances = project.instances || {};
  const normalized: Record<string, ProjectInstanceState> = {};

  for (const [rawKey, rawValue] of Object.entries(instances)) {
    if (!rawValue || typeof rawValue !== 'object') continue;

    const instanceId =
      typeof rawValue.instanceId === 'string' && rawValue.instanceId.trim().length > 0
        ? rawValue.instanceId
        : rawKey;
    if (!instanceId || instanceId.trim().length === 0) continue;

    const agentType = typeof rawValue.agentType === 'string' ? rawValue.agentType.trim() : '';
    if (!agentType) continue;

    const raw = rawValue as unknown as Record<string, unknown>;
    const rawChannelId = raw.channelId;
    const channelId = typeof rawChannelId === 'string' && rawChannelId.trim().length > 0
      ? rawChannelId
      : undefined;
    const rawRuntimeWindow = raw.runtimeWindow;
    const runtimeWindow = typeof rawRuntimeWindow === 'string' && rawRuntimeWindow.trim().length > 0
      ? rawRuntimeWindow
      : undefined;
    const rawRuntimeType = raw.runtimeType;
    const runtimeType =
      rawRuntimeType === 'sdk'
        ? 'sdk'
        : rawRuntimeType === 'pty-rust'
          ? 'pty-rust'
          : undefined;

    normalized[instanceId] = {
      instanceId,
      agentType,
      ...(runtimeWindow ? { runtimeWindow } : {}),
      channelId: channelId,
      eventHook: typeof rawValue.eventHook === 'boolean' ? rawValue.eventHook : undefined,
      ...(rawValue.containerMode ? { containerMode: true } : {}),
      ...(typeof rawValue.containerId === 'string' ? { containerId: rawValue.containerId } : {}),
      ...(typeof rawValue.containerName === 'string' ? { containerName: rawValue.containerName } : {}),
      ...(runtimeType ? { runtimeType } : {}),
      ...(typeof rawValue.sdkSessionId === 'string' ? { sdkSessionId: rawValue.sdkSessionId } : {}),
    };
  }

  if (Object.keys(normalized).length > 0) return normalized;
  return normalizeLegacyInstances(project);
}

function deriveLegacyMaps(instances: Record<string, ProjectInstanceState>): Pick<ProjectState, 'agents' | 'discordChannels' | 'runtimeWindows' | 'eventHooks'> {
  const sorted = Object.values(instances).sort(sortInstances);

  const agents: ProjectState['agents'] = {};
  const discordChannels: ProjectState['discordChannels'] = {};
  const runtimeWindows: NonNullable<NonNullable<ProjectState['runtimeWindows']>> = {};
  const eventHooks: NonNullable<ProjectState['eventHooks']> = {};

  for (const instance of sorted) {
    agents[instance.agentType] = true;
    const runtimeWindow = getInstanceRuntimeWindow(instance);

    if (instance.channelId && discordChannels[instance.agentType] === undefined) {
      discordChannels[instance.agentType] = instance.channelId;
    }
    if (runtimeWindow && runtimeWindows[instance.agentType] === undefined) {
      runtimeWindows[instance.agentType] = runtimeWindow;
    }
    if (typeof instance.eventHook === 'boolean' && eventHooks[instance.agentType] === undefined) {
      eventHooks[instance.agentType] = instance.eventHook;
    }
  }

  return {
    agents,
    discordChannels,
    runtimeWindows: Object.keys(runtimeWindows).length > 0 ? runtimeWindows : undefined,
    eventHooks: Object.keys(eventHooks).length > 0 ? eventHooks : undefined,
  };
}

export function normalizeProjectState(project: ProjectState): ProjectState {
  const instances = normalizeInstanceMap(project);
  const legacy = deriveLegacyMaps(instances);
  const runtimeSession = getProjectRuntimeSession(project);

  return {
    ...project,
    ...(runtimeSession ? { runtimeSession } : {}),
    instances,
    agents: legacy.agents,
    discordChannels: legacy.discordChannels,
    runtimeWindows: legacy.runtimeWindows,
    eventHooks: legacy.eventHooks,
  };
}

export function serializeProjectState(project: ProjectState): ProjectState {
  const normalized = normalizeProjectState(project);
  const projectRest = { ...normalized };

  const serializedInstances = Object.fromEntries(
    Object.entries(normalized.instances || {}).flatMap(([instanceId, instance]) => {
      if (!instance) return [];
      const instanceRest = { ...instance };
      const runtimeWindow = getInstanceRuntimeWindow(instance);
      const runtimeType = instance.runtimeType;
      return [[
        instanceId,
        {
          ...instanceRest,
          ...(runtimeWindow ? { runtimeWindow } : {}),
          ...(runtimeType ? { runtimeType } : {}),
        },
      ]];
    }),
  );

  return {
    ...projectRest,
    instances: serializedInstances,
    runtimeWindows: normalized.runtimeWindows,
  };
}

export function listProjectInstances(project: ProjectState): ProjectInstanceState[] {
  return Object.values(normalizeProjectState(project).instances || {})
    .filter((instance): instance is ProjectInstanceState => !!instance)
    .sort(sortInstances);
}

export function listProjectAgentTypes(project: ProjectState): string[] {
  return [...new Set(listProjectInstances(project).map((instance) => instance.agentType))];
}

export function getProjectInstance(project: ProjectState, instanceId: string): ProjectInstanceState | undefined {
  if (!instanceId) return undefined;
  return normalizeProjectState(project).instances?.[instanceId];
}

export function getPrimaryInstanceForAgent(project: ProjectState, agentType: string): ProjectInstanceState | undefined {
  return listProjectInstances(project).find((instance) => instance.agentType === agentType);
}

export function findProjectInstanceByChannel(project: ProjectState, channelId: string): ProjectInstanceState | undefined {
  if (!channelId) return undefined;
  return listProjectInstances(project).find(
    (instance) => instance.channelId === channelId,
  );
}

export function buildNextInstanceId(project: ProjectState | undefined, agentType: string): string {
  if (!project) return agentType;

  const taken = new Set(
    listProjectInstances(project)
      .filter((instance) => instance.agentType === agentType)
      .map((instance) => instance.instanceId),
  );

  if (!taken.has(agentType)) return agentType;

  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${agentType}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }

  return `${agentType}-${Date.now()}`;
}

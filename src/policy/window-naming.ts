import type { BridgeConfig, ProjectState } from '../types/index.js';
import {
  getPrimaryInstanceForAgent,
  getProjectInstance,
  getProjectRuntimeSession,
  getProjectRuntimeWindows,
  getInstanceRuntimeWindow,
  normalizeProjectState,
} from '../state/instances.js';

export function toSharedWindowName(projectName: string, token: string): string {
  const raw = `${projectName}-${token}`;
  const safe = raw
    .replace(/[:\n\r\t]/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return safe.length > 0 ? safe : token;
}

export function toProjectScopedName(projectName: string, base: string, instanceId: string): string {
  if (instanceId === base) return toSharedWindowName(projectName, base);
  if (instanceId.startsWith(`${base}-`)) return toSharedWindowName(projectName, instanceId);
  return toSharedWindowName(projectName, `${base}-${instanceId}`);
}

export function resolveProjectWindowName(
  project: ProjectState,
  agentName: string,
  tmuxConfig: BridgeConfig['tmux'],
  instanceId?: string,
): string {
  const normalized = normalizeProjectState(project);
  const explicitInstance = instanceId ? getProjectInstance(normalized, instanceId) : undefined;
  const primaryInstance = getPrimaryInstanceForAgent(normalized, agentName);
  const mapped =
    getInstanceRuntimeWindow(explicitInstance) ||
    getInstanceRuntimeWindow(primaryInstance) ||
    getProjectRuntimeWindows(project)?.[agentName];
  if (mapped && mapped.length > 0) return mapped;

  const sharedSession = `${tmuxConfig.sessionPrefix}${tmuxConfig.sharedSessionName || 'bridge'}`;
  if (getProjectRuntimeSession(project) === sharedSession) {
    const token = instanceId || agentName;
    return toSharedWindowName(project.projectName, token);
  }
  return instanceId || agentName;
}

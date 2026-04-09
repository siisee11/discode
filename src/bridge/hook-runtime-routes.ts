/**
 * Runtime control routes and file sending endpoint.
 */

import { existsSync, realpathSync } from 'fs';
import { resolve } from 'path';
import type { MessagingClient } from '../messaging/interface.js';
import type { IStateManager } from '../types/interfaces.js';
import type { AgentRuntime } from '../runtime/interface.js';
import { RuntimeControlPlane } from '../runtime/control-plane.js';
import { agentRegistry } from '../agents/index.js';
import { installAgentIntegration } from '../policy/agent-integration.js';
import { buildAgentLaunchEnv, buildExportPrefix, readHookToken } from '../policy/agent-launch.js';
import {
  getPrimaryInstanceForAgent,
  getProjectInstance,
  getProjectRuntimeSession,
  getInstanceRuntimeWindow,
  listProjectInstances,
  normalizeProjectState,
} from '../state/instances.js';

type StatusResult = { status: number; message: string };
type HttpRes = { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body: string) => void };

export interface RuntimeRoutesDeps {
  port: number;
  messaging: MessagingClient;
  stateManager: IStateManager;
  runtime?: AgentRuntime;
}

export class HookRuntimeRoutes {
  private runtimeControl: RuntimeControlPlane;

  constructor(private deps: RuntimeRoutesDeps) {
    this.runtimeControl = new RuntimeControlPlane(deps.runtime);
  }

  handleRuntimeWindows(res: HttpRes): void {
    if (!this.runtimeControl.isEnabled()) {
      this.writeJson(res, 501, { error: 'Runtime control unavailable' });
      return;
    }
    this.writeJson(res, 200, this.runtimeControl.listWindows());
  }

  handleRuntimeBuffer(res: HttpRes, windowId: string | undefined, since: number): void {
    if (!this.runtimeControl.isEnabled()) {
      this.writeJson(res, 501, { error: 'Runtime control unavailable' });
      return;
    }
    if (!windowId) {
      this.writeJson(res, 400, { error: 'Missing windowId' });
      return;
    }
    try {
      this.writeJson(res, 200, this.runtimeControl.getBuffer(windowId, since));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Window not found') || message.includes('Invalid windowId')) {
        this.writeJson(res, 404, { error: 'Window not found' });
        return;
      }
      console.error('Runtime buffer error:', error);
      this.writeJson(res, 400, { error: 'Runtime operation failed' });
    }
  }

  handleRuntimeFocus(payload: unknown): StatusResult {
    if (!this.runtimeControl.isEnabled()) return { status: 501, message: 'Runtime control unavailable' };
    if (!payload || typeof payload !== 'object') return { status: 400, message: 'Invalid payload' };

    const windowId = typeof (payload as Record<string, unknown>).windowId === 'string'
      ? ((payload as Record<string, unknown>).windowId as string)
      : undefined;
    if (!windowId) return { status: 400, message: 'Missing windowId' };

    return this.runtimeControl.focusWindow(windowId)
      ? { status: 200, message: 'OK' }
      : { status: 404, message: 'Window not found' };
  }

  handleRuntimeInput(payload: unknown): StatusResult {
    if (!this.runtimeControl.isEnabled()) return { status: 501, message: 'Runtime control unavailable' };
    if (!payload || typeof payload !== 'object') return { status: 400, message: 'Invalid payload' };

    const event = payload as Record<string, unknown>;
    const windowId = typeof event.windowId === 'string' ? event.windowId : undefined;
    const text = typeof event.text === 'string' ? event.text : undefined;
    const submit = typeof event.submit === 'boolean' ? event.submit : undefined;

    if (!windowId && !this.runtimeControl.getActiveWindowId()) return { status: 400, message: 'Missing windowId' };
    if (!text && submit === false) return { status: 400, message: 'No input to send' };

    try {
      this.runtimeControl.sendInput({ windowId, text, submit });
      return { status: 200, message: 'OK' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Window not found') || message.includes('Invalid windowId')) {
        return { status: 404, message: 'Window not found' };
      }
      console.error('Runtime input error:', error);
      return { status: 400, message: 'Runtime operation failed' };
    }
  }

  handleRuntimeStop(payload: unknown): StatusResult {
    if (!this.runtimeControl.isEnabled()) return { status: 501, message: 'Runtime control unavailable' };
    if (!payload || typeof payload !== 'object') return { status: 400, message: 'Invalid payload' };

    const windowId = typeof (payload as Record<string, unknown>).windowId === 'string'
      ? ((payload as Record<string, unknown>).windowId as string)
      : undefined;
    if (!windowId) return { status: 400, message: 'Missing windowId' };

    try {
      this.runtimeControl.stopWindow(windowId);
      return { status: 200, message: 'OK' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Window not found') || message.includes('Invalid windowId')) {
        return { status: 404, message: 'Window not found' };
      }
      if (message.includes('Runtime stop unavailable')) {
        return { status: 501, message: 'Runtime stop unavailable' };
      }
      console.error('Runtime stop error:', error);
      return { status: 400, message: 'Runtime operation failed' };
    }
  }

  handleRuntimeEnsure(payload: unknown): StatusResult {
    if (!this.deps.runtime) return { status: 501, message: 'Runtime control unavailable' };
    if (!payload || typeof payload !== 'object') return { status: 400, message: 'Invalid payload' };

    const input = payload as Record<string, unknown>;
    const projectName = typeof input.projectName === 'string' ? input.projectName : undefined;
    const instanceId = typeof input.instanceId === 'string' ? input.instanceId : undefined;
    const permissionAllow = input.permissionAllow === true;
    if (!projectName) return { status: 400, message: 'Missing projectName' };

    const existingProject = this.deps.stateManager.getProject(projectName);
    if (!existingProject) return { status: 404, message: 'Project not found' };

    const project = normalizeProjectState(existingProject);
    const instance = instanceId
      ? getProjectInstance(project, instanceId)
      : listProjectInstances(project)[0];
    if (!instance) return { status: 404, message: 'Instance not found' };

    const adapter = agentRegistry.get(instance.agentType);
    if (!adapter) return { status: 404, message: 'Agent adapter not found' };

    const windowName = getInstanceRuntimeWindow(instance);
    const sessionName = getProjectRuntimeSession(project);
    if (!windowName || !sessionName) return { status: 400, message: 'Invalid project state' };

    this.deps.runtime.setSessionEnv(sessionName, 'DISCODE_PORT', String(this.deps.port));
    if (this.deps.runtime.windowExists(sessionName, windowName)) {
      return { status: 200, message: 'OK' };
    }

    const integration = installAgentIntegration(instance.agentType, project.projectPath, 'reinstall');
    const startCommand = adapter.buildLaunchCommand(
      adapter.getStartCommand(project.projectPath, permissionAllow),
      integration,
    );
    const extraEnv = adapter.getExtraEnvVars({ permissionAllow });
    const envPrefix = buildExportPrefix({
      ...buildAgentLaunchEnv({
        projectName,
        port: this.deps.port,
        agentType: instance.agentType,
        instanceId: instance.instanceId,
        hookToken: readHookToken(),
      }),
      ...extraEnv,
    });

    this.deps.runtime.startAgentInWindow(sessionName, windowName, `${envPrefix}${startCommand}`);
    return { status: 200, message: 'OK' };
  }

  async handleSendFiles(payload: unknown): Promise<StatusResult> {
    if (!payload || typeof payload !== 'object') return { status: 400, message: 'Invalid payload' };

    const event = payload as Record<string, unknown>;
    const projectName = typeof event.projectName === 'string' ? event.projectName : undefined;
    const agentType = typeof event.agentType === 'string' ? event.agentType : 'opencode';
    const instanceId = typeof event.instanceId === 'string' ? event.instanceId : undefined;
    const files = Array.isArray(event.files) ? (event.files as unknown[]).filter((f): f is string => typeof f === 'string') : [];

    if (!projectName) return { status: 400, message: 'Missing projectName' };
    if (files.length === 0) return { status: 400, message: 'No files provided' };

    const project = this.deps.stateManager.getProject(projectName);
    if (!project) return { status: 404, message: 'Project not found' };

    const normalizedProject = normalizeProjectState(project);
    const instance =
      (instanceId ? getProjectInstance(normalizedProject, instanceId) : undefined) ||
      getPrimaryInstanceForAgent(normalizedProject, agentType);
    const channelId = instance?.channelId;
    if (!channelId) return { status: 404, message: 'No channel found for project/agent' };

    const projectPath = project.projectPath ? resolve(project.projectPath) : '';
    const validFiles = this.validateFilePaths(files, projectPath);
    if (validFiles.length === 0) return { status: 400, message: 'No valid files' };

    console.log(
      `\uD83D\uDCE4 [${projectName}/${instance?.agentType || agentType}] send-files: ${validFiles.length} file(s)`,
    );

    await this.deps.messaging.sendToChannelWithFiles(channelId, '', validFiles);
    return { status: 200, message: 'OK' };
  }

  private validateFilePaths(paths: string[], projectPath: string): string[] {
    if (!projectPath) return [];
    return paths.filter((p) => {
      if (!existsSync(p)) return false;
      try {
        const real = realpathSync(p);
        return real.startsWith(projectPath + '/') || real === projectPath;
      } catch {
        return false;
      }
    });
  }

  private writeJson(res: HttpRes, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }
}

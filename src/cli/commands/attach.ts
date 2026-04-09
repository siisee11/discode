import { basename } from 'path';
import chalk from 'chalk';
import { stateManager } from '../../state/index.js';
import { config } from '../../config/index.js';
import { getProjectRuntimeSession, listProjectInstances, getProjectInstance } from '../../state/instances.js';
import type { TmuxCliOptions } from '../common/types.js';
import { applyTmuxCliOverrides, resolveProjectWindowName } from '../common/tmux.js';
import { listRuntimeWindows, runtimeApiRequest } from '../common/runtime-api.js';
import { resolveNativeAttachMode, tryNativeAttach } from '../common/native-attach.js';

const RUNTIME_FOCUS_RETRY_ATTEMPTS = 6;
const RUNTIME_FOCUS_RETRY_DELAY_MS = 120;
const RUNTIME_TRACE_PREFIX = '[runtime-focus]';

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
  console.log(chalk.gray(
    `   ${RUNTIME_TRACE_PREFIX} target=${params.windowId} port=${params.port} project=${params.projectName} instance=${params.instanceId || '(auto)'}`,
  ));
  await logRuntimeWindowsSnapshot(params.port, 'before-focus', params.windowId);

  const firstFocus = await runtimePostTrace({
    port: params.port,
    path: '/runtime/focus',
    payload: { windowId: params.windowId },
  });
  logRuntimeTrace('focus[initial]', firstFocus);
  if (firstFocus.ok) {
    return true;
  }

  const ensureTrace = await runtimePostTrace({
    port: params.port,
    path: '/runtime/ensure',
    payload: {
      projectName: params.projectName,
      ...(params.instanceId ? { instanceId: params.instanceId } : {}),
      ...(params.permissionAllow ? { permissionAllow: true } : {}),
    },
  });
  logRuntimeTrace('ensure', ensureTrace);
  await logRuntimeWindowsSnapshot(params.port, 'after-ensure', params.windowId);

  for (let attempt = 0; attempt < RUNTIME_FOCUS_RETRY_ATTEMPTS; attempt += 1) {
    const focusTrace = await runtimePostTrace({
      port: params.port,
      path: '/runtime/focus',
      payload: { windowId: params.windowId },
    });
    logRuntimeTrace(`focus[retry-${attempt + 1}]`, focusTrace);
    if (focusTrace.ok) {
      return true;
    }
    await logRuntimeWindowsSnapshot(params.port, `after-focus-retry-${attempt + 1}`, params.windowId);
    if (attempt < RUNTIME_FOCUS_RETRY_ATTEMPTS - 1) {
      await sleep(RUNTIME_FOCUS_RETRY_DELAY_MS);
    }
  }

  return false;
}

type RuntimePostTrace = {
  ok: boolean;
  status: number;
  body: string;
  error?: string;
};

async function runtimePostTrace(params: {
  port: number;
  path: string;
  payload: unknown;
}): Promise<RuntimePostTrace> {
  try {
    const response = await runtimeApiRequest({
      port: params.port,
      method: 'POST',
      path: params.path,
      payload: params.payload,
    });
    return {
      ok: response.status === 200,
      status: response.status,
      body: response.body,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeRuntimeBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return '(empty)';
  if (trimmed.length <= 220) return trimmed;
  return `${trimmed.slice(0, 220)}...`;
}

function logRuntimeTrace(label: string, trace: RuntimePostTrace): void {
  const detail = `status=${trace.status} ok=${trace.ok} body=${JSON.stringify(summarizeRuntimeBody(trace.body))}`;
  if (trace.error) {
    console.log(chalk.gray(`   ${RUNTIME_TRACE_PREFIX} ${label}: ${detail} error=${trace.error}`));
    return;
  }
  console.log(chalk.gray(`   ${RUNTIME_TRACE_PREFIX} ${label}: ${detail}`));
}

async function logRuntimeWindowsSnapshot(port: number, label: string, targetWindowId: string): Promise<void> {
  const runtimeWindows = await listRuntimeWindows(port);
  if (!runtimeWindows) {
    console.log(chalk.gray(`   ${RUNTIME_TRACE_PREFIX} ${label}: /runtime/windows unavailable`));
    return;
  }

  const active = runtimeWindows.activeWindowId || '(none)';
  const targetPresent = runtimeWindows.windows.some((window) => window.windowId === targetWindowId);
  console.log(chalk.gray(
    `   ${RUNTIME_TRACE_PREFIX} ${label}: windows=${runtimeWindows.windows.length} active=${active} targetPresent=${targetPresent}`,
  ));
  for (const window of runtimeWindows.windows) {
    const marker = window.windowId === targetWindowId ? ' <- target' : '';
    console.log(chalk.gray(
      `   ${RUNTIME_TRACE_PREFIX} window=${window.windowId} status=${window.status || 'unknown'} pid=${window.pid ?? '-'}${marker}`,
    ));
  }
}

export async function attachCommand(projectName: string | undefined, options: TmuxCliOptions & { instance?: string }) {
  const effectiveConfig = applyTmuxCliOverrides(config, options);

  if (!projectName) {
    projectName = basename(process.cwd());
  }

  const project = stateManager.getProject(projectName);
  const sessionName = project
    ? getProjectRuntimeSession(project) || `${effectiveConfig.tmux.sessionPrefix}${projectName}`
    : `${effectiveConfig.tmux.sessionPrefix}${projectName}`;
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
  const nativeAttachMode = resolveNativeAttachMode();

  let runtimeWindowId: string | undefined;
  if (windowName) {
    const windowId = `${sessionName}:${windowName}`;
    runtimeWindowId = windowId;
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

  if (runtimeWindowId && tryNativeAttach(runtimeWindowId, nativeAttachMode, effectiveConfig.hookServerPort || 18470)) {
    return;
  }

  console.log(chalk.cyan(`\n📺 Opening runtime UI for ${attachTarget}...\n`));
  const { tuiCommand } = await import('./tui.js');
  await tuiCommand(options);
}

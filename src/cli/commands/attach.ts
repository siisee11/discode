import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { basename } from 'path';
import { resolve, join } from 'path';
import { createRequire } from 'module';
import chalk from 'chalk';
import { stateManager } from '../../state/index.js';
import { config } from '../../config/index.js';
import { TmuxManager } from '../../tmux/manager.js';
import { listProjectInstances, getProjectInstance } from '../../state/instances.js';
import type { TmuxCliOptions } from '../common/types.js';
import {
  applyTmuxCliOverrides,
  attachToTmux,
  ensureTmuxInstalled,
  resolveProjectWindowName,
} from '../common/tmux.js';
import { listRuntimeWindows, runtimeApiRequest } from '../common/runtime-api.js';
import { getDefaultRuntimeSocketPath } from '../common/runtime-stream-client.js';
import { isPtyRuntimeMode } from '../../runtime/mode.js';

const RUNTIME_FOCUS_RETRY_ATTEMPTS = 6;
const RUNTIME_FOCUS_RETRY_DELAY_MS = 120;
const RUNTIME_TRACE_PREFIX = '[runtime-focus]';
const NATIVE_ATTACH_FLAG_ENV = 'DISCODE_NATIVE_ATTACH';
const NATIVE_ATTACH_BIN_ENV = 'DISCODE_RUNTIME_CLIENT_BIN';
type NativeAttachMode = 'off' | 'on' | 'auto';
const requireForAttach = createRequire(import.meta.url);

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

function resolveNativeAttachMode(): NativeAttachMode {
  const raw = process.env[NATIVE_ATTACH_FLAG_ENV]?.trim().toLowerCase();
  if (!raw) return 'auto';
  if (raw === '0' || raw === 'false' || raw === 'off') return 'off';
  if (raw === 'auto') return 'auto';
  return 'on';
}

function mapPlatformTag(platform: NodeJS.Platform): 'darwin' | 'linux' | 'windows' | null {
  if (platform === 'darwin' || platform === 'linux') return platform;
  if (platform === 'win32') return 'windows';
  return null;
}

function mapArchTag(arch: string): 'x64' | 'arm64' | null {
  if (arch === 'x64' || arch === 'arm64') return arch;
  return null;
}

function resolveNativeAttachBinary(mode: NativeAttachMode): string | null {
  const explicit = process.env[NATIVE_ATTACH_BIN_ENV]?.trim();
  if (explicit) return explicit;

  const binaryName = process.platform === 'win32' ? 'discode-runtime-client.exe' : 'discode-runtime-client';
  const platformTag = mapPlatformTag(process.platform);
  const archTag = mapArchTag(process.arch);

  // Prefer npm package resolution first so globally installed builds can
  // discover runtime-client artifacts without relying on cwd-relative paths.
  if (platformTag && archTag) {
    try {
      const pkg = `@siisee11/discode-runtime-client-${platformTag}-${archTag}`;
      const packageJsonPath = requireForAttach.resolve(`${pkg}/package.json`);
      const packageDir = resolve(packageJsonPath, '..');
      const packageBinary = join(packageDir, 'bin', binaryName);
      if (existsSync(packageBinary)) return packageBinary;
    } catch {
      // Continue to filesystem hints.
    }
  }

  const rawHints = [
    process.env.DISCODE_REPO,
    process.cwd(),
    resolve(import.meta.dirname, '..'),
    resolve(import.meta.dirname, '..', '..'),
    resolve(import.meta.dirname, '..', '..', '..'),
    resolve(import.meta.dirname, '..', '..', '..', '..'),
  ].filter((value): value is string => !!value && value.length > 0);
  const repoHints = [...new Set(rawHints.map((value) => resolve(value)))];

  const candidates = [
    ...repoHints.map((root) => resolve(root, 'runtime-client-rs', 'target', 'release', binaryName)),
    ...(platformTag && archTag
      ? repoHints.map((root) =>
        resolve(
          root,
          'dist',
          'release',
          'runtime-client',
          `discode-runtime-client-${platformTag}-${archTag}`,
          'bin',
          binaryName,
        ))
      : []),
    ...(platformTag && archTag
      ? repoHints.map((root) =>
        resolve(
          root,
          'node_modules',
          `@siisee11/discode-runtime-client-${platformTag}-${archTag}`,
          'bin',
          binaryName,
        ))
      : []),
    resolve(homedir(), '.discode', 'bin', binaryName),
    ...(platformTag && archTag
      ? [join(homedir(), '.discode', 'bin', 'runtime-client', `${platformTag}-${archTag}`, binaryName)]
      : []),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // Explicitly enabled mode keeps PATH probing as a final fallback.
  if (mode === 'on') {
    return 'discode-runtime-client';
  }
  return null;
}

function tryNativeAttach(windowId: string, mode: NativeAttachMode, port: number): boolean {
  if (mode === 'off') return false;

  const binary = resolveNativeAttachBinary(mode);
  if (!binary) return false;

  const runtimeSocket = getDefaultRuntimeSocketPath();
  const result = spawnSync(
    binary,
    ['--socket', runtimeSocket, '--window-id', windowId, '--daemon-port', String(port)],
    { stdio: 'inherit' },
  );

  if (result.error) {
    if (mode === 'on') {
      const message = result.error instanceof Error ? result.error.message : String(result.error);
      console.log(chalk.yellow(`⚠️ Native attach unavailable (${message}); falling back to TUI.`));
    }
    return false;
  }

  if (result.status === 0) return true;
  if (mode === 'on') {
    console.log(chalk.yellow(`⚠️ Native attach exited with status ${result.status ?? 'unknown'}; falling back to TUI.`));
  }
  return false;
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
  const runtimeMode = effectiveConfig.runtimeMode || 'tmux';
  if (!isPtyRuntimeMode(runtimeMode)) {
    ensureTmuxInstalled();
  }
  const tmux = new TmuxManager(effectiveConfig.tmux.sessionPrefix);

  if (!projectName) {
    projectName = basename(process.cwd());
  }

  const project = stateManager.getProject(projectName);
  const sessionName = project?.tmuxSession || `${effectiveConfig.tmux.sessionPrefix}${projectName}`;
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

  if (isPtyRuntimeMode(runtimeMode)) {
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

    const { tuiCommand } = await import('./tui.js');
    await tuiCommand(options);
    return;
  }

  if (!tmux.sessionExistsFull(sessionName)) {
    console.error(chalk.red(`Session ${sessionName} not found`));
    console.log(chalk.gray('Available sessions:'));
    const sessions = tmux.listSessions();
    for (const s of sessions) {
      console.log(chalk.gray(`  - ${s.name}`));
    }
    process.exit(1);
  }

  console.log(chalk.cyan(`\n📺 Attaching to ${attachTarget}...\n`));
  attachToTmux(sessionName, windowName);
}

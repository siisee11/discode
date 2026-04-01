import { spawnSync } from 'child_process';
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { config, getConfigValue } from '../../config/index.js';
import { stateManager } from '../../state/index.js';
import { agentRegistry } from '../../agents/index.js';
import { TmuxManager } from '../../tmux/manager.js';
import { listProjectInstances } from '../../state/instances.js';
import {
  ensureDaemonRunning,
  getDaemonLogFilePath,
  getDaemonStatus,
  restartDaemonIfRunning,
} from '../../app/daemon-service.js';
import { isPtyRuntimeMode } from '../../runtime/mode.js';
import type { TmuxCliOptions } from '../common/types.js';
import {
  applyTmuxCliOverrides,
  getEnabledAgentNames,
  isTmuxPaneAlive,
  resolveProjectWindowName,
  waitForTmuxPaneAlive,
} from '../common/tmux.js';
import { RuntimeSessionManager } from '../common/runtime-session-manager.js';
import { getDefaultRuntimeSocketPath } from '../common/runtime-stream-client.js';
import { handleTuiCommand } from './tui-command-handler.js';
import { attachCommand } from './attach.js';
import { stopCommand } from './stop.js';

type RuntimeBackendStatus = 'sidecar';

function readFileTailUtf8(filePath: string, maxBytes: number = 65536): string {
  const stats = statSync(filePath);
  if (!Number.isFinite(stats.size) || stats.size <= 0) return '';

  const size = stats.size;
  const length = Math.max(0, Math.min(size, Math.floor(maxBytes)));
  if (length <= 0) return '';

  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const position = Math.max(0, size - length);
    const bytesRead = readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function detectPtyRustBackendStatus(logText: string): RuntimeBackendStatus | undefined {
  if (!logText) return undefined;
  const lines = logText.replace(/\r/g, '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.includes('pty-rust mode enabled (PoC); sidecar connected')) return 'sidecar';
    if (line.includes('pty-rust mode enabled; sidecar connected')) return 'sidecar';
  }
  return undefined;
}

function nextProjectName(baseName: string): string {
  if (!stateManager.getProject(baseName)) return baseName;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${baseName}-${i}`;
    if (!stateManager.getProject(candidate)) return candidate;
  }
  return `${baseName}-${Date.now()}`;
}

function reloadStateFromDisk(): void {
  stateManager.reload();
}

function isControlWindowName(windowName: string | undefined): boolean {
  if (!windowName) return false;
  const normalized = windowName.trim().toLowerCase();
  return normalized === '0' || normalized === 'discode-control' || normalized === 'discode-tui';
}

function summarizeRuntimeWindows(
  windows: Array<{ windowId: string; windowName: string }> | undefined,
  limit: number = 6,
): string {
  if (!windows || windows.length === 0) return '(none)';
  const listed = windows.slice(0, limit).map((window) => window.windowId);
  return windows.length > limit ? `${listed.join(', ')} ... (+${windows.length - limit})` : listed.join(', ');
}

function handoffToBunRuntime(): never {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error('TUI requires Bun runtime. Run with: bun dist/bin/discode.js');
  }

  const result = spawnSync('bun', [scriptPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DISCODE_TUI_BUN_HANDOFF: '1',
    },
  });

  if (result.error) {
    throw new Error('TUI requires Bun runtime and could not auto-run Bun. Ensure `bun` is on PATH.');
  }

  process.exit(typeof result.status === 'number' ? result.status : 1);
}

function resolveRuntimeWindowForProject(
  projectName: string,
  tmuxConfig: typeof config.tmux,
): { windowId: string; sessionName: string; windowName: string } | null {
  const project = stateManager.getProject(projectName);
  if (!project) return null;
  const instances = listProjectInstances(project);
  const firstInstance = instances[0];
  if (!firstInstance) return null;
  const windowName = resolveProjectWindowName(project, firstInstance.agentType, tmuxConfig, firstInstance.instanceId);
  return {
    windowId: `${project.tmuxSession}:${windowName}`,
    sessionName: project.tmuxSession,
    windowName,
  };
}

function isRuntimeStreamUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return message.includes('Runtime stream unavailable');
}

async function connectRuntimeSessionWithRecovery(session: RuntimeSessionManager): Promise<void> {
  let initialErrorMessage = 'Runtime stream unavailable.';
  try {
    await session.connect();
    return;
  } catch (error) {
    if (!isRuntimeStreamUnavailableError(error)) throw error;
    initialErrorMessage = error instanceof Error ? error.message : String(error);
  }

  let recoveryDetail = '';
  try {
    const daemonStatus = await getDaemonStatus();
    const runtimeSocketPath = getDefaultRuntimeSocketPath();
    const runtimeSocketExists = existsSync(runtimeSocketPath);

    if (!daemonStatus.running) {
      const started = await ensureDaemonRunning();
      recoveryDetail = started.ready
        ? `daemon started (${started.backend})`
        : `daemon start attempted but not ready (${started.backend})`;
    } else if (!runtimeSocketExists) {
      const restarted = await restartDaemonIfRunning();
      recoveryDetail = restarted.restarted
        ? `daemon restarted (${restarted.backend}, ready=${restarted.ready ? 'yes' : 'no'})`
        : `daemon restart attempt failed (${restarted.backend})`;
    } else {
      recoveryDetail = 'daemon is running and runtime socket exists; retrying stream connect';
    }
  } catch (recoveryError) {
    const detail = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
    throw new Error(`${initialErrorMessage} Automatic recovery failed before reconnect (${detail}).`);
  }

  await new Promise((resolve) => setTimeout(resolve, 350));
  try {
    await session.connect();
  } catch (retryError) {
    if (!isRuntimeStreamUnavailableError(retryError)) throw retryError;
    const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
    throw new Error(`${retryMessage} Automatic recovery result: ${recoveryDetail}.`);
  }
}

export async function tuiCommand(options: TmuxCliOptions): Promise<void> {
  const effectiveConfig = applyTmuxCliOverrides(config, options);
  const runtimePort = effectiveConfig.hookServerPort || 18470;
  const runtimeModeAtLaunch = effectiveConfig.runtimeMode || 'tmux';
  const runtimeSessionRequired = isPtyRuntimeMode(runtimeModeAtLaunch);
  let keepChannelOnStop = getConfigValue('keepChannelOnStop') === true;

  const session = new RuntimeSessionManager(runtimePort);
  if (runtimeSessionRequired) {
    await connectRuntimeSessionWithRecovery(session);
  }

  const isBunRuntime = Boolean((process as { versions?: { bun?: string } }).versions?.bun);
  if (!isBunRuntime) {
    if (process.env.DISCODE_TUI_BUN_HANDOFF === '1') {
      throw new Error('TUI requires Bun runtime. Run with: bun dist/bin/discode.js');
    }
    handoffToBunRuntime();
  }

  await import('@opentui/solid/preload');
  const tmuxPaneTarget = process.env.TMUX_PANE;
  const startedFromTmux = !!process.env.TMUX;
  if (startedFromTmux) {
    const paneReady = tmuxPaneTarget ? await waitForTmuxPaneAlive(tmuxPaneTarget) : false;
    if (!paneReady) {
      console.log(chalk.yellow('⚠️ Stale tmux environment detected; skipping TUI startup to avoid orphaned process.'));
      return;
    }
  }

  let tmuxHealthTimer: ReturnType<typeof setInterval> | undefined;
  if (startedFromTmux) {
    tmuxHealthTimer = setInterval(() => {
      if (isTmuxPaneAlive(tmuxPaneTarget)) return;
      console.log(chalk.yellow('\n⚠️ tmux session/pane ended; exiting TUI to prevent leaked process.'));
      process.exit(0);
    }, 5000);
    tmuxHealthTimer.unref();
  }

  const clearTmuxHealthTimer = () => {
    if (!tmuxHealthTimer) return;
    clearInterval(tmuxHealthTimer);
    tmuxHealthTimer = undefined;
  };
  process.once('exit', clearTmuxHealthTimer);

  const tmux = new TmuxManager(config.tmux.sessionPrefix);
  const runtimeAtStartup = await session.fetchWindows();
  const parseWindowId = (windowId: string | undefined): { windowId: string; sessionName: string; windowName: string } | null => {
    if (!windowId) return null;
    const idx = windowId.indexOf(':');
    if (idx <= 0 || idx >= windowId.length - 1) return null;
    return { windowId, sessionName: windowId.slice(0, idx), windowName: windowId.slice(idx + 1) };
  };
  const runtimeActiveAtStartup = parseWindowId(runtimeAtStartup?.activeWindowId);
  let runtimeInitialWindow = runtimeActiveAtStartup;
  const hadControlActiveAtStartup = runtimeInitialWindow ? isControlWindowName(runtimeInitialWindow.windowName) : false;
  if (runtimeAtStartup?.windows?.length) {
    if (!runtimeInitialWindow || isControlWindowName(runtimeInitialWindow.windowName)) {
      const nonControlWindow = runtimeAtStartup.windows.find((window) => !isControlWindowName(window.windowName));
      const selectedWindow = nonControlWindow || runtimeAtStartup.windows[0];
      runtimeInitialWindow = {
        windowId: selectedWindow.windowId,
        sessionName: selectedWindow.sessionName,
        windowName: selectedWindow.windowName,
      };
    }
  }
  if (runtimeAtStartup?.windows?.length) {
    const activeLabel = runtimeAtStartup.activeWindowId || '(none)';
    const selectedLabel = runtimeInitialWindow?.windowId || '(none)';
    const reason =
      !runtimeAtStartup.activeWindowId
        ? 'active missing'
        : hadControlActiveAtStartup
          ? 'active is control window'
          : activeLabel === selectedLabel
            ? 'active kept'
            : 'selected fallback window';
    console.log(chalk.gray(
      `   [tui-init] runtime windows=${runtimeAtStartup.windows.length} active=${activeLabel} selected=${selectedLabel} reason=${reason}`,
    ));
    console.log(chalk.gray(`   [tui-init] windows: ${summarizeRuntimeWindows(runtimeAtStartup.windows)}`));
  } else {
    console.log(chalk.gray('   [tui-init] runtime windows=(none)'));
  }
  if (runtimeInitialWindow && runtimeAtStartup?.activeWindowId !== runtimeInitialWindow.windowId) {
    const focused = await session.focusWindow(runtimeInitialWindow.windowId);
    console.log(chalk.gray(`   [tui-init] focus ${runtimeInitialWindow.windowId}: ${focused ? 'ok' : 'failed'}`));
  }
  const currentSession = runtimeInitialWindow?.sessionName || tmux.getCurrentSession(process.env.TMUX_PANE);
  const currentWindow = runtimeInitialWindow?.windowName || tmux.getCurrentWindow(process.env.TMUX_PANE);
  const daemonLogFile = getDaemonLogFilePath();
  let runtimeBackendCache: { mtimeMs: number; status: RuntimeBackendStatus | undefined } | undefined;

  const getRuntimeBackendStatus = async (): Promise<RuntimeBackendStatus | undefined> => {
    if (runtimeModeAtLaunch !== 'pty-rust') return undefined;
    if (!existsSync(daemonLogFile)) return undefined;

    const mtimeMs = statSync(daemonLogFile).mtimeMs;
    if (runtimeBackendCache && runtimeBackendCache.mtimeMs === mtimeMs) {
      return runtimeBackendCache.status;
    }

    const tail = readFileTailUtf8(daemonLogFile, 96 * 1024);
    const status = detectPtyRustBackendStatus(tail);
    runtimeBackendCache = { mtimeMs, status };
    return status;
  };

  const sourceCandidates = [
    new URL('./tui.js', import.meta.url),
    new URL('./tui.tsx', import.meta.url),
    new URL('../../bin/tui.tsx', import.meta.url),
    new URL('../../../dist/bin/tui.js', import.meta.url),
    new URL('../../../bin/tui.tsx', import.meta.url),
  ];
  let mod: any;
  let lastImportError: unknown;
  for (const candidate of sourceCandidates) {
    const candidatePath = fileURLToPath(candidate);
    if (!existsSync(candidatePath)) continue;
    try {
      const loaded = await import(candidate.href);
      if (loaded && typeof loaded.runTui === 'function') {
        mod = loaded;
        break;
      }
    } catch (error) {
      lastImportError = error;
    }
  }
  if (!mod) {
    clearTmuxHealthTimer();
    process.off('exit', clearTmuxHealthTimer);
    const suffix = lastImportError instanceof Error ? ` (last import error: ${lastImportError.message})` : '';
    throw new Error(`OpenTUI entry not found: bin/tui.tsx or dist/bin/tui.js${suffix}`);
  }

  try {
    await mod.runTui({
      currentSession: currentSession || undefined,
      currentWindow: currentWindow || undefined,
      runtimeMode: effectiveConfig.runtimeMode || 'tmux',
      getRuntimeBackendStatus,
      initialCommand: options.initialTuiCommand,
      onCommand: async (command: string, append: (line: string) => void): Promise<boolean> => {
        const result = await handleTuiCommand(command, append, {
          session,
          options,
          effectiveConfig,
          getKeepChannelOnStop: () => keepChannelOnStop,
          setKeepChannelOnStop: (value: boolean) => { keepChannelOnStop = value; },
          nextProjectName,
          reloadStateFromDisk,
        });
        return result === 'exit';
      },
      onAttachProject: async (project: string) => {
        reloadStateFromDisk();
        const runtimeTarget = resolveRuntimeWindowForProject(project, effectiveConfig.tmux);
        if (runtimeSessionRequired && runtimeTarget && session.isSupported() !== false) {
          const focused = await session.focusWindow(runtimeTarget.windowId);
          if (focused) {
            return {
              currentSession: runtimeTarget.sessionName,
              currentWindow: runtimeTarget.windowName,
            };
          }
        }
        if (isPtyRuntimeMode(effectiveConfig.runtimeMode || 'tmux')) {
          return runtimeTarget
            ? {
              currentSession: runtimeTarget.sessionName,
              currentWindow: runtimeTarget.windowName,
            }
            : undefined;
        }
        await attachCommand(project, {
          tmuxSharedSessionName: options.tmuxSharedSessionName,
        });
        if (!runtimeTarget) return;
        return {
          currentSession: runtimeTarget.sessionName,
          currentWindow: runtimeTarget.windowName,
        };
      },
      onStopProject: async (project: string) => {
        await stopCommand(project, {
          keepChannel: keepChannelOnStop,
          tmuxSharedSessionName: options.tmuxSharedSessionName,
        });
      },
      getProjects: async () => {
        reloadStateFromDisk();
        const runtimeWindows = await session.fetchWindows();
        const runtimeSet = new Set(
          (runtimeWindows?.windows || []).map((window) => `${window.sessionName}:${window.windowName}`),
        );

        return stateManager.listProjects().map((project) => {
          const instances = listProjectInstances(project);
          const agentNames = getEnabledAgentNames(project);
          const labels = agentNames.map((agentName) => agentRegistry.get(agentName)?.config.displayName || agentName);
          const primaryInstance = instances[0];
          const window = primaryInstance
            ? resolveProjectWindowName(project, primaryInstance.agentType, effectiveConfig.tmux, primaryInstance.instanceId)
            : '(none)';
          const channelCount = instances.filter((instance) => !!instance.channelId).length;
          const channelBase = channelCount > 0 ? `${channelCount} channel(s)` : 'not connected';
          const windowUp = runtimeWindows
            ? instances.some((instance) => {
              const name = resolveProjectWindowName(project, instance.agentType, effectiveConfig.tmux, instance.instanceId);
              return runtimeSet.has(`${project.tmuxSession}:${name}`);
            })
            : (() => {
              const sessionUp = tmux.sessionExistsFull(project.tmuxSession);
              return sessionUp && instances.some((instance) => {
                const name = resolveProjectWindowName(project, instance.agentType, effectiveConfig.tmux, instance.instanceId);
                return tmux.windowExists(project.tmuxSession, name);
              });
            })();

          return {
            project: project.projectName,
            session: project.tmuxSession,
            window,
            ai: labels.length > 0 ? labels.join(', ') : 'none',
            channel: channelBase,
            open: windowUp,
          };
        });
      },
      getCurrentWindowOutput: async (sessionName: string, windowName: string, width?: number, height?: number) => {
        return session.readWindowOutput(sessionName, windowName, width, height);
      },
      getDaemonLogs: async (maxLines?: number) => {
        const logFile = getDaemonLogFilePath();
        if (!existsSync(logFile)) {
          return [
            `No daemon log found: ${logFile}`,
            'Start daemon first: discode daemon start',
          ];
        }

        const cap = typeof maxLines === 'number' && Number.isFinite(maxLines)
          ? Math.max(50, Math.min(2000, Math.floor(maxLines)))
          : 500;
        const raw = readFileSync(logFile, 'utf8');
        const lines = raw
          .replace(/\r/g, '')
          .split('\n')
          .filter((line, index, arr) => !(index === arr.length - 1 && line.length === 0));
        return lines.slice(-cap);
      },
      onRuntimeKey: async (sessionName: string, windowName: string, raw: string) => {
        await session.sendRawKey(sessionName, windowName, raw);
      },
      onRuntimeResize: async (sessionName: string, windowName: string, width: number, height: number) => {
        await session.sendResize(sessionName, windowName, width, height);
      },
      onRuntimeFrame: (listener: (frame: {
        sessionName: string;
        windowName: string;
        output: string;
        styled?: import('../../runtime/vt-screen.js').TerminalStyledLine[];
        cursorRow?: number;
        cursorCol?: number;
        cursorVisible?: boolean;
      }) => void) => {
        return session.registerFrameListener(listener);
      },
      getRuntimeStatus: async () => {
        if (!runtimeSessionRequired) {
          return {
            mode: 'stream' as const,
            connected: false,
            detail: 'disabled for tmux runtime',
          };
        }
        await session.ensureConnected();
        return session.getTransportStatus();
      },
    });
  } finally {
    session.disconnect();
    clearTmuxHealthTimer();
    process.off('exit', clearTmuxHealthTimer);

    if (isPtyRuntimeMode(effectiveConfig.runtimeMode)) {
      console.log(chalk.cyan('\n📺 Opening terminal...\n'));
      const shell = process.env.SHELL || '/bin/bash';
      const { spawnSync } = await import('child_process');
      spawnSync(shell, [], { stdio: 'inherit' });
    } else if (startedFromTmux && currentSession) {
      console.log(chalk.cyan('\n📺 Returning to terminal...\n'));
      const { attachToTmux } = await import('../common/tmux.js');
      attachToTmux(currentSession, currentWindow || undefined);
    }
  }
}

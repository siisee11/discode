import { existsSync } from 'fs';
import chalk from 'chalk';
import { config } from '../../config/index.js';
import type { TmuxCliOptions } from '../common/types.js';
import { applyTmuxCliOverrides } from '../common/tmux.js';
import { RuntimeSessionManager } from '../common/runtime-session-manager.js';
import { getDefaultRuntimeSocketPath } from '../common/runtime-stream-client.js';
import { openRuntimeTerminal } from '../common/runtime-terminal-host.js';
import {
  ensureDaemonRunning,
  getDaemonStatus,
  restartDaemonIfRunning,
} from '../../app/daemon-service.js';

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

function parseWindowId(windowId: string | undefined): { windowId: string; sessionName: string; windowName: string } | null {
  if (!windowId) return null;
  const idx = windowId.indexOf(':');
  if (idx <= 0 || idx >= windowId.length - 1) return null;
  return { windowId, sessionName: windowId.slice(0, idx), windowName: windowId.slice(idx + 1) };
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
  const session = new RuntimeSessionManager(runtimePort);

  await connectRuntimeSessionWithRecovery(session);

  try {
    const runtimeAtStartup = await session.fetchWindows();
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

    if (!runtimeInitialWindow) {
      console.log(chalk.yellow('⚠️ No active runtime window found.'));
      console.log(chalk.gray('Start or attach a project first:'));
      console.log(chalk.gray('  discode attach <project>'));
      console.log(chalk.gray('  discode new <agent>'));
      return;
    }

    const launchResult = openRuntimeTerminal({
      windowId: runtimeInitialWindow.windowId,
      runtimePort,
    });
    if (launchResult.launched) {
      return;
    }

    console.log(chalk.red(`⚠️ Native runtime UI unavailable for ${runtimeInitialWindow.windowId}.`));
    console.log(chalk.gray('Build/package the Rust runtime client, or set DISCODE_RUNTIME_CLIENT_BIN to a valid binary.'));
  } finally {
    session.disconnect();
  }
}

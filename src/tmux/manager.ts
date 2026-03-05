/**
 * tmux session management
 */

import type { TmuxSession } from '../types/index.js';
import type { ICommandExecutor } from '../types/interfaces.js';
import { ShellCommandExecutor } from '../infra/shell.js';
import { escapeShellArg } from '../infra/shell-escape.js';
import { resolveWindowTarget } from './tmux-pane-resolver.js';
import { ensureTuiPane } from './tmux-tui-pane.js';

export class TmuxManager {
  private sessionPrefix: string;
  private executor: ICommandExecutor;

  constructor(sessionPrefix: string = '', executor?: ICommandExecutor) {
    this.sessionPrefix = sessionPrefix;
    this.executor = executor || new ShellCommandExecutor();
  }

  listSessions(): TmuxSession[] {
    try {
      const output = this.executor.exec('tmux list-sessions -F "#{session_name}|#{session_attached}|#{session_windows}|#{session_created}"');

      return output
        .trim()
        .split('\n')
        .filter((line) => line.startsWith(this.sessionPrefix))
        .map((line) => {
          const [name, attached, windows, created] = line.split('|');
          return {
            name,
            attached: attached === '1',
            windows: parseInt(windows, 10),
            created: new Date(parseInt(created, 10) * 1000),
          };
        });
    } catch (error) {
      // No sessions or tmux not running
      return [];
    }
  }

  getCurrentSession(paneTarget?: string): string | null {
    if (paneTarget) {
      try {
        const output = this.executor.exec(
          `tmux display-message -p -t ${escapeShellArg(paneTarget)} "#{session_name}"`,
        );
        const sessionName = output.trim();
        if (sessionName.length > 0) return sessionName;
      } catch {
        // Fall through to current-client lookup.
      }
    }

    try {
      const output = this.executor.exec('tmux display-message -p "#{session_name}"');
      const sessionName = output.trim();
      return sessionName.length > 0 ? sessionName : null;
    } catch {
      return null;
    }
  }

  getCurrentWindow(paneTarget?: string): string | null {
    if (paneTarget) {
      try {
        const output = this.executor.exec(
          `tmux display-message -p -t ${escapeShellArg(paneTarget)} "#{window_name}"`,
        );
        const windowName = output.trim();
        if (windowName.length > 0) return windowName;
      } catch {
        // Fall through to current-client lookup.
      }

      try {
        const output = this.executor.exec('tmux list-panes -a -F "#{pane_id}|#{window_name}"');
        const matched = output
          .trim()
          .split('\n')
          .map((line) => line.split('|'))
          .find(([paneId]) => paneId === paneTarget);
        const windowName = matched?.[1]?.trim() || '';
        if (windowName.length > 0) return windowName;
      } catch {
        // Fall through to current-client lookup.
      }
    }

    try {
      const output = this.executor.exec('tmux display-message -p "#{window_name}"');
      const windowName = output.trim();
      return windowName.length > 0 ? windowName : null;
    } catch {
      return null;
    }
  }

  createSession(name: string, firstWindowName?: string): void {
    const escapedName = escapeShellArg(`${this.sessionPrefix}${name}`);
    if (firstWindowName) {
      const escapedWindowName = escapeShellArg(firstWindowName);
      this.executor.exec(`tmux new-session -d -s ${escapedName} -n ${escapedWindowName}`);
      return;
    }
    this.executor.exec(`tmux new-session -d -s ${escapedName}`);
  }

  sendKeys(sessionName: string, keys: string): void {
    const escapedTarget = escapeShellArg(`${this.sessionPrefix}${sessionName}`);
    const escapedKeys = escapeShellArg(keys);
    this.executor.exec(`tmux send-keys -t ${escapedTarget} ${escapedKeys}`);
    this.executor.exec(`tmux send-keys -t ${escapedTarget} Enter`);
  }

  capturePane(sessionName: string): string {
    const escapedTarget = escapeShellArg(`${this.sessionPrefix}${sessionName}`);
    return this.executor.exec(`tmux capture-pane -t ${escapedTarget} -p`);
  }

  sessionExists(name: string): boolean {
    try {
      const escapedTarget = escapeShellArg(`${this.sessionPrefix}${name}`);
      this.executor.execVoid(`tmux has-session -t ${escapedTarget}`, {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check for an existing tmux session using the full session name.
   * Useful when session names are not derived from the prefix + projectName.
   */
  sessionExistsFull(fullSessionName: string): boolean {
    try {
      const escapedTarget = escapeShellArg(fullSessionName);
      this.executor.execVoid(`tmux has-session -t ${escapedTarget}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get existing session or create a new one
   * @returns Full session name with prefix
   */
  getOrCreateSession(projectName: string, firstWindowName?: string): string {
    const fullSessionName = `${this.sessionPrefix}${projectName}`;

    if (!this.sessionExists(projectName)) {
      try {
        this.createSession(projectName, firstWindowName);
      } catch (error) {
        throw new Error(`Failed to create tmux session '${fullSessionName}': ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return fullSessionName;
  }

  /**
   * Create a new window within a session
   * @param sessionName Full session name (already includes prefix)
   */
  createWindow(sessionName: string, windowName: string, initialCommand?: string): void {
    const escapedAppendTarget = escapeShellArg(`${sessionName}:$`);
    const escapedWindowName = escapeShellArg(windowName);
    const commandSuffix = initialCommand ? ` ${escapeShellArg(initialCommand)}` : '';

    try {
      this.executor.exec(`tmux new-window -a -t ${escapedAppendTarget} -n ${escapedWindowName}${commandSuffix}`);
    } catch (error) {
      throw new Error(`Failed to create window '${windowName}' in session '${sessionName}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  ensureWindowAtIndex(sessionName: string, windowIndex: number, windowName: string = 'discode-control'): void {
    const indexName = String(windowIndex);
    if (this.windowExists(sessionName, indexName)) return;

    const escapedTarget = escapeShellArg(`${sessionName}:${windowIndex}`);
    const escapedWindowName = escapeShellArg(windowName);

    try {
      this.executor.exec(`tmux new-window -d -t ${escapedTarget} -n ${escapedWindowName}`);
      return;
    } catch (error) {
      if (this.windowExists(sessionName, indexName)) return;
      throw new Error(
        `Failed to create window index '${windowIndex}' in session '${sessionName}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * List all windows in a session
   * @param sessionName Full session name (already includes prefix)
   */
  listWindows(sessionName: string): string[] {
    try {
      const escapedSession = escapeShellArg(sessionName);
      const output = this.executor.exec(`tmux list-windows -t ${escapedSession} -F "#{window_name}"`);

      return output
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
    } catch (error) {
      throw new Error(`Failed to list windows in session '${sessionName}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  windowExists(sessionName: string, windowName: string): boolean {
    try {
      const escapedTarget = escapeShellArg(`${sessionName}:${windowName}`);
      this.executor.execVoid(`tmux list-panes -t ${escapedTarget}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  ensureTuiPane(sessionName: string, windowName: string, tuiCommand: string[] | string): void {
    ensureTuiPane(this.executor, sessionName, windowName, tuiCommand);
  }

  /**
   * Send keys to a specific window
   * @param sessionName Full session name (already includes prefix)
   */
  sendKeysToWindow(sessionName: string, windowName: string, keys: string, paneHint?: string): void {
    const target = resolveWindowTarget(this.executor, sessionName, windowName, paneHint);
    const escapedTarget = escapeShellArg(target);
    const escapedKeys = escapeShellArg(keys);

    try {
      // Send keys and Enter separately for reliability
      this.executor.exec(`tmux send-keys -l -t ${escapedTarget} ${escapedKeys}`);
      this.executor.exec(`tmux send-keys -t ${escapedTarget} Enter`);
    } catch (error) {
      throw new Error(`Failed to send keys to window '${windowName}' in session '${sessionName}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Type keys into a specific window without pressing Enter.
   * Useful when we want to control submission separately.
   */
  typeKeysToWindow(sessionName: string, windowName: string, keys: string, paneHint?: string): void {
    const target = resolveWindowTarget(this.executor, sessionName, windowName, paneHint);
    const escapedTarget = escapeShellArg(target);
    const escapedKeys = escapeShellArg(keys);

    try {
      this.executor.exec(`tmux send-keys -l -t ${escapedTarget} ${escapedKeys}`);
    } catch (error) {
      throw new Error(`Failed to type keys to window '${windowName}' in session '${sessionName}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Send an Enter keypress to a specific window.
   * Useful for TUIs that may drop a submit when busy.
   */
  sendEnterToWindow(sessionName: string, windowName: string, paneHint?: string): void {
    const target = resolveWindowTarget(this.executor, sessionName, windowName, paneHint);
    const escapedTarget = escapeShellArg(target);
    try {
      this.executor.exec(`tmux send-keys -t ${escapedTarget} Enter`);
    } catch (error) {
      throw new Error(`Failed to send Enter to window '${windowName}' in session '${sessionName}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Send Escape keypresses to a specific window.
   * Used to cancel the current operation in CLI agents.
   * Sends 2 presses by default to handle vim mode / overlay dismissal.
   */
  sendEscapeToWindow(sessionName: string, windowName: string, paneHint?: string, count: number = 2): void {
    const target = resolveWindowTarget(this.executor, sessionName, windowName, paneHint);
    const escapedTarget = escapeShellArg(target);
    try {
      for (let i = 0; i < count; i++) {
        this.executor.exec(`tmux send-keys -t ${escapedTarget} Escape`);
      }
    } catch (error) {
      throw new Error(`Failed to send Escape to window '${windowName}' in session '${sessionName}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Capture pane output from a specific window
   * @param sessionName Full session name (already includes prefix)
   */
  capturePaneFromWindow(sessionName: string, windowName: string, paneHint?: string): string {
    const target = resolveWindowTarget(this.executor, sessionName, windowName, paneHint);
    const escapedTarget = escapeShellArg(target);

    try {
      return this.executor.exec(`tmux capture-pane -t ${escapedTarget} -p`);
    } catch (error) {
      throw new Error(`Failed to capture pane from window '${windowName}' in session '${sessionName}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Start an agent in a specific window
   */
  startAgentInWindow(sessionName: string, windowName: string, agentCommand: string): void {
    // If the target window already exists, send command into it.
    if (this.windowExists(sessionName, windowName)) {
      this.sendKeysToWindow(sessionName, windowName, agentCommand);
      return;
    }

    // Create window with a shell first (no initial command), then send the agent
    // command as keystrokes. This ensures the window persists even if the agent
    // command exits immediately (e.g. missing binary, auth error), so that
    // subsequent operations (TUI pane, attach) still find the window.
    try {
      this.createWindow(sessionName, windowName);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes('duplicate window')) {
        throw error;
      }
    }

    try {
      this.sendKeysToWindow(sessionName, windowName, agentCommand);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes("can't find window")) {
        throw error;
      }

      // Window name may have been auto-renamed. Recreate with shell and retry.
      this.createWindow(sessionName, windowName);
      this.sendKeysToWindow(sessionName, windowName, agentCommand);
    }
  }

  /**
   * Set an environment variable on a tmux session
   * New windows/processes in that session will inherit it
   */
  setSessionEnv(sessionName: string, key: string, value: string): void {
    const escapedSession = escapeShellArg(sessionName);
    const escapedKey = escapeShellArg(key);
    const escapedValue = escapeShellArg(value);

    try {
      this.executor.exec(`tmux set-environment -t ${escapedSession} ${escapedKey} ${escapedValue}`);
    } catch (error) {
      throw new Error(
        `Failed to set env ${key} on session '${sessionName}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Kill a specific window within a session.
   */
  killWindow(sessionName: string, windowName: string): void {
    const target = `${sessionName}:${windowName}`;
    const escapedTarget = escapeShellArg(target);
    this.executor.execVoid(`tmux kill-window -t ${escapedTarget}`, { stdio: 'ignore' });
  }

  /**
   * @deprecated Use escapeShellArg() from src/infra/shell-escape.ts instead.
   */
}

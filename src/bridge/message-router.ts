import type { MessagingClient } from '../messaging/interface.js';
import type { IStateManager } from '../types/interfaces.js';
import type { AgentRuntime } from '../runtime/interface.js';
import {
  findProjectInstanceByChannel,
  getPrimaryInstanceForAgent,
  getProjectInstance,
  normalizeProjectState,
} from '../state/instances.js';
import { PendingMessageTracker } from './pending-message-tracker.js';
import type { StreamingMessageUpdater } from './streaming-message-updater.js';
import type { ClaudeSdkRunner } from '../sdk/index.js';
import { processAttachments } from './message-file-handler.js';
import { scheduleBufferFallback } from './message-buffer-fallback.js';

export interface BridgeMessageRouterDeps {
  messaging: MessagingClient;
  runtime: AgentRuntime;
  stateManager: IStateManager;
  pendingTracker: PendingMessageTracker;
  streamingUpdater: StreamingMessageUpdater;
  sanitizeInput: (content: string) => string | null;
  getSdkRunner?: (projectName: string, instanceId: string) => ClaudeSdkRunner | undefined;
}

export class BridgeMessageRouter {
  private fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private deps: BridgeMessageRouterDeps) {}

  register(): void {
    const { messaging } = this.deps;

    messaging.onMessage(async (agentType, content, projectName, channelId, messageId, mappedInstanceId, attachments) => {
      console.log(
        `📨 [${projectName}/${agentType}${mappedInstanceId ? `#${mappedInstanceId}` : ''}] ${content.substring(0, 50)}...`,
      );

      // In-chat help command
      if (content.trim().toLowerCase() === 'help') {
        const helpText = [
          '*Discode* — Chat with AI coding agents',
          '',
          'Just type a message to send it to your agent.',
          'Attach images or files and they will be forwarded automatically.',
          '',
          '*Commands:*',
          '`help` — Show this message',
          '`cancel` — Cancel the current operation (sends ESC)',
          '',
          '_Tip: The agent sees your message as keyboard input in its terminal session._',
        ].join('\n');
        await messaging.sendToChannel(channelId, helpText);
        return;
      }

      const project = this.deps.stateManager.getProject(projectName);
      if (!project) {
        console.warn(`Project ${projectName} not found in state`);
        await messaging.sendToChannel(channelId, `⚠️ Project "${projectName}" not found in state`);
        return;
      }

      const normalizedProject = normalizeProjectState(project);
      const mappedInstance =
        (mappedInstanceId ? getProjectInstance(normalizedProject, mappedInstanceId) : undefined) ||
        findProjectInstanceByChannel(normalizedProject, channelId) ||
        getPrimaryInstanceForAgent(normalizedProject, agentType);
      if (!mappedInstance) {
        await messaging.sendToChannel(channelId, '⚠️ Agent instance mapping not found for this channel');
        return;
      }

      const resolvedAgentType = mappedInstance.agentType;
      const instanceKey = mappedInstance.instanceId;
      const windowName = mappedInstance.tmuxWindow || instanceKey;

      // Cancel command — abort SDK runner or send ESC to tmux
      if (content.trim().toLowerCase() === 'cancel') {
        if (mappedInstance.runtimeType === 'sdk') {
          const runner = this.deps.getSdkRunner?.(projectName, instanceKey);
          if (runner) {
            runner.abort();
          }
        } else {
          this.deps.runtime.sendEscapeToWindow?.(normalizedProject.tmuxSession, windowName, resolvedAgentType);
        }
        await messaging.sendToChannel(channelId, '⏹️ Cancel signal sent');
        return;
      }


      // Process file attachments (isolated in message-file-handler.ts)
      let enrichedContent = content;
      if (attachments && attachments.length > 0) {
        const markers = await processAttachments(
          attachments,
          project.projectPath,
          mappedInstance,
          `${projectName}/${agentType}`,
          messaging,
          channelId,
        );
        if (markers) {
          enrichedContent = content + markers;
        }
      }

      // Button answer messages use \x01 prefix to skip fallback scheduling
      // and pending tracker (they're part of an interactive question flow).
      const isButtonAnswer = enrichedContent.startsWith('\x01');
      if (isButtonAnswer) {
        enrichedContent = enrichedContent.slice(1);
      }

      // \x01 with no content = Enter-only (e.g. "Submit answers" confirmation)
      const isEnterOnly = isButtonAnswer && enrichedContent.length === 0;

      // Button answers contain intentional ANSI escape sequences (arrow keys)
      // that sanitizeInput would strip, so bypass sanitization for them.
      const sanitized = isEnterOnly ? '' : isButtonAnswer ? enrichedContent : this.deps.sanitizeInput(enrichedContent);
      if (!isEnterOnly && !isButtonAnswer && !sanitized) {
        await messaging.sendToChannel(channelId, '⚠️ Invalid message: empty, too long (>10000 chars), or contains invalid characters');
        return;
      }

      if (!isButtonAnswer) {
        if (messageId) {
          try {
            await this.deps.pendingTracker.markPending(projectName, resolvedAgentType, channelId, messageId, instanceKey);
          } catch {
            // If reaction/pending setup fails, continue with ensurePending so
            // request-start messaging still works.
            await this.deps.pendingTracker.ensurePending(projectName, resolvedAgentType, channelId, instanceKey);
          }
        } else {
          // Some platform callbacks may not provide a source messageId.
          // Still create pending context so prompt-start UI stays consistent.
          await this.deps.pendingTracker.ensurePending(projectName, resolvedAgentType, channelId, instanceKey);
        }
        // Store prompt preview for hook-driven start message creation.
        // This does not send any message from router path.
        (this.deps.pendingTracker as any).setPromptPreview?.(projectName, resolvedAgentType, content, instanceKey);
      }

      if (mappedInstance.runtimeType === 'sdk') {
        const runner = this.deps.getSdkRunner?.(projectName, instanceKey);
        if (!runner) {
          await this.deps.pendingTracker.markError(projectName, resolvedAgentType, instanceKey);
          await messaging.sendToChannel(channelId, '\u26A0\uFE0F SDK runner not found for this instance. Try restarting the project.');
          this.deps.stateManager.updateLastActive(projectName);
          return;
        }
        runner.submitMessage(isEnterOnly ? '' : sanitized!).catch((err) => {
          console.error(`[sdk-runner] submitMessage error for ${instanceKey}:`, err);
        });
      } else {
        try {
          if (isEnterOnly) {
            // Enter-only: just press Enter (e.g. "Submit answers" confirmation)
            this.deps.runtime.sendEnterToWindow(normalizedProject.tmuxSession, windowName, resolvedAgentType);
          } else if (isButtonAnswer) {
            // Button answers contain arrow key escape sequences.
            // Send each arrow individually with delay so Ink processes them one at a time.
            await this.submitArrowKeys(normalizedProject.tmuxSession, windowName, sanitized!, resolvedAgentType);
          } else {
            await this.submitToAgent(normalizedProject.tmuxSession, windowName, sanitized!, resolvedAgentType);
          }
          // Skip fallback for button answers — they're part of an interactive
          // question flow and shouldn't trigger buffer-based response detection.
          if (!isButtonAnswer) {
            scheduleBufferFallback(
              { messaging: this.deps.messaging, runtime: this.deps.runtime, pendingTracker: this.deps.pendingTracker },
              this.fallbackTimers,
              normalizedProject.tmuxSession,
              windowName,
              projectName,
              resolvedAgentType,
              instanceKey,
              channelId,
            );
          }
        } catch (error) {
          if (!isButtonAnswer) {
            await this.deps.pendingTracker.markError(projectName, resolvedAgentType, instanceKey);
          }
          await messaging.sendToChannel(channelId, this.buildDeliveryFailureGuidance(projectName, error));
        }
      }

      this.deps.stateManager.updateLastActive(projectName);
    });
  }

  private getEnvInt(name: string, defaultValue: number): number {
    const raw = process.env[name];
    if (!raw) return defaultValue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return defaultValue;
    return Math.trunc(n);
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async submitToAgent(
    tmuxSession: string,
    windowName: string,
    prompt: string,
    agentType: string,
  ): Promise<void> {
    console.log(`⌨️ [submit] typing ${prompt.length} chars to ${tmuxSession}:${windowName} (${agentType})`);
    this.deps.runtime.typeKeysToWindow(tmuxSession, windowName, prompt.trimEnd(), agentType);
    const envKey =
      agentType === 'opencode'
        ? 'DISCODE_OPENCODE_SUBMIT_DELAY_MS'
        : 'DISCODE_SUBMIT_DELAY_MS';
    const defaultMs = agentType === 'opencode' ? 75 : 300;
    const delayMs = this.getEnvInt(envKey, defaultMs);
    await this.sleep(delayMs);
    // Capture buffer state before Enter for debugging
    if (this.deps.runtime.getWindowBuffer) {
      try {
        const buf = this.deps.runtime.getWindowBuffer(tmuxSession, windowName);
        const lastLines = buf.split('\n').filter(l => l.trim()).slice(-8).join('\n');
        console.log(`⌨️ [submit] buffer before Enter:\n${lastLines}`);
      } catch { /* ignore */ }
    }
    this.deps.runtime.sendEnterToWindow(tmuxSession, windowName, agentType);
    // Capture buffer state after Enter
    await this.sleep(500);
    if (this.deps.runtime.getWindowBuffer) {
      try {
        const buf = this.deps.runtime.getWindowBuffer(tmuxSession, windowName);
        const lastLines = buf.split('\n').filter(l => l.trim()).slice(-8).join('\n');
        console.log(`⌨️ [submit] buffer after Enter:\n${lastLines}`);
      } catch { /* ignore */ }
    }
  }

  /**
   * Send arrow key escape sequences one at a time with delays, then Enter.
   * Ink (Claude CLI's UI) may merge multiple escapes received in a single
   * write, so we must send them individually.
   */
  private async submitArrowKeys(
    tmuxSession: string,
    windowName: string,
    keys: string,
    agentType: string,
  ): Promise<void> {
    // Split into individual escape sequences (\x1b[B, \x1b[A, etc.)
    const escapes = keys.match(/\x1b\[[A-D]/g) || [];
    console.log(`⌨️ [arrow] sending ${escapes.length} arrow keys to ${tmuxSession}:${windowName} (${agentType})`);
    for (const esc of escapes) {
      this.deps.runtime.typeKeysToWindow(tmuxSession, windowName, esc, agentType);
      await this.sleep(100);
    }
    await this.sleep(150);
    this.deps.runtime.sendEnterToWindow(tmuxSession, windowName, agentType);
  }


  private buildDeliveryFailureGuidance(projectName: string, error: unknown): string {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const missingTarget = /can't find (window|pane)/i.test(rawMessage);

    if (missingTarget) {
      return (
        `⚠️ I couldn't deliver your message because the agent tmux window is not running.\n` +
        `Please restart the agent session, then send your message again:\n` +
        `1) \`discode new --name ${projectName}\`\n` +
        `2) \`discode attach ${projectName}\``
      );
    }

    return (
      `⚠️ I couldn't deliver your message to the tmux agent session.\n` +
      `Please confirm the agent is running, then try again.\n` +
      `If needed, restart with \`discode new --name ${projectName}\`.`
    );
  }
}

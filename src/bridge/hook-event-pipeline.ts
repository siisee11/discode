/**
 * Event pipeline — resolves event context, manages queuing, and routes to handlers.
 */

import { resolve } from 'path';
import type { MessagingClient } from '../messaging/interface.js';
import type { IStateManager } from '../types/interfaces.js';
import { truncateContent } from '../infra/log-sanitizer.js';
import {
  getPrimaryInstanceForAgent,
  getProjectInstance,
  normalizeProjectState,
} from '../state/instances.js';
import { PendingMessageTracker } from './pending-message-tracker.js';
import type { PendingEntry } from './pending-message-tracker.js';
import type { StreamingMessageUpdater } from './streaming-message-updater.js';
import {
  handleSessionError,
  handleSessionNotification,
  handleSessionStart,
  handleSessionEnd,
  handleThinkingStart,
  handleThinkingStop,
  handleToolActivity,
  handleSessionIdle,
  handlePermissionRequest,
  handleTaskCompleted,
  handlePromptSubmit,
  handleToolFailure,
  handleTeammateIdle,
  type EventHandlerDeps,
} from './hook-event-handlers.js';
import { validateHookEventEnvelope } from '../types/hook-contract.js';
import { agentRegistry } from '../agents/index.js';

/** Shared context passed to individual event handlers after common validation. */
export interface EventContext {
  event: Record<string, unknown>;
  projectName: string;
  channelId: string;
  agentType: string;
  instanceId: string | undefined;
  instanceKey: string;
  text: string | undefined;
  projectPath: string;
  pendingSnapshot: PendingEntry | undefined;
}

export interface EventPipelineDeps {
  messaging: MessagingClient;
  stateManager: IStateManager;
  pendingTracker: PendingMessageTracker;
  streamingUpdater: StreamingMessageUpdater;
}

export class HookEventPipeline {
  /** Per-channel event queue to serialize message delivery. */
  private channelQueues = new Map<string, Promise<void>>();
  /** Periodic timers that show elapsed thinking time. */
  private thinkingTimers = new Map<string, { timer: ReturnType<typeof setInterval>; startTime: number }>();
  /** Activity history per instance (for error context). */
  private activityHistory = new Map<string, string[]>();
  /** Session lifecycle timers. */
  private sessionLifecycleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private eventHandlers: Record<string, (deps: EventHandlerDeps, ctx: EventContext) => Promise<boolean>> = {
    'session.error': handleSessionError,
    'session.notification': handleSessionNotification,
    'session.start': handleSessionStart,
    'session.end': handleSessionEnd,
    'thinking.start': handleThinkingStart,
    'thinking.stop': handleThinkingStop,
    'tool.activity': handleToolActivity,
    'session.idle': handleSessionIdle,
    'permission.request': handlePermissionRequest,
    'task.completed': handleTaskCompleted,
    'prompt.submit': handlePromptSubmit,
    'tool.failure': handleToolFailure,
    'teammate.idle': handleTeammateIdle,
  };

  constructor(private deps: EventPipelineDeps) {}

  stop(): void {
    for (const [key] of this.thinkingTimers) {
      this.clearThinkingTimer(key);
    }
    for (const timer of this.sessionLifecycleTimers.values()) {
      clearTimeout(timer);
    }
    this.sessionLifecycleTimers.clear();
    this.activityHistory.clear();
  }

  async handleOpencodeEvent(payload: unknown): Promise<boolean> {
    const validation = validateHookEventEnvelope(payload);
    if (!validation.ok) {
      if (validation.errors.some((error) => error.startsWith('projectName'))) {
        console.warn('⚠️ [event-pipeline] missing projectName in event');
      } else {
        console.warn(`⚠️ [event-pipeline] invalid payload (${validation.errors.join('; ')})`);
      }
      return false;
    }

    const event = validation.value as Record<string, unknown>;
    const projectName = typeof event.projectName === 'string' ? event.projectName : '';
    const agentType = typeof event.agentType === 'string' ? event.agentType : 'opencode';
    const instanceId = typeof event.instanceId === 'string' ? event.instanceId : undefined;
    const eventType = typeof event.type === 'string' ? event.type : undefined;

    const project = this.deps.stateManager.getProject(projectName);
    if (!project) {
      console.warn(`⚠️ [event-pipeline] project not found: ${projectName}`);
      return false;
    }

    const normalizedProject = normalizeProjectState(project);
    const instance =
      (instanceId ? getProjectInstance(normalizedProject, instanceId) : undefined) ||
      getPrimaryInstanceForAgent(normalizedProject, agentType);
    const channelId = instance?.channelId;
    if (!channelId) {
      console.warn(`⚠️ [event-pipeline] no channel for ${projectName}/${agentType}${instanceId ? `#${instanceId}` : ''} (instance ${instance ? 'found but missing channelId' : 'not found'})`);
      return false;
    }

    const text = this.getEventText(event);
    const resolvedAgentType = instance?.agentType || agentType;
    const resolvedInstanceId = instance?.instanceId;
    const instanceKey = resolvedInstanceId || resolvedAgentType;

    // If the adapter does not support prompt-submit hooks, ignore this event.
    // Some agents do not expose a dedicated prompt-start hook.
    if (eventType === 'prompt.submit') {
      const adapter = agentRegistry.get(resolvedAgentType);
      if (!adapter?.supportsHookEvent('prompt.submit')) {
        console.log(
          `⏭️ [${projectName}/${resolvedAgentType}${resolvedInstanceId ? `#${resolvedInstanceId}` : ''}] event=prompt.submit skipped (unsupported)`,
        );
        return true;
      }
    }

    const intermediateLen = eventType === 'session.idle' && typeof event.intermediateText === 'string' ? event.intermediateText.length : 0;
    const intermediateSuffix = intermediateLen > 0 ? ` intermediate=(${intermediateLen} chars)` : '';
    console.log(
      `\uD83D\uDD0D [${projectName}/${resolvedAgentType}${resolvedInstanceId ? `#${resolvedInstanceId}` : ''}] event=${eventType} text=${text ? `(${text.length} chars) ${truncateContent(text)}` : '(empty)'}${intermediateSuffix}`,
    );

    // Auto-create pending entry for tmux-initiated prompts
    if (
      (eventType === 'tool.activity' || eventType === 'session.idle' || eventType === 'prompt.submit') &&
      !this.deps.pendingTracker.hasPending(projectName, resolvedAgentType, resolvedInstanceId)
    ) {
      await this.deps.pendingTracker.ensurePending(projectName, resolvedAgentType, channelId, resolvedInstanceId);
    }

    const pendingSnapshot = this.deps.pendingTracker.getPending(projectName, resolvedAgentType, resolvedInstanceId);

    const ctx: EventContext = {
      event,
      projectName,
      channelId,
      agentType: resolvedAgentType,
      instanceId: resolvedInstanceId,
      instanceKey,
      text,
      projectPath: project.projectPath ? resolve(project.projectPath) : '',
      pendingSnapshot: pendingSnapshot ? { ...pendingSnapshot } : undefined,
    };

    const handler = eventType ? this.eventHandlers[eventType] : undefined;
    if (handler) {
      const handlerDeps = this.buildHandlerDeps();
      return this.enqueueForChannel(channelId, () => handler(handlerDeps, ctx));
    }
    return true;
  }

  private buildHandlerDeps(): EventHandlerDeps {
    return {
      messaging: this.deps.messaging,
      pendingTracker: this.deps.pendingTracker,
      streamingUpdater: this.deps.streamingUpdater,
      thinkingTimers: this.thinkingTimers,
      activityHistory: this.activityHistory,
      sessionLifecycleTimers: this.sessionLifecycleTimers,
      ensureStartMessageAndStreaming: (ctx) => this.ensureStartMessageAndStreaming(ctx),
      clearThinkingTimer: (key) => this.clearThinkingTimer(key),
      clearSessionLifecycleTimer: (key) => this.clearSessionLifecycleTimer(key),
    };
  }

  private getEventText(payload: Record<string, unknown>): string | undefined {
    const direct = payload.text;
    if (typeof direct === 'string' && direct.trim().length > 0) return direct;
    const message = payload.message;
    if (typeof message === 'string' && message.trim().length > 0) return message;
    return undefined;
  }

  private enqueueForChannel(channelId: string, fn: () => Promise<boolean>): Promise<boolean> {
    const previous = this.channelQueues.get(channelId) ?? Promise.resolve();
    let result = true;
    const next = previous
      .then(async () => { result = await fn(); })
      .catch((error) => { console.error('⚠️ [event-pipeline] handler error:', error); })
      .finally(() => {
        if (this.channelQueues.get(channelId) === next) {
          this.channelQueues.delete(channelId);
        }
      });
    this.channelQueues.set(channelId, next);
    return next.then(() => result);
  }

  private clearThinkingTimer(key: string): void {
    const entry = this.thinkingTimers.get(key);
    if (entry) {
      clearInterval(entry.timer);
      this.thinkingTimers.delete(key);
    }
  }

  private clearSessionLifecycleTimer(key: string): void {
    const timer = this.sessionLifecycleTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.sessionLifecycleTimers.delete(key);
    }
  }

  private async ensureStartMessageAndStreaming(ctx: EventContext): Promise<string | undefined> {
    const submittedPrompt = typeof ctx.event.submittedPrompt === 'string'
      ? ctx.event.submittedPrompt
      : undefined;
    const startMessageId = await this.deps.pendingTracker.ensureStartMessage(
      ctx.projectName, ctx.agentType, ctx.instanceId, submittedPrompt,
    );

    if (startMessageId) {
      if (ctx.pendingSnapshot) {
        ctx.pendingSnapshot.startMessageId = startMessageId;
      }
      if (!this.deps.streamingUpdater.has(ctx.projectName, ctx.instanceKey)) {
        const pending = this.deps.pendingTracker.getPending(ctx.projectName, ctx.agentType, ctx.instanceId);
        if (pending) {
          // Create a separate message for streaming updates so the start message
          // ("📝 Prompt: ...") is preserved and not overwritten by tool activity.
          let streamingMsgId = startMessageId;
          if (this.deps.messaging.sendToChannelWithId) {
            try {
              const newId = await this.deps.messaging.sendToChannelWithId(
                pending.channelId, '\u23F3 Working...',
              );
              if (newId) streamingMsgId = newId;
            } catch {
              // Fall back to reusing startMessageId
            }
          }
          this.deps.streamingUpdater.start(ctx.projectName, ctx.instanceKey, pending.channelId, streamingMsgId, startMessageId);
        }
      }
    }

    return startMessageId;
  }
}

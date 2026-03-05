/**
 * Individual event handlers for session lifecycle, thinking, tool activity, and idle.
 * Separated from pipeline/routing for change isolation:
 * - Text response changes don't affect file handling
 * - Thinking indicator changes don't affect response delivery
 */

import type { MessagingClient } from '../messaging/interface.js';
import type { PendingMessageTracker } from './pending-message-tracker.js';
import type { StreamingMessageUpdater } from './streaming-message-updater.js';
import type { EventContext } from './hook-event-pipeline.js';
import {
  handleTaskProgress,
  handleGitActivity,
  handleSubagentDone,
  clearTaskChecklist,
  markTaskCompletedInChecklist,
} from './hook-structured-handlers.js';
import {
  buildFinalizeHeader,
  postUsageToChannel,
  postIntermediateTextToChannel,
  postThinkingToChannel,
  postResponseText,
  postResponseFiles,
  postPromptChoices,
  splitAndSendToChannel,
} from './hook-idle-response.js';

export interface EventHandlerDeps {
  messaging: MessagingClient;
  pendingTracker: PendingMessageTracker;
  streamingUpdater: StreamingMessageUpdater;
  /** Periodic timers that show elapsed thinking time. */
  thinkingTimers: Map<string, { timer: ReturnType<typeof setInterval>; startTime: number }>;
  /** Activity history per instance (for error context). */
  activityHistory: Map<string, string[]>;
  /** Session lifecycle timers. */
  sessionLifecycleTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Lazy start message creation + streaming updater start. */
  ensureStartMessageAndStreaming: (ctx: EventContext) => Promise<string | undefined>;
  clearThinkingTimer: (key: string) => void;
  clearSessionLifecycleTimer: (key: string) => void;
}

const THINKING_INTERVAL_MS = 5_000;
const SESSION_LIFECYCLE_DELAY_MS = 5_000;

export async function handleSessionError(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const k = `${ctx.projectName}:${ctx.instanceKey}`;
  deps.clearThinkingTimer(k);

  // Collect recent tool activity lines before clearing (error context for Slack users)
  const recentLines = deps.activityHistory.get(k)?.slice(-5) || [];

  deps.activityHistory.delete(k);
  clearTaskChecklist(k);
  deps.streamingUpdater.discard(ctx.projectName, ctx.instanceKey);
  deps.pendingTracker.markError(ctx.projectName, ctx.agentType, ctx.instanceId).catch(() => {});
  const msg = ctx.text || 'unknown error';
  let errorMessage = `\u26A0\uFE0F *Error:* ${msg}`;
  if (recentLines.length > 0) {
    errorMessage += '\n\nRecent activity:\n' + recentLines.join('\n');
  }
  errorMessage += '\n\n_You can retry by sending your message again._';
  await deps.messaging.sendToChannel(ctx.channelId, errorMessage);
  return true;
}

export async function handleSessionNotification(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const notificationType = typeof ctx.event.notificationType === 'string' ? ctx.event.notificationType : 'unknown';
  const emojiMap: Record<string, string> = {
    permission_prompt: '\uD83D\uDD10',
    idle_prompt: '\uD83D\uDCA4',
    auth_success: '\uD83D\uDD11',
    elicitation_dialog: '\u2753',
    plan_approval: '\uD83D\uDCCB',
  };
  const emoji = emojiMap[notificationType] || '\uD83D\uDD14';
  const msg = ctx.text || notificationType;
  await deps.messaging.sendToChannel(ctx.channelId, `${emoji} ${msg}`);

  // Plan approval: send plan file and approve/reject buttons
  const planFilePath = typeof ctx.event.planFilePath === 'string' ? ctx.event.planFilePath.trim() : '';
  const promptQuestionsCount = Array.isArray(ctx.event.promptQuestions) ? ctx.event.promptQuestions.length : 0;
  console.log(`🔔 [notification] type=${notificationType} planFilePath=${planFilePath || '(none)'} promptText=${(typeof ctx.event.promptText === 'string' ? ctx.event.promptText.length : 0)} chars promptQuestions=${promptQuestionsCount}`);
  if (planFilePath) {
    const { existsSync } = await import('fs');
    if (existsSync(planFilePath)) {
      await deps.messaging.sendToChannelWithFiles(ctx.channelId, '', [planFilePath]);
    }
    // Send plan approval choices matching Claude CLI's ExitPlanMode options.
    // Option indices must match Claude CLI's arrow-key navigation order.
    deps.messaging.sendQuestionWithButtons(ctx.channelId, [{
      question: 'Proceed with the plan?',
      header: 'Plan',
      options: [
        { label: 'Yes, clear context & bypass', description: 'Clear context and run without permission prompts' },
        { label: 'Yes, bypass permissions', description: 'Approve and let Claude run without permission prompts' },
        { label: 'Yes, manual approvals', description: 'Approve but manually approve each edit' },
        { label: 'Give feedback', description: 'Type a message to tell Claude what to change' },
      ],
    }]).catch((err) => {
      console.warn('sendQuestionWithButtons for plan approval failed:', err);
    });
    return true;
  }

  // AskUserQuestion: send interactive buttons when promptQuestions are present
  const promptQuestions = Array.isArray(ctx.event.promptQuestions) ? ctx.event.promptQuestions : [];
  if (promptQuestions.length > 0) {
    deps.messaging.sendQuestionWithButtons(ctx.channelId, promptQuestions as Array<{
      question: string;
      header?: string;
      multiSelect?: boolean;
      options: Array<{ label: string; description?: string }>;
    }>).catch((err) => {
      console.warn('sendQuestionWithButtons for prompt questions failed:', err);
    });
    return true;
  }

  // Skip promptText for elicitation_dialog — the Stop hook (session.idle) will
  // deliver it with interactive buttons via sendQuestionWithButtons.
  if (notificationType === 'elicitation_dialog') return true;

  const promptText = typeof ctx.event.promptText === 'string' ? ctx.event.promptText.trim() : '';
  if (promptText) {
    await splitAndSendToChannel(deps.messaging, ctx.channelId, promptText);
  }
  return true;
}

export async function handleSessionStart(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const source = typeof ctx.event.source === 'string' ? ctx.event.source : 'unknown';
  if (source === 'startup') {
    return true;
  }
  const model = typeof ctx.event.model === 'string' ? ctx.event.model : '';
  const modelSuffix = model ? `, ${model}` : '';
  await deps.messaging.sendToChannel(ctx.channelId, `\u25B6\uFE0F *Session started* (${source}${modelSuffix})`);

  deps.pendingTracker.setHookActive(ctx.projectName, ctx.agentType, ctx.instanceId);

  const timerKey = `${ctx.projectName}:${ctx.instanceKey}`;
  deps.clearSessionLifecycleTimer(timerKey);
  const timer = setTimeout(() => {
    deps.sessionLifecycleTimers.delete(timerKey);
    if (
      deps.pendingTracker.hasPending(ctx.projectName, ctx.agentType, ctx.instanceId) &&
      !deps.pendingTracker.getPending(ctx.projectName, ctx.agentType, ctx.instanceId)?.startMessageId
    ) {
      deps.pendingTracker.markCompleted(ctx.projectName, ctx.agentType, ctx.instanceId).catch(() => {});
    }
  }, SESSION_LIFECYCLE_DELAY_MS);
  deps.sessionLifecycleTimers.set(timerKey, timer);

  return true;
}

export async function handleSessionEnd(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const reason = typeof ctx.event.reason === 'string' ? ctx.event.reason : 'unknown';
  await deps.messaging.sendToChannel(ctx.channelId, `\u23F9\uFE0F *Session ended* (${reason})`);
  deps.pendingTracker.setHookActive(ctx.projectName, ctx.agentType, ctx.instanceId);
  return true;
}

export async function handleThinkingStart(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  deps.clearSessionLifecycleTimer(`${ctx.projectName}:${ctx.instanceKey}`);
  await deps.ensureStartMessageAndStreaming(ctx);

  const pending = ctx.pendingSnapshot;
  if (pending?.messageId) {
    deps.messaging.addReactionToMessage(pending.channelId, pending.messageId, '\uD83E\uDDE0').catch(() => {});
  }

  const timerKey = `${ctx.projectName}:${ctx.instanceKey}`;
  deps.clearThinkingTimer(timerKey);
  const startTime = Date.now();
  deps.streamingUpdater.append(ctx.projectName, ctx.instanceKey, '\uD83E\uDDE0 Thinking\u2026');
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    deps.streamingUpdater.append(ctx.projectName, ctx.instanceKey, `\uD83E\uDDE0 Thinking\u2026 (${elapsed}s)`);
  }, THINKING_INTERVAL_MS);
  deps.thinkingTimers.set(timerKey, { timer, startTime });

  return true;
}

export async function handleThinkingStop(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const pending = ctx.pendingSnapshot;
  const timerKey = `${ctx.projectName}:${ctx.instanceKey}`;
  const entry = deps.thinkingTimers.get(timerKey);
  if (entry) {
    const elapsed = Math.round((Date.now() - entry.startTime) / 1000);
    if (elapsed >= 5) {
      deps.streamingUpdater.append(ctx.projectName, ctx.instanceKey, `\uD83E\uDDE0 Thought for ${elapsed}s`);
    }
  }
  deps.clearThinkingTimer(timerKey);

  if (pending?.messageId) {
    deps.messaging.replaceOwnReactionOnMessage(
      pending.channelId, pending.messageId, '\uD83E\uDDE0', '\u2705',
    ).catch(() => {});
  }
  return true;
}

export async function handleToolActivity(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  deps.clearSessionLifecycleTimer(`${ctx.projectName}:${ctx.instanceKey}`);
  await deps.ensureStartMessageAndStreaming(ctx);

  // Structured event prefixes — dispatch to specialized handlers
  if (ctx.text?.startsWith('TASK_CREATE:') || ctx.text?.startsWith('TASK_UPDATE:')) {
    return handleTaskProgress(deps, ctx);
  }
  if (ctx.text?.startsWith('GIT_COMMIT:') || ctx.text?.startsWith('GIT_PUSH:')) {
    return handleGitActivity(deps, ctx);
  }
  if (ctx.text?.startsWith('SUBAGENT_DONE:')) {
    return handleSubagentDone(deps, ctx);
  }

  if (ctx.text) {
    const k = `${ctx.projectName}:${ctx.instanceKey}`;
    let lines = deps.activityHistory.get(k);
    if (!lines) {
      lines = [];
      deps.activityHistory.set(k, lines);
    }
    lines.push(ctx.text);
    deps.streamingUpdater.appendCumulative(ctx.projectName, ctx.instanceKey, ctx.text);
  }

  return true;
}

export async function handleSessionIdle(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const idleKey = `${ctx.projectName}:${ctx.instanceKey}`;
  deps.clearThinkingTimer(idleKey);
  deps.clearSessionLifecycleTimer(idleKey);
  deps.activityHistory.delete(idleKey);
  clearTaskChecklist(idleKey);

  let livePending = deps.pendingTracker.getPending(ctx.projectName, ctx.agentType, ctx.instanceId);
  let startMessageId = livePending?.startMessageId;
  let createdStartMessageInIdle = false;
  // Some agents only emit session.idle (no tool/thinking). For tmux-initiated
  // turns (no source messageId), ensure the start marker still exists so
  // prompt-start UX remains consistent.
  if (!startMessageId && livePending && (!livePending.messageId || !!livePending.promptPreview)) {
    await deps.ensureStartMessageAndStreaming(ctx);
    livePending = deps.pendingTracker.getPending(ctx.projectName, ctx.agentType, ctx.instanceId);
    startMessageId = livePending?.startMessageId;
    createdStartMessageInIdle = !!startMessageId;
  }

  const usage = ctx.event.usage as Record<string, unknown> | undefined;
  const hasPrompt = Array.isArray(ctx.event.promptQuestions) && ctx.event.promptQuestions.length > 0
    || (typeof ctx.event.promptText === 'string' && ctx.event.promptText.trim().length > 0);
  if (startMessageId && (!createdStartMessageInIdle || hasPrompt)) {
    const finalizeHeader = hasPrompt ? '\u2753 Waiting for input...' : buildFinalizeHeader(usage);
    await deps.streamingUpdater.finalize(
      ctx.projectName, ctx.instanceKey,
      finalizeHeader || undefined,
      startMessageId,
    );
  }

  if (hasPrompt) {
    // Replace hourglass with question mark instead of checkmark when waiting for user input
    const livePendingForReaction = deps.pendingTracker.getPending(ctx.projectName, ctx.agentType, ctx.instanceId);
    if (livePendingForReaction?.messageId) {
      deps.messaging.replaceOwnReactionOnMessage(
        livePendingForReaction.channelId, livePendingForReaction.messageId, '\u23F3', '\u2753',
      ).catch(() => {});
    }
  }
  deps.pendingTracker.markCompleted(ctx.projectName, ctx.agentType, ctx.instanceId).catch(() => {});

  await postUsageToChannel(deps.messaging, ctx.channelId, usage);
  await postIntermediateTextToChannel(deps.messaging, ctx.channelId, ctx.event);
  await postThinkingToChannel(deps.messaging, ctx.channelId, ctx.event);

  // Main response: text + files (separated for change isolation)
  await postResponseText(deps.messaging, ctx);
  await postResponseFiles(deps.messaging, ctx);

  // Prompt choices (AskUserQuestion, ExitPlanMode)
  await postPromptChoices(deps.messaging, ctx);

  return true;
}

export async function handlePermissionRequest(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const toolName = typeof ctx.event.toolName === 'string' ? ctx.event.toolName : 'unknown';
  const toolInput = typeof ctx.event.toolInput === 'string' ? ctx.event.toolInput : '';
  const inputSuffix = toolInput ? ` — \`${toolInput}\`` : '';
  await deps.messaging.sendToChannel(ctx.channelId, `\uD83D\uDD10 *Permission needed:* \`${toolName}\`${inputSuffix}`);
  return true;
}

export async function handleTaskCompleted(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const taskSubject = typeof ctx.event.taskSubject === 'string' ? ctx.event.taskSubject : '';
  const teammateName = typeof ctx.event.teammateName === 'string' ? ctx.event.teammateName : '';
  const taskId = typeof ctx.event.taskId === 'string' ? ctx.event.taskId : '';
  const prefix = teammateName ? `\u2705 *[${teammateName}] Task completed*` : '\u2705 *Task completed*';
  const subject = taskSubject ? `: ${taskSubject}` : '';
  await deps.messaging.sendToChannel(ctx.channelId, `${prefix}${subject}`);

  if (taskId) {
    const k = `${ctx.projectName}:${ctx.instanceKey}`;
    markTaskCompletedInChecklist(deps, k, taskId);
  }

  return true;
}

export async function handlePromptSubmit(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const preview = ctx.text?.trim() || '';
  if (!preview) return true;
  const startMessageId = await deps.pendingTracker.ensureStartMessage(
    ctx.projectName,
    ctx.agentType,
    ctx.instanceId,
    preview,
  );
  if (!startMessageId) {
    await deps.messaging.sendToChannel(ctx.channelId, `\uD83D\uDCDD Prompt: ${preview}`);
  }
  return true;
}

export async function handleToolFailure(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const toolName = typeof ctx.event.toolName === 'string' ? ctx.event.toolName : 'unknown';
  const error = typeof ctx.event.error === 'string' ? ctx.event.error : '';
  const errorSuffix = error ? `: ${error}` : '';
  let inputContext = '';
  const rawInput = ctx.event.toolInput;
  if (rawInput) {
    const inputStr = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput);
    inputContext = inputStr.length > 200 ? inputStr.substring(0, 200) + '...' : inputStr;
  }
  let msg = `\u26A0\uFE0F *${toolName} failed*${errorSuffix}`;
  if (inputContext) {
    msg += `\n\`\`\`${inputContext}\`\`\``;
  }
  await deps.messaging.sendToChannel(ctx.channelId, msg);
  return true;
}

export async function handleTeammateIdle(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const teammateName = typeof ctx.event.teammateName === 'string' ? ctx.event.teammateName : '';
  const teamName = typeof ctx.event.teamName === 'string' ? ctx.event.teamName : '';
  if (!teammateName) return true;
  const teamSuffix = teamName ? ` (${teamName})` : '';
  await deps.messaging.sendToChannel(ctx.channelId, `\uD83D\uDCA4 *[${teammateName}]* idle${teamSuffix}`);
  return true;
}

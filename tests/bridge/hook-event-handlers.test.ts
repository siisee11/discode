import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventHandlerDeps } from '../../src/bridge/hook-event-handlers.js';
import type { EventContext } from '../../src/bridge/hook-event-pipeline.js';
import {
  handleSessionError,
  handleSessionStart,
  handleSessionEnd,
  handleSessionNotification,
  handleThinkingStart,
  handleThinkingStop,
  handleToolActivity,
  handleSessionIdle,
} from '../../src/bridge/hook-event-handlers.js';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  realpathSync: vi.fn((p: string) => p),
}));

vi.mock('../../src/capture/parser.js', () => ({
  splitForDiscord: vi.fn((text: string) => [text]),
  splitForSlack: vi.fn((text: string) => [text]),
  extractFilePaths: vi.fn(() => []),
  stripFilePaths: vi.fn((text: string) => text),
}));

function createMockDeps(): EventHandlerDeps {
  return {
    messaging: {
      platform: 'discord' as const,
      sendToChannel: vi.fn().mockResolvedValue(undefined),
      sendToChannelWithId: vi.fn().mockResolvedValue('msg-id'),
      sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
      addReactionToMessage: vi.fn().mockResolvedValue(undefined),
      replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
      replyInThread: vi.fn().mockResolvedValue(undefined),
      replyInThreadWithId: vi.fn().mockResolvedValue('reply-id'),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    } as any,
    pendingTracker: {
      hasPending: vi.fn().mockReturnValue(false),
      getPending: vi.fn().mockReturnValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      setHookActive: vi.fn(),
      ensureStartMessage: vi.fn().mockResolvedValue(undefined),
    } as any,
    streamingUpdater: {
      has: vi.fn().mockReturnValue(false),
      start: vi.fn(),
      append: vi.fn(),
      appendCumulative: vi.fn(),
      discard: vi.fn(),
      finalize: vi.fn().mockResolvedValue(undefined),
    } as any,
    thinkingTimers: new Map(),
    activityHistory: new Map(),
    sessionLifecycleTimers: new Map(),
    ensureStartMessageAndStreaming: vi.fn().mockResolvedValue(undefined),
    clearThinkingTimer: vi.fn(),
    clearSessionLifecycleTimer: vi.fn(),
  };
}

function createCtx(overrides: Partial<EventContext> = {}): EventContext {
  return {
    event: {},
    projectName: 'myProject',
    channelId: 'ch-1',
    agentType: 'opencode',
    instanceId: undefined,
    instanceKey: 'opencode',
    text: undefined,
    projectPath: '/tmp/project',
    pendingSnapshot: undefined,
    ...overrides,
  };
}

describe('handleSessionError', () => {
  it('sends error message to channel', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: 'crash happened' });
    const result = await handleSessionError(deps, ctx);
    expect(result).toBe(true);
    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith('ch-1', expect.stringContaining('crash happened'));
  });

  it('uses "unknown error" when text is empty', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: undefined });
    await handleSessionError(deps, ctx);
    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith('ch-1', expect.stringContaining('unknown error'));
  });

  it('clears thinking timer and streaming updater', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleSessionError(deps, ctx);
    expect(deps.clearThinkingTimer).toHaveBeenCalledWith('myProject:opencode');
    expect(deps.streamingUpdater.discard).toHaveBeenCalledWith('myProject', 'opencode');
  });

  it('marks pending as error', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleSessionError(deps, ctx);
    expect(deps.pendingTracker.markError).toHaveBeenCalledWith('myProject', 'opencode', undefined);
  });

  it('clears activity history', async () => {
    const deps = createMockDeps();
    deps.activityHistory.set('myProject:opencode', ['test']);
    const ctx = createCtx();
    await handleSessionError(deps, ctx);
    expect(deps.activityHistory.has('myProject:opencode')).toBe(false);
  });
});

describe('handleSessionNotification', () => {
  it('sends notification with appropriate emoji', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { notificationType: 'permission_prompt' },
      text: 'Needs permission',
    });
    await handleSessionNotification(deps, ctx);
    const msg = (deps.messaging.sendToChannel as any).mock.calls[0][1];
    expect(msg).toContain('Needs permission');
  });

  it('sends promptText if present', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { notificationType: 'idle_prompt', promptText: 'Choose an option' },
      text: 'idle',
    });
    await handleSessionNotification(deps, ctx);
    expect(deps.messaging.sendToChannel).toHaveBeenCalledTimes(2);
  });

  it('uses default bell emoji for unknown notification type', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { notificationType: 'some_new_type' },
      text: 'msg',
    });
    await handleSessionNotification(deps, ctx);
    const msg = (deps.messaging.sendToChannel as any).mock.calls[0][1];
    expect(msg).toContain('msg');
  });

  // ── Plan approval (ExitPlanMode) ────────────────────────────

  it('sends plan file and 4-option question buttons when planFilePath is set and file exists', async () => {
    const { existsSync } = await import('fs');
    (existsSync as any).mockReturnValue(true);

    const deps = createMockDeps();
    (deps.messaging as any).sendQuestionWithButtons = vi.fn().mockResolvedValue(null);
    const ctx = createCtx({
      event: { notificationType: 'plan_approval', planFilePath: '/tmp/project/.claude/plans/plan.md' },
      text: 'Plan ready',
    });

    const result = await handleSessionNotification(deps, ctx);
    expect(result).toBe(true);

    // Should send the plan file
    expect(deps.messaging.sendToChannelWithFiles).toHaveBeenCalledWith(
      'ch-1', '', ['/tmp/project/.claude/plans/plan.md'],
    );

    // Should send question with 4 options matching Claude CLI ExitPlanMode
    expect((deps.messaging as any).sendQuestionWithButtons).toHaveBeenCalledTimes(1);
    const questionArgs = (deps.messaging as any).sendQuestionWithButtons.mock.calls[0];
    const questions = questionArgs[1];
    expect(questions).toHaveLength(1);
    expect(questions[0].options).toHaveLength(4);
    expect(questions[0].options[0].label).toContain('clear context');
    expect(questions[0].options[1].label).toContain('bypass permissions');
    expect(questions[0].options[2].label).toContain('manual approvals');
    expect(questions[0].options[3].label).toContain('Give feedback');
  });

  it('skips sending plan file when file does not exist', async () => {
    const { existsSync } = await import('fs');
    (existsSync as any).mockReturnValue(false);

    const deps = createMockDeps();
    (deps.messaging as any).sendQuestionWithButtons = vi.fn().mockResolvedValue(null);
    const ctx = createCtx({
      event: { notificationType: 'plan_approval', planFilePath: '/tmp/nonexistent.md' },
      text: 'Plan ready',
    });

    await handleSessionNotification(deps, ctx);
    expect(deps.messaging.sendToChannelWithFiles).not.toHaveBeenCalled();
    // Still sends question buttons
    expect((deps.messaging as any).sendQuestionWithButtons).toHaveBeenCalledTimes(1);
  });

  it('returns true early for plan approval (does not send promptText)', async () => {
    const { existsSync } = await import('fs');
    (existsSync as any).mockReturnValue(false);

    const deps = createMockDeps();
    (deps.messaging as any).sendQuestionWithButtons = vi.fn().mockResolvedValue(null);
    const ctx = createCtx({
      event: {
        notificationType: 'plan_approval',
        planFilePath: '/tmp/plan.md',
        promptText: 'This should not be sent separately',
      },
      text: 'Plan ready',
    });

    await handleSessionNotification(deps, ctx);
    // promptText should not be sent as a separate message
    const sendToChannelCalls = (deps.messaging.sendToChannel as any).mock.calls;
    const texts = sendToChannelCalls.map((c: any) => c[1]);
    expect(texts).not.toContain('This should not be sent separately');
  });

  // ── AskUserQuestion (promptQuestions) ──────────────────────────

  it('sends interactive buttons when promptQuestions are present', async () => {
    const deps = createMockDeps();
    (deps.messaging as any).sendQuestionWithButtons = vi.fn().mockResolvedValue(null);

    const promptQuestions = [{
      question: 'Which approach?',
      header: 'Approach',
      options: [
        { label: 'Fast', description: 'Quick' },
        { label: 'Safe', description: 'Reliable' },
      ],
    }];

    const ctx = createCtx({
      event: { notificationType: 'idle_prompt', promptQuestions },
      text: 'Choose an option',
    });

    const result = await handleSessionNotification(deps, ctx);
    expect(result).toBe(true);

    expect((deps.messaging as any).sendQuestionWithButtons).toHaveBeenCalledTimes(1);
    const passedQuestions = (deps.messaging as any).sendQuestionWithButtons.mock.calls[0][1];
    expect(passedQuestions).toEqual(promptQuestions);
  });

  it('returns true early for promptQuestions (does not send promptText)', async () => {
    const deps = createMockDeps();
    (deps.messaging as any).sendQuestionWithButtons = vi.fn().mockResolvedValue(null);

    const ctx = createCtx({
      event: {
        notificationType: 'idle_prompt',
        promptQuestions: [{
          question: 'Pick one',
          options: [{ label: 'A' }, { label: 'B' }],
        }],
        promptText: 'Formatted text that should be skipped',
      },
      text: 'Notification',
    });

    await handleSessionNotification(deps, ctx);
    const sendToChannelCalls = (deps.messaging.sendToChannel as any).mock.calls;
    const texts = sendToChannelCalls.map((c: any) => c[1]);
    expect(texts).not.toContain('Formatted text that should be skipped');
  });

  it('does not send question buttons when promptQuestions is empty', async () => {
    const deps = createMockDeps();
    (deps.messaging as any).sendQuestionWithButtons = vi.fn().mockResolvedValue(null);

    const ctx = createCtx({
      event: { notificationType: 'idle_prompt', promptQuestions: [] },
      text: 'idle',
    });

    await handleSessionNotification(deps, ctx);
    expect((deps.messaging as any).sendQuestionWithButtons).not.toHaveBeenCalled();
  });

  it('handles sendQuestionWithButtons failure gracefully for plan approval', async () => {
    const { existsSync } = await import('fs');
    (existsSync as any).mockReturnValue(false);

    const deps = createMockDeps();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (deps.messaging as any).sendQuestionWithButtons = vi.fn().mockRejectedValue(new Error('button error'));

    const ctx = createCtx({
      event: { notificationType: 'plan_approval', planFilePath: '/tmp/plan.md' },
      text: 'Plan',
    });

    // Should not throw
    const result = await handleSessionNotification(deps, ctx);
    expect(result).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('handleSessionStart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips sending message for startup source', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ event: { source: 'startup' } });
    const result = await handleSessionStart(deps, ctx);
    expect(result).toBe(true);
    expect(deps.messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('sends session started message with source', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ event: { source: 'user', model: 'claude-4' } });
    await handleSessionStart(deps, ctx);
    const msg = (deps.messaging.sendToChannel as any).mock.calls[0][1];
    expect(msg).toContain('*Session started*');
    expect(msg).toContain('user');
    expect(msg).toContain('claude-4');
  });

  it('sets hook active on pending tracker', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ event: { source: 'user' } });
    await handleSessionStart(deps, ctx);
    expect(deps.pendingTracker.setHookActive).toHaveBeenCalledWith('myProject', 'opencode', undefined);
  });

  it('clears previous session lifecycle timer', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ event: { source: 'user' } });
    await handleSessionStart(deps, ctx);
    expect(deps.clearSessionLifecycleTimer).toHaveBeenCalledWith('myProject:opencode');
  });
});

describe('handleSessionEnd', () => {
  it('sends session ended message with reason', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ event: { reason: 'user_stop' } });
    await handleSessionEnd(deps, ctx);
    const msg = (deps.messaging.sendToChannel as any).mock.calls[0][1];
    expect(msg).toContain('*Session ended*');
    expect(msg).toContain('user_stop');
  });

  it('sets hook active', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ event: { reason: 'done' } });
    await handleSessionEnd(deps, ctx);
    expect(deps.pendingTracker.setHookActive).toHaveBeenCalled();
  });
});

describe('handleThinkingStart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls ensureStartMessageAndStreaming', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleThinkingStart(deps, ctx);
    expect(deps.ensureStartMessageAndStreaming).toHaveBeenCalledWith(ctx);
  });

  it('clears session lifecycle timer', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleThinkingStart(deps, ctx);
    expect(deps.clearSessionLifecycleTimer).toHaveBeenCalledWith('myProject:opencode');
  });

  it('adds brain reaction when pending has messageId', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      pendingSnapshot: { channelId: 'ch-1', messageId: 'msg-1' },
    });
    await handleThinkingStart(deps, ctx);
    expect(deps.messaging.addReactionToMessage).toHaveBeenCalledWith('ch-1', 'msg-1', expect.any(String));
  });

  it('appends thinking text to streaming updater', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleThinkingStart(deps, ctx);
    expect(deps.streamingUpdater.append).toHaveBeenCalledWith('myProject', 'opencode', expect.stringContaining('Thinking'));
  });

  it('clears previous thinking timer before starting new', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleThinkingStart(deps, ctx);
    expect(deps.clearThinkingTimer).toHaveBeenCalledWith('myProject:opencode');
  });
});

describe('handleThinkingStop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears thinking timer', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleThinkingStop(deps, ctx);
    expect(deps.clearThinkingTimer).toHaveBeenCalledWith('myProject:opencode');
  });

  it('appends elapsed time when >= 5 seconds', async () => {
    const deps = createMockDeps();
    deps.thinkingTimers.set('myProject:opencode', {
      timer: setInterval(() => {}, 999999),
      startTime: Date.now() - 6000,
    });
    const ctx = createCtx();
    await handleThinkingStop(deps, ctx);
    expect(deps.streamingUpdater.append).toHaveBeenCalledWith('myProject', 'opencode', expect.stringContaining('Thought for'));
  });

  it('does not append elapsed time when < 5 seconds', async () => {
    const deps = createMockDeps();
    deps.thinkingTimers.set('myProject:opencode', {
      timer: setInterval(() => {}, 999999),
      startTime: Date.now() - 2000,
    });
    const ctx = createCtx();
    await handleThinkingStop(deps, ctx);
    expect(deps.streamingUpdater.append).not.toHaveBeenCalled();
  });

  it('replaces brain reaction with checkmark when pending has messageId', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      pendingSnapshot: { channelId: 'ch-1', messageId: 'msg-1' },
    });
    await handleThinkingStop(deps, ctx);
    expect(deps.messaging.replaceOwnReactionOnMessage).toHaveBeenCalled();
  });
});

describe('handleToolActivity', () => {
  it('calls ensureStartMessageAndStreaming', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: 'Reading file...' });
    await handleToolActivity(deps, ctx);
    expect(deps.ensureStartMessageAndStreaming).toHaveBeenCalledWith(ctx);
  });

  it('clears session lifecycle timer', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: 'Reading...' });
    await handleToolActivity(deps, ctx);
    expect(deps.clearSessionLifecycleTimer).toHaveBeenCalledWith('myProject:opencode');
  });

  it('appends text to streaming updater', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: 'Writing file...' });
    await handleToolActivity(deps, ctx);
    expect(deps.streamingUpdater.appendCumulative).toHaveBeenCalledWith('myProject', 'opencode', 'Writing file...');
  });

  it('tracks activity lines in activityHistory', async () => {
    const deps = createMockDeps();
    await handleToolActivity(deps, createCtx({ text: 'line1' }));
    await handleToolActivity(deps, createCtx({ text: 'line2' }));
    expect(deps.activityHistory.get('myProject:opencode')).toEqual(['line1', 'line2']);
  });

  it('does not track when no text', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: undefined });
    await handleToolActivity(deps, ctx);
    expect(deps.activityHistory.has('myProject:opencode')).toBe(false);
    expect(deps.streamingUpdater.appendCumulative).not.toHaveBeenCalled();
  });
});

describe('handleSessionIdle', () => {
  it('clears thinking timer and session lifecycle timer', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleSessionIdle(deps, ctx);
    expect(deps.clearThinkingTimer).toHaveBeenCalledWith('myProject:opencode');
    expect(deps.clearSessionLifecycleTimer).toHaveBeenCalledWith('myProject:opencode');
  });

  it('clears activity history', async () => {
    const deps = createMockDeps();
    deps.activityHistory.set('myProject:opencode', ['test']);
    const ctx = createCtx();
    await handleSessionIdle(deps, ctx);
    expect(deps.activityHistory.has('myProject:opencode')).toBe(false);
  });

  it('finalizes streaming when startMessageId exists', async () => {
    const deps = createMockDeps();
    (deps.pendingTracker.getPending as any).mockReturnValue({
      channelId: 'ch-1', messageId: 'msg-1', startMessageId: 'start-1',
    });
    const ctx = createCtx();
    await handleSessionIdle(deps, ctx);
    expect(deps.streamingUpdater.finalize).toHaveBeenCalled();
  });

  it('ensures start message when pending exists without startMessageId', async () => {
    const deps = createMockDeps();
    (deps.pendingTracker.getPending as any)
      .mockReturnValueOnce({
        channelId: 'ch-1',
        messageId: '',
      })
      .mockReturnValueOnce({
        channelId: 'ch-1',
        messageId: '',
        startMessageId: 'start-late',
      });
    const ctx = createCtx();

    await handleSessionIdle(deps, ctx);

    expect(deps.ensureStartMessageAndStreaming).toHaveBeenCalledWith(ctx);
    expect(deps.streamingUpdater.finalize).not.toHaveBeenCalled();
  });

  it('marks pending as completed', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleSessionIdle(deps, ctx);
    expect(deps.pendingTracker.markCompleted).toHaveBeenCalledWith('myProject', 'opencode', undefined);
  });

  it('does not force start message for source-message pending entries', async () => {
    const deps = createMockDeps();
    (deps.pendingTracker.getPending as any).mockReturnValue({
      channelId: 'ch-1',
      messageId: 'user-msg-1',
    });
    const ctx = createCtx({ text: 'Quick answer' });

    await handleSessionIdle(deps, ctx);

    expect(deps.ensureStartMessageAndStreaming).not.toHaveBeenCalled();
    expect(deps.streamingUpdater.finalize).not.toHaveBeenCalled();
  });

  it('ensures start message for source-message pending when prompt preview exists', async () => {
    const deps = createMockDeps();
    (deps.pendingTracker.getPending as any)
      .mockReturnValueOnce({
        channelId: 'ch-1',
        messageId: 'user-msg-1',
        promptPreview: '테스트메세지1',
      })
      .mockReturnValueOnce({
        channelId: 'ch-1',
        messageId: 'user-msg-1',
        promptPreview: '테스트메세지1',
        startMessageId: 'start-with-preview',
      });
    const ctx = createCtx({ text: 'Quick answer' });

    await handleSessionIdle(deps, ctx);

    expect(deps.ensureStartMessageAndStreaming).toHaveBeenCalledWith(ctx);
    expect(deps.streamingUpdater.finalize).not.toHaveBeenCalled();
  });

  it('sends response text to channel', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: 'Here is the answer' });
    await handleSessionIdle(deps, ctx);
    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'Here is the answer');
  });

  it('does not send when text is empty', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: undefined });
    await handleSessionIdle(deps, ctx);
    expect(deps.messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('sends promptText to channel', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { promptText: 'Do you approve?' },
      text: 'Response',
    });
    await handleSessionIdle(deps, ctx);
    const calls = (deps.messaging.sendToChannel as any).mock.calls;
    const texts = calls.map((c: any) => c[1]);
    expect(texts).toContain('Do you approve?');
  });
});

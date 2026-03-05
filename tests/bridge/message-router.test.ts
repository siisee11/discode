/**
 * Tests for BridgeMessageRouter — button answer protocol (\x01 prefix),
 * sanitize bypass, submitArrowKeys, and Enter-only mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/state/instances.js', () => ({
  findProjectInstanceByChannel: vi.fn(),
  getPrimaryInstanceForAgent: vi.fn(),
  getProjectInstance: vi.fn(),
  normalizeProjectState: vi.fn((p: any) => ({
    ...p,
    tmuxSession: p.tmuxSession || 'test-session',
    instances: p.instances || {},
  })),
}));

vi.mock('../../src/bridge/message-file-handler.js', () => ({
  processAttachments: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/bridge/message-buffer-fallback.js', () => ({
  scheduleBufferFallback: vi.fn(),
}));

import { BridgeMessageRouter, type BridgeMessageRouterDeps } from '../../src/bridge/message-router.js';
import { findProjectInstanceByChannel, getPrimaryInstanceForAgent, getProjectInstance } from '../../src/state/instances.js';
import { scheduleBufferFallback } from '../../src/bridge/message-buffer-fallback.js';

function createMockDeps(): BridgeMessageRouterDeps {
  return {
    messaging: {
      platform: 'discord' as const,
      onMessage: vi.fn(),
      sendToChannel: vi.fn().mockResolvedValue(undefined),
      sendToChannelWithId: vi.fn().mockResolvedValue('msg-id'),
      sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
      replyInThread: vi.fn().mockResolvedValue(undefined),
      replyInThreadWithId: vi.fn().mockResolvedValue('reply-id'),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      addReactionToMessage: vi.fn().mockResolvedValue(undefined),
      replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    } as any,
    runtime: {
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendEscapeToWindow: vi.fn(),
      getWindowBuffer: vi.fn().mockReturnValue(''),
    } as any,
    stateManager: {
      getProject: vi.fn().mockReturnValue({
        projectPath: '/tmp/project',
        tmuxSession: 'test-session',
        instances: {},
      }),
      updateLastActive: vi.fn(),
    } as any,
    pendingTracker: {
      markPending: vi.fn().mockResolvedValue(undefined),
      ensurePending: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      setPromptPreview: vi.fn(),
    } as any,
    streamingUpdater: {} as any,
    sanitizeInput: vi.fn((content: string) => content || null),
  };
}

function setupInstanceResolution() {
  (getProjectInstance as any).mockReturnValue(undefined);
  (findProjectInstanceByChannel as any).mockReturnValue({
    agentType: 'claude',
    instanceId: 'claude',
    tmuxWindow: 'claude',
    runtimeType: 'tmux',
  });
  (getPrimaryInstanceForAgent as any).mockReturnValue(undefined);
}

describe('BridgeMessageRouter', () => {
  let deps: BridgeMessageRouterDeps;
  let router: BridgeMessageRouter;
  let messageHandler: (...args: any[]) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    deps = createMockDeps();
    router = new BridgeMessageRouter(deps);
    setupInstanceResolution();

    // Capture the callback registered via onMessage
    router.register();
    messageHandler = (deps.messaging.onMessage as any).mock.calls[0][0];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Normal messages ─────────────────────────────────────────────

  it('routes normal messages through sanitizeInput', async () => {
    await messageHandler('claude', 'hello world', 'proj', 'ch-1', 'msg-1', undefined, undefined);
    expect(deps.sanitizeInput).toHaveBeenCalledWith('hello world');
  });

  it('registers pending for normal messages with messageId', async () => {
    await messageHandler('claude', 'hello', 'proj', 'ch-1', 'msg-1', undefined, undefined);
    expect(deps.pendingTracker.markPending).toHaveBeenCalledWith('proj', 'claude', 'ch-1', 'msg-1', 'claude');
  });

  it('schedules buffer fallback for normal messages', async () => {
    await messageHandler('claude', 'hello', 'proj', 'ch-1', 'msg-1', undefined, undefined);
    expect(scheduleBufferFallback).toHaveBeenCalled();
  });

  it('sends error when sanitizeInput returns null', async () => {
    (deps.sanitizeInput as any).mockReturnValue(null);
    await messageHandler('claude', '', 'proj', 'ch-1', 'msg-1', undefined, undefined);
    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith('ch-1', expect.stringContaining('Invalid message'));
  });

  it('types keys and sends Enter for normal messages', async () => {
    await messageHandler('claude', 'do something', 'proj', 'ch-1', 'msg-1', undefined, undefined);
    expect(deps.runtime.typeKeysToWindow).toHaveBeenCalledWith('test-session', 'claude', 'do something', 'claude');
    // After delay, sendEnterToWindow is called
    await vi.advanceTimersByTimeAsync(500);
    expect(deps.runtime.sendEnterToWindow).toHaveBeenCalledWith('test-session', 'claude', 'claude');
  });

  // ── Button answer (\x01 prefix) ────────────────────────────────

  it('bypasses sanitizeInput for button answers', async () => {
    const arrows = '\x01\x1b[B\x1b[B';
    await messageHandler('claude', arrows, 'proj', 'ch-1', undefined, undefined, undefined);
    expect(deps.sanitizeInput).not.toHaveBeenCalled();
  });

  it('skips pending tracker for button answers', async () => {
    const arrows = '\x01\x1b[B';
    await messageHandler('claude', arrows, 'proj', 'ch-1', 'msg-1', undefined, undefined);
    expect(deps.pendingTracker.markPending).not.toHaveBeenCalled();
    expect(deps.pendingTracker.ensurePending).not.toHaveBeenCalled();
  });

  it('skips buffer fallback for button answers', async () => {
    const arrows = '\x01\x1b[B';
    await messageHandler('claude', arrows, 'proj', 'ch-1', undefined, undefined, undefined);
    expect(scheduleBufferFallback).not.toHaveBeenCalled();
  });

  it('sends individual arrow keys with delays for button answers', async () => {
    const arrows = '\x01\x1b[B\x1b[B\x1b[B';
    await messageHandler('claude', arrows, 'proj', 'ch-1', undefined, undefined, undefined);

    // Should have sent 3 individual arrow keys
    const typeKeyCalls = (deps.runtime.typeKeysToWindow as any).mock.calls;
    expect(typeKeyCalls).toHaveLength(3);
    expect(typeKeyCalls[0][2]).toBe('\x1b[B');
    expect(typeKeyCalls[1][2]).toBe('\x1b[B');
    expect(typeKeyCalls[2][2]).toBe('\x1b[B');

    // After final sleep, Enter is sent
    expect(deps.runtime.sendEnterToWindow).toHaveBeenCalledWith('test-session', 'claude', 'claude');
  });

  // ── Enter-only (\x01 with no content) ──────────────────────────

  it('sends only Enter for enter-only button answer', async () => {
    await messageHandler('claude', '\x01', 'proj', 'ch-1', undefined, undefined, undefined);

    expect(deps.runtime.typeKeysToWindow).not.toHaveBeenCalled();
    expect(deps.runtime.sendEnterToWindow).toHaveBeenCalledWith('test-session', 'claude', 'claude');
  });

  it('skips pending tracker for enter-only', async () => {
    await messageHandler('claude', '\x01', 'proj', 'ch-1', 'msg-1', undefined, undefined);
    expect(deps.pendingTracker.markPending).not.toHaveBeenCalled();
    expect(deps.pendingTracker.ensurePending).not.toHaveBeenCalled();
  });

  it('skips buffer fallback for enter-only', async () => {
    await messageHandler('claude', '\x01', 'proj', 'ch-1', undefined, undefined, undefined);
    expect(scheduleBufferFallback).not.toHaveBeenCalled();
  });

  // ── Project not found ──────────────────────────────────────────

  it('sends warning when project is not in state', async () => {
    (deps.stateManager.getProject as any).mockReturnValue(undefined);
    await messageHandler('claude', 'hello', 'unknown-proj', 'ch-1', 'msg-1', undefined, undefined);
    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith('ch-1', expect.stringContaining('not found'));
  });

  // ── Instance not found ─────────────────────────────────────────

  it('sends warning when instance mapping not found', async () => {
    (findProjectInstanceByChannel as any).mockReturnValue(undefined);
    (getPrimaryInstanceForAgent as any).mockReturnValue(undefined);
    await messageHandler('claude', 'hello', 'proj', 'ch-1', 'msg-1', undefined, undefined);
    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith('ch-1', expect.stringContaining('instance mapping not found'));
  });

  // ── Help command ───────────────────────────────────────────────

  it('responds to help command without routing to agent', async () => {
    await messageHandler('claude', 'help', 'proj', 'ch-1', 'msg-1', undefined, undefined);
    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith('ch-1', expect.stringContaining('Discode'));
    expect(deps.runtime.typeKeysToWindow).not.toHaveBeenCalled();
  });

  // ── Cancel command ──────────────────────────────────────────────

  it('sends Escape to tmux window on cancel command', async () => {
    await messageHandler('claude', 'cancel', 'proj', 'ch-1', 'msg-1', undefined, undefined);
    expect(deps.runtime.sendEscapeToWindow).toHaveBeenCalledWith('test-session', 'claude', 'claude');
    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith('ch-1', '⏹️ Cancel signal sent');
    expect(deps.runtime.typeKeysToWindow).not.toHaveBeenCalled();
  });

  it('aborts SDK runner on cancel command', async () => {
    (findProjectInstanceByChannel as any).mockReturnValue({
      agentType: 'claude',
      instanceId: 'claude',
      tmuxWindow: 'claude',
      runtimeType: 'sdk',
    });
    const mockRunner = { abort: vi.fn(), submitMessage: vi.fn() };
    deps.getSdkRunner = vi.fn().mockReturnValue(mockRunner);

    await messageHandler('claude', 'cancel', 'proj', 'ch-1', 'msg-1', undefined, undefined);
    expect(mockRunner.abort).toHaveBeenCalled();
    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith('ch-1', '⏹️ Cancel signal sent');
  });

  it('cancel command is case-insensitive', async () => {
    await messageHandler('claude', '  Cancel  ', 'proj', 'ch-1', 'msg-1', undefined, undefined);
    expect(deps.runtime.sendEscapeToWindow).toHaveBeenCalled();
    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith('ch-1', '⏹️ Cancel signal sent');
  });

  // ── SDK runner path ────────────────────────────────────────────

  it('routes to SDK runner when runtimeType is sdk', async () => {
    (findProjectInstanceByChannel as any).mockReturnValue({
      agentType: 'claude',
      instanceId: 'claude',
      tmuxWindow: 'claude',
      runtimeType: 'sdk',
    });
    const mockRunner = { submitMessage: vi.fn().mockResolvedValue(undefined) };
    deps.getSdkRunner = vi.fn().mockReturnValue(mockRunner);

    await messageHandler('claude', 'hello', 'proj', 'ch-1', 'msg-1', undefined, undefined);
    expect(mockRunner.submitMessage).toHaveBeenCalledWith('hello');
    expect(deps.runtime.typeKeysToWindow).not.toHaveBeenCalled();
  });

  it('sends error when SDK runner not found', async () => {
    (findProjectInstanceByChannel as any).mockReturnValue({
      agentType: 'claude',
      instanceId: 'claude',
      tmuxWindow: 'claude',
      runtimeType: 'sdk',
    });
    deps.getSdkRunner = vi.fn().mockReturnValue(undefined);

    await messageHandler('claude', 'hello', 'proj', 'ch-1', 'msg-1', undefined, undefined);
    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith('ch-1', expect.stringContaining('SDK runner not found'));
  });

  // ── Delivery failure ───────────────────────────────────────────

  it('sends guidance on delivery failure for missing window', async () => {
    (deps.runtime.typeKeysToWindow as any).mockImplementation(() => {
      throw new Error("can't find window");
    });

    await messageHandler('claude', 'hello', 'proj', 'ch-1', 'msg-1', undefined, undefined);
    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith('ch-1', expect.stringContaining('tmux window is not running'));
    expect(deps.pendingTracker.markError).toHaveBeenCalled();
  });

  it('does not mark error on delivery failure for button answers', async () => {
    (deps.runtime.typeKeysToWindow as any).mockImplementation(() => {
      throw new Error("can't find window");
    });

    await messageHandler('claude', '\x01\x1b[B', 'proj', 'ch-1', undefined, undefined, undefined);
    // Button answers should not call markError
    expect(deps.pendingTracker.markError).not.toHaveBeenCalled();
  });

  // ── Updates last active ────────────────────────────────────────

  it('updates last active timestamp after routing', async () => {
    await messageHandler('claude', 'hello', 'proj', 'ch-1', 'msg-1', undefined, undefined);
    expect(deps.stateManager.updateLastActive).toHaveBeenCalledWith('proj');
  });
});

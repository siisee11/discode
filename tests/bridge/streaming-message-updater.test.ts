import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingMessageUpdater } from '../../src/bridge/streaming-message-updater.js';

function createMockMessaging(withUpdateMessage = true) {
  return {
    platform: 'slack' as const,
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithId: vi.fn().mockResolvedValue('start-msg-ts'),
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    replyInThread: vi.fn().mockResolvedValue(undefined),
    ...(withUpdateMessage ? { updateMessage: vi.fn().mockResolvedValue(undefined) } : {}),
  };
}

describe('StreamingMessageUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('canStream', () => {
    it('returns true when messaging has updateMessage', () => {
      const messaging = createMockMessaging(true);
      const updater = new StreamingMessageUpdater(messaging as any);
      expect(updater.canStream()).toBe(true);
    });

    it('returns false when messaging lacks updateMessage', () => {
      const messaging = createMockMessaging(false);
      const updater = new StreamingMessageUpdater(messaging as any);
      expect(updater.canStream()).toBe(false);
    });
  });

  describe('start / has', () => {
    it('creates an entry', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);

      expect(updater.has('proj', 'inst')).toBe(false);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      expect(updater.has('proj', 'inst')).toBe(true);
    });

    it('replaces an existing entry', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);

      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'old status');
      updater.start('proj', 'inst', 'ch-2', 'msg-2');

      // Old text should be gone after restart
      updater.append('proj', 'inst', 'new status');
      vi.advanceTimersByTime(800);

      expect(messaging.updateMessage).toHaveBeenCalledWith(
        'ch-2',
        'msg-2',
        'new status',
      );
    });
  });

  describe('append', () => {
    it('returns false when no active entry', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      expect(updater.append('proj', 'inst', 'text')).toBe(false);
    });

    it('replaces previous text and debounces updateMessage', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');

      expect(updater.append('proj', 'inst', 'status 1')).toBe(true);
      expect(updater.append('proj', 'inst', 'status 2')).toBe(true);

      // Not flushed yet (within debounce window)
      expect(messaging.updateMessage).not.toHaveBeenCalled();

      // After debounce period — only shows latest status
      vi.advanceTimersByTime(800);

      expect(messaging.updateMessage).toHaveBeenCalledTimes(1);
      expect(messaging.updateMessage).toHaveBeenCalledWith(
        'ch-1',
        'msg-1',
        'status 2',
      );
    });

    it('resets debounce timer on each append', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');

      updater.append('proj', 'inst', 'status 1');
      vi.advanceTimersByTime(500); // not yet
      updater.append('proj', 'inst', 'status 2');
      vi.advanceTimersByTime(500); // still not yet (reset)

      expect(messaging.updateMessage).not.toHaveBeenCalled();

      vi.advanceTimersByTime(300); // now 750ms since last append
      expect(messaging.updateMessage).toHaveBeenCalledTimes(1);
    });

    it('shows Processing header when flushed with no text', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');

      updater.append('proj', 'inst', '');
      vi.advanceTimersByTime(800);

      expect(messaging.updateMessage).toHaveBeenCalledWith(
        'ch-1',
        'msg-1',
        '\u23F3 Working...',
      );
    });
  });

  describe('appendCumulative', () => {
    it('accumulates lines in order and flushes once after debounce', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');

      expect(updater.appendCumulative('proj', 'inst', 'Step A')).toBe(true);
      expect(updater.appendCumulative('proj', 'inst', 'Step B')).toBe(true);
      expect(updater.appendCumulative('proj', 'inst', 'Step C')).toBe(true);

      vi.advanceTimersByTime(800);

      expect(messaging.updateMessage).toHaveBeenCalledTimes(1);
      expect(messaging.updateMessage).toHaveBeenCalledWith(
        'ch-1',
        'msg-1',
        'Step A\nStep B\nStep C',
      );
    });

    it('starts new message when content exceeds platform limit', async () => {
      const messaging = createMockMessaging();
      messaging.sendToChannelWithId.mockResolvedValue('new-msg-ts');
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');

      // Fill up near the limit (slack = 3900)
      const bigLine = 'x'.repeat(3890);
      updater.appendCumulative('proj', 'inst', bigLine);
      vi.advanceTimersByTime(800);
      await vi.advanceTimersByTimeAsync(0);

      expect(messaging.updateMessage).toHaveBeenCalledTimes(1);

      // This line would push past 3900 → triggers overflow
      updater.appendCumulative('proj', 'inst', 'overflow line');
      vi.advanceTimersByTime(800);
      await vi.advanceTimersByTimeAsync(0);

      // Should have created a new message instead of updating
      expect(messaging.sendToChannelWithId).toHaveBeenCalledWith('ch-1', 'overflow line');
    });

    it('uses new message ID for subsequent updates after overflow', async () => {
      const messaging = createMockMessaging();
      messaging.sendToChannelWithId.mockResolvedValue('new-msg-ts');
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');

      // Fill near limit (3890 + 1 + 13 = 3904 > 3900 triggers overflow)
      const bigLine = 'x'.repeat(3890);
      updater.appendCumulative('proj', 'inst', bigLine);
      vi.advanceTimersByTime(800);
      await vi.advanceTimersByTimeAsync(0);

      updater.appendCumulative('proj', 'inst', 'overflow line');
      vi.advanceTimersByTime(800);
      await vi.advanceTimersByTimeAsync(0);

      // Now append more content — should update the NEW message ID
      // (13 + 1 + 9 = 23 < 3900, no overflow)
      updater.appendCumulative('proj', 'inst', 'next line');
      vi.advanceTimersByTime(800);
      await vi.advanceTimersByTimeAsync(0);

      expect(messaging.updateMessage).toHaveBeenLastCalledWith(
        'ch-1',
        'new-msg-ts',
        'overflow line\nnext line',
      );
    });

    it('handles multiple overflows creating multiple new messages', async () => {
      const messaging = createMockMessaging();
      let msgCounter = 0;
      messaging.sendToChannelWithId.mockImplementation(async () => `new-msg-${++msgCounter}`);
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');

      // First overflow: 3890 + 1 + 10 = 3901 > 3900
      const bigLine = 'x'.repeat(3890);
      updater.appendCumulative('proj', 'inst', bigLine);
      vi.advanceTimersByTime(800);
      await vi.advanceTimersByTimeAsync(0);

      updater.appendCumulative('proj', 'inst', 'overflow-1');
      vi.advanceTimersByTime(800);
      await vi.advanceTimersByTimeAsync(0);

      expect(messaging.sendToChannelWithId).toHaveBeenCalledWith('ch-1', 'overflow-1');

      // Fill up the new message: after overflow, currentText="overflow-1" (10 chars)
      // 10 + 1 + 3880 = 3891 < 3900 → fits
      const bigLine2 = 'x'.repeat(3880);
      updater.appendCumulative('proj', 'inst', bigLine2);
      vi.advanceTimersByTime(800);
      await vi.advanceTimersByTimeAsync(0);

      // Second overflow: 3891 + 1 + 10 = 3902 > 3900
      updater.appendCumulative('proj', 'inst', 'overflow-2');
      vi.advanceTimersByTime(800);
      await vi.advanceTimersByTimeAsync(0);

      expect(messaging.sendToChannelWithId).toHaveBeenCalledTimes(2);
      expect(messaging.sendToChannelWithId).toHaveBeenLastCalledWith('ch-1', 'overflow-2');
    });

    it('overflows to new message when cumulative text exceeds discord limit', () => {
      const messaging = {
        ...createMockMessaging(),
        platform: 'discord' as const,
      };
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');

      const longLine = 'x'.repeat(1200);
      updater.appendCumulative('proj', 'inst', longLine);
      updater.appendCumulative('proj', 'inst', longLine);
      updater.appendCumulative('proj', 'inst', longLine);

      vi.advanceTimersByTime(800);

      // Overflow resets history to latest line and sends via new message
      expect(messaging.sendToChannelWithId).toHaveBeenCalled();
      const call = messaging.sendToChannelWithId.mock.calls.at(-1);
      const content = call?.[1] as string;
      expect(content.length).toBeLessThanOrEqual(1900);
    });
  });

  describe('finalize', () => {
    it('posts Done header as a new message and removes entry', async () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'tool 1');
      updater.append('proj', 'inst', 'tool 2');

      await updater.finalize('proj', 'inst');

      expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', '\u2705 Done');
      expect(updater.has('proj', 'inst')).toBe(false);
    });

    it('flushes pending content before posting Done when debounce has not fired', async () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'tool 1');

      // Finalize before debounce fires — should flush pending content then post Done
      await updater.finalize('proj', 'inst');

      // Advance past debounce — should not trigger extra update
      vi.advanceTimersByTime(1000);

      expect(messaging.updateMessage).toHaveBeenCalledTimes(1);
      expect(messaging.updateMessage).toHaveBeenCalledWith('ch-1', 'msg-1', 'tool 1');
      expect(messaging.sendToChannel).toHaveBeenCalledTimes(1);
      expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', '\u2705 Done');
    });

    it('uses custom header when provided', async () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');

      await updater.finalize('proj', 'inst', '\u2705 Done \u00B7 1,000 tokens \u00B7 $0.05');

      expect(messaging.sendToChannel).toHaveBeenCalledWith(
        'ch-1',
        '\u2705 Done \u00B7 1,000 tokens \u00B7 $0.05',
      );
    });

    it('handles no appends gracefully', async () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');

      await updater.finalize('proj', 'inst');

      expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', '\u2705 Done');
    });

    it('is a no-op when no entry exists', async () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);

      await updater.finalize('proj', 'inst');
      expect(messaging.sendToChannel).not.toHaveBeenCalled();
      expect(messaging.updateMessage).not.toHaveBeenCalled();
    });

    it('skips finalize when expectedMessageId does not match', async () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');

      await updater.finalize('proj', 'inst', undefined, 'msg-other');

      expect(messaging.sendToChannel).not.toHaveBeenCalled();
      expect(messaging.updateMessage).not.toHaveBeenCalled();
      expect(updater.has('proj', 'inst')).toBe(true);
    });

    it('finalizes when originId matches expectedMessageId even if messageId differs', async () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      // messageId is streaming msg, originId is the start message
      updater.start('proj', 'inst', 'ch-1', 'streaming-msg', 'start-msg');
      updater.append('proj', 'inst', 'tool activity');

      await updater.finalize('proj', 'inst', undefined, 'start-msg');

      expect(messaging.updateMessage).toHaveBeenCalledWith('ch-1', 'streaming-msg', 'tool activity');
      expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', '\u2705 Done');
      expect(updater.has('proj', 'inst')).toBe(false);
    });

    it('skips finalize when originId does not match expectedMessageId', async () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'streaming-msg', 'start-msg-1');

      await updater.finalize('proj', 'inst', undefined, 'start-msg-2');

      expect(messaging.sendToChannel).not.toHaveBeenCalled();
      expect(updater.has('proj', 'inst')).toBe(true);
    });
  });

  describe('start when canStream is false', () => {
    it('does not create an entry', () => {
      const messaging = createMockMessaging(false);
      const updater = new StreamingMessageUpdater(messaging as any);

      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      expect(updater.has('proj', 'inst')).toBe(false);
    });
  });

  describe('multiple instances', () => {
    it('tracks separate entries per project/instance', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);

      updater.start('proj-a', 'inst-1', 'ch-a', 'msg-a');
      updater.start('proj-b', 'inst-2', 'ch-b', 'msg-b');

      expect(updater.has('proj-a', 'inst-1')).toBe(true);
      expect(updater.has('proj-b', 'inst-2')).toBe(true);

      updater.discard('proj-a', 'inst-1');
      expect(updater.has('proj-a', 'inst-1')).toBe(false);
      expect(updater.has('proj-b', 'inst-2')).toBe(true);
    });
  });

  describe('error resilience', () => {
    it('flush handles updateMessage rejection gracefully', async () => {
      const messaging = createMockMessaging();
      messaging.updateMessage!.mockRejectedValue(new Error('Slack API error'));
      const updater = new StreamingMessageUpdater(messaging as any);

      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'status');

      // Should not throw when debounce fires and updateMessage rejects
      vi.advanceTimersByTime(800);
      // Allow microtask queue to settle
      await vi.advanceTimersByTimeAsync(0);

      // Entry should still exist (flush failure doesn't destroy entry)
      expect(updater.has('proj', 'inst')).toBe(true);
    });

    it('finalize handles updateMessage rejection gracefully', async () => {
      const messaging = createMockMessaging();
      messaging.updateMessage!.mockRejectedValue(new Error('Slack API error'));
      const updater = new StreamingMessageUpdater(messaging as any);

      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'status');

      // Should not throw
      await updater.finalize('proj', 'inst');
      expect(updater.has('proj', 'inst')).toBe(false);
    });
  });

  describe('flushPromise race condition', () => {
    it('finalize waits for in-progress flush before posting Done', async () => {
      let resolveFlush!: () => void;
      const messaging = createMockMessaging();
      // Flush update is pending until resolveFlush() is called.
      messaging.updateMessage!
        .mockImplementationOnce(() => new Promise<void>((r) => { resolveFlush = r; }));

      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'tool activity');

      // Fire debounce → flush starts but is waiting on slow updateMessage
      vi.advanceTimersByTime(800);

      // Start finalize while flush is still pending
      const finalizePromise = updater.finalize('proj', 'inst');

      // At this point, flush's updateMessage is pending. Finalize should NOT have called yet.
      expect(messaging.updateMessage).toHaveBeenCalledTimes(1);
      expect(messaging.updateMessage).toHaveBeenCalledWith('ch-1', 'msg-1', 'tool activity');

      // Resolve the flush
      resolveFlush();
      await finalizePromise;

      // Finalize posts completion only after flush settles.
      expect(messaging.updateMessage).toHaveBeenCalledTimes(1);
      expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', '\u2705 Done');
    });

    it('finalize proceeds when flush had rejected', async () => {
      const messaging = createMockMessaging();
      // Flush rejects, finalize still resolves
      messaging.updateMessage!
        .mockRejectedValueOnce(new Error('network error'));

      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'tool activity');

      // Fire debounce → flush starts and rejects
      vi.advanceTimersByTime(800);
      await vi.advanceTimersByTimeAsync(0);

      // Finalize should still work
      await updater.finalize('proj', 'inst');

      expect(messaging.updateMessage).toHaveBeenCalledTimes(1);
      expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', '\u2705 Done');
      expect(updater.has('proj', 'inst')).toBe(false);
    });

    it('flushPromise is cleared after flush completes (no stale await)', async () => {
      const messaging = createMockMessaging();
      messaging.updateMessage!.mockResolvedValue(undefined);

      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'first');

      // Fire debounce and let flush complete
      vi.advanceTimersByTime(800);
      await vi.advanceTimersByTimeAsync(0);

      expect(messaging.updateMessage).toHaveBeenCalledTimes(1);

      // Now finalize should NOT be blocked by a stale flushPromise
      await updater.finalize('proj', 'inst');

      expect(messaging.updateMessage).toHaveBeenCalledTimes(1);
      expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', '\u2705 Done');
    });
  });

  describe('append after discard', () => {
    it('returns false after discard', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.discard('proj', 'inst');

      expect(updater.append('proj', 'inst', 'late text')).toBe(false);
    });
  });

  describe('discard', () => {
    it('removes entry and cancels timer', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'tool 1');

      updater.discard('proj', 'inst');

      expect(updater.has('proj', 'inst')).toBe(false);

      // Advance past debounce — should not trigger update
      vi.advanceTimersByTime(1000);
      expect(messaging.updateMessage).not.toHaveBeenCalled();
    });

    it('is a no-op when no entry exists', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);

      // Should not throw
      updater.discard('proj', 'inst');
    });
  });
});

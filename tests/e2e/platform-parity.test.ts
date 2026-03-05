/**
 * E2E tests for Discord/Slack platform parity.
 *
 * Verifies that shared behaviors work identically on both platforms, and
 * that platform-specific behaviors (message splitting limits, markdown
 * conversion) differ exactly as designed.
 *
 * Strategy: describe.each(['discord', 'slack']) runs identical scenarios
 * against a real BridgeHookServer wired with platform-specific mock messaging.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startFullHookServer,
  postEvent,
  waitForCalls,
  getChannelMessages,
  type FullHookServerResult,
} from './e2e-helpers.js';

// ---------------------------------------------------------------------------
// Shared behaviors: identical on both platforms
// ---------------------------------------------------------------------------

describe('Multi-Platform Parity', () => {
  describe.each(['discord', 'slack'] as const)('Platform: %s', (platform) => {
    let ctx: FullHookServerResult;

    beforeEach(async () => {
      ctx = await startFullHookServer({
        projectName: 'test-proj',
        channelId: 'ch-1',
        platform,
      });
    });

    afterEach(() => {
      ctx.server.stop();
    });

    // -----------------------------------------------------------------------
    // session.idle text delivery
    // -----------------------------------------------------------------------

    it('session.idle response text is posted to channel', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'session.idle',
        agentType: 'claude',
        text: 'Hello from agent',
      });

      await waitForCalls(ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>, 1);
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.some((m) => m.includes('Hello from agent'))).toBe(true);
    });

    it('session.idle with no text posts nothing to channel', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      const res = await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'session.idle',
        agentType: 'claude',
        // text intentionally omitted
      });

      expect(res.status).toBe(200);
      // Give the pipeline time to run
      await new Promise((r) => setTimeout(r, 150));
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.length).toBe(0);
    });

    it('session.idle with whitespace-only text posts nothing to channel', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'session.idle',
        agentType: 'claude',
        text: '   \n  ',
      });

      await new Promise((r) => setTimeout(r, 150));
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.length).toBe(0);
    });

    // -----------------------------------------------------------------------
    // Pending tracker reaction lifecycle
    // -----------------------------------------------------------------------

    it('pending tracker adds hourglass reaction via platform messaging', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      expect(ctx.messaging.addReactionToMessage).toHaveBeenCalledWith(
        'ch-1',
        'user-msg-1',
        '⏳',
      );
    });

    it('pending tracker replaces hourglass with checkmark on completion', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      await ctx.pendingTracker.markCompleted('test-proj', 'claude');
      expect(ctx.messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith(
        'ch-1',
        'user-msg-1',
        '⏳',
        '✅',
      );
    });

    it('pending tracker replaces hourglass with cross on error', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      await ctx.pendingTracker.markError('test-proj', 'claude');
      expect(ctx.messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith(
        'ch-1',
        'user-msg-1',
        '⏳',
        '❌',
      );
    });

    // -----------------------------------------------------------------------
    // Start message creation (streaming updater)
    // -----------------------------------------------------------------------

    it('tool.activity triggers start message creation via sendToChannelWithId', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'tool.activity',
        agentType: 'claude',
        text: 'Working...',
      });

      await waitForCalls(
        ctx.messaging.sendToChannelWithId as ReturnType<typeof vi.fn>,
        1,
      );
      // Start message format is now "Prompt (agent)" rather than "Processing"
      expect(ctx.messaging.sendToChannelWithId).toHaveBeenCalledWith(
        'ch-1',
        expect.stringContaining('Prompt'),
      );
    });

    it('start message is created only once for multiple tool.activity events', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');

      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'tool.activity',
        agentType: 'claude',
        text: 'Step 1',
      });
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'tool.activity',
        agentType: 'claude',
        text: 'Step 2',
      });

      // Wait long enough for both events to complete.
      // The first tool.activity triggers 2 sendToChannelWithId calls:
      // 1) ensureStartMessage (📝 Prompt) and 2) a separate streaming message (⏳ Working...).
      await waitForCalls(
        ctx.messaging.sendToChannelWithId as ReturnType<typeof vi.fn>,
        2,
      );
      await new Promise((r) => setTimeout(r, 150));

      // Exactly two sendToChannelWithId calls: start message + streaming message.
      // The second tool.activity reuses both — no additional calls.
      const withIdCalls = (ctx.messaging.sendToChannelWithId as ReturnType<typeof vi.fn>).mock
        .calls.length;
      expect(withIdCalls).toBe(2);
    });

    // -----------------------------------------------------------------------
    // session.error handler
    // -----------------------------------------------------------------------

    it('session.error posts an error message to channel', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'session.error',
        agentType: 'claude',
        text: 'Something went wrong',
      });

      await waitForCalls(ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>, 1);
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.some((m) => m.includes('Something went wrong'))).toBe(true);
    });

    it('session.error replaces reaction with error emoji', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'session.error',
        agentType: 'claude',
        text: 'Crash',
      });

      await waitForCalls(
        ctx.messaging.replaceOwnReactionOnMessage as ReturnType<typeof vi.fn>,
        1,
      );
      expect(ctx.messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith(
        'ch-1',
        'user-msg-1',
        '⏳',
        '❌',
      );
    });

    // -----------------------------------------------------------------------
    // session.start / session.end handlers
    // -----------------------------------------------------------------------

    it('session.start posts a session started message', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'session.start',
        agentType: 'claude',
        source: 'user',
      });

      await waitForCalls(ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>, 1);
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.some((m) => m.toLowerCase().includes('session started'))).toBe(true);
    });

    it('session.start from startup source posts nothing', async () => {
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'session.start',
        agentType: 'claude',
        source: 'startup',
      });

      await new Promise((r) => setTimeout(r, 150));
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.length).toBe(0);
    });

    it('session.end posts a session ended message', async () => {
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'session.end',
        agentType: 'claude',
        reason: 'user_request',
      });

      await waitForCalls(ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>, 1);
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.some((m) => m.toLowerCase().includes('session ended'))).toBe(true);
    });

    // -----------------------------------------------------------------------
    // HTTP-level behavior is platform-agnostic
    // -----------------------------------------------------------------------

    it('unknown event type returns 200 and produces no channel message', async () => {
      const res = await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'unknown.event.type',
        agentType: 'claude',
      });

      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 150));
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.length).toBe(0);
    });

    it('missing projectName returns 400', async () => {
      const res = await postEvent(ctx.port, {
        type: 'session.idle',
        agentType: 'claude',
      });
      expect(res.status).toBe(400);
    });

    it('unknown projectName returns 400', async () => {
      const res = await postEvent(ctx.port, {
        projectName: 'no-such-project',
        type: 'session.idle',
        agentType: 'claude',
      });
      expect(res.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Platform-specific message splitting limits
  // ---------------------------------------------------------------------------

  describe('Platform-specific limits', () => {
    it('splitAndSendToChannel uses splitForDiscord (1900 chars) for discord', async () => {
      const ctx = await startFullHookServer({
        platform: 'discord',
        projectName: 'test-proj',
        channelId: 'ch-1',
      });
      try {
        await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');

        // Build a multiline text where each line is ~960 chars.
        // The Discord chunk budget is 1890 (1900 - 10 for chunk suffix).
        // Two 960-char lines joined by a newline total 1921 chars, which exceeds
        // the 1890 budget, causing the splitter to produce 2 messages.
        // The Slack budget is 3890, so the same text fits in one Slack message.
        const line960 = 'A'.repeat(960);
        const longText = [line960, line960].join('\n');
        await postEvent(ctx.port, {
          projectName: 'test-proj',
          type: 'session.idle',
          agentType: 'claude',
          text: longText,
        });

        await waitForCalls(ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>, 2, 5000);
        const sendCalls = (ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>).mock.calls
          .filter((c: unknown[]) => c[0] === 'ch-1');
        expect(sendCalls.length).toBeGreaterThanOrEqual(2);
      } finally {
        ctx.server.stop();
      }
    });

    it('splitAndSendToChannel uses splitForSlack (3900 chars) for slack', async () => {
      const ctx = await startFullHookServer({
        platform: 'slack',
        projectName: 'test-proj',
        channelId: 'ch-1',
      });
      try {
        await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');

        // Two 960-char lines: 1921 chars total — exceeds Discord's 1890 budget (would split)
        // but fits within Slack's 3890 budget (stays as one message).
        // This is the key parity divergence: same text, different outcome per platform.
        const line960 = 'B'.repeat(960);
        const longText = [line960, line960].join('\n');
        await postEvent(ctx.port, {
          projectName: 'test-proj',
          type: 'session.idle',
          agentType: 'claude',
          text: longText,
        });

        await waitForCalls(ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>, 1, 5000);
        // Allow time for any second call that would indicate incorrect splitting
        await new Promise((r) => setTimeout(r, 200));
        const sendCalls = (ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>).mock.calls
          .filter((c: unknown[]) => c[0] === 'ch-1');
        expect(sendCalls.length).toBe(1);
      } finally {
        ctx.server.stop();
      }
    });

    it('discord splits text longer than 3900 chars into multiple messages', async () => {
      const ctx = await startFullHookServer({
        platform: 'discord',
        projectName: 'test-proj',
        channelId: 'ch-1',
      });
      try {
        await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');

        // Five 960-char lines: 5 * 960 + 4 newlines = 4804 chars total.
        // Exceeds both Discord's 1890 budget and Slack's 3890 budget.
        // Discord must produce at least 3 chunks (every ~1890 chars).
        const line960 = 'C'.repeat(960);
        const longText = [line960, line960, line960, line960, line960].join('\n');
        await postEvent(ctx.port, {
          projectName: 'test-proj',
          type: 'session.idle',
          agentType: 'claude',
          text: longText,
        });

        await waitForCalls(ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>, 2, 5000);
        const sendCalls = (ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>).mock.calls
          .filter((c: unknown[]) => c[0] === 'ch-1');
        expect(sendCalls.length).toBeGreaterThanOrEqual(2);
      } finally {
        ctx.server.stop();
      }
    });

    it('slack splits text longer than 3900 chars into multiple messages', async () => {
      const ctx = await startFullHookServer({
        platform: 'slack',
        projectName: 'test-proj',
        channelId: 'ch-1',
      });
      try {
        await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');

        // Five 960-char lines: total 4804 chars, exceeds Slack's 3890 budget.
        // Slack must also split into at least 2 messages.
        const line960 = 'D'.repeat(960);
        const longText = [line960, line960, line960, line960, line960].join('\n');
        await postEvent(ctx.port, {
          projectName: 'test-proj',
          type: 'session.idle',
          agentType: 'claude',
          text: longText,
        });

        await waitForCalls(ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>, 2, 5000);
        const sendCalls = (ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>).mock.calls
          .filter((c: unknown[]) => c[0] === 'ch-1');
        expect(sendCalls.length).toBeGreaterThanOrEqual(2);
      } finally {
        ctx.server.stop();
      }
    });

    it('text fitting within both limits sends exactly one message on both platforms', async () => {
      for (const platform of ['discord', 'slack'] as const) {
        const ctx = await startFullHookServer({
          platform,
          projectName: 'test-proj',
          channelId: 'ch-1',
        });
        try {
          await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');

          // 1000 chars: well under both Discord (1900) and Slack (3900) limits
          const shortText = 'E'.repeat(1000);
          await postEvent(ctx.port, {
            projectName: 'test-proj',
            type: 'session.idle',
            agentType: 'claude',
            text: shortText,
          });

          await waitForCalls(ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>, 1, 5000);
          await new Promise((r) => setTimeout(r, 150));
          const sendCalls = (ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>).mock.calls
            .filter((c: unknown[]) => c[0] === 'ch-1');
          expect(sendCalls.length).toBe(1);
        } finally {
          ctx.server.stop();
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Reaction emoji handling
  // ---------------------------------------------------------------------------

  describe('Reaction emoji handling', () => {
    it('both platforms handle Unicode brain emoji in addReactionToMessage from thinking.start', async () => {
      for (const platform of ['discord', 'slack'] as const) {
        const ctx = await startFullHookServer({
          platform,
          projectName: 'test-proj',
          channelId: 'ch-1',
        });
        try {
          // markPending sets up the pending entry with messageId='user-msg-1'
          // so that thinking.start can attach the reaction to the original message
          await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');

          await postEvent(ctx.port, {
            projectName: 'test-proj',
            type: 'thinking.start',
            agentType: 'claude',
          });

          // Two addReactionToMessage calls: ⏳ from markPending + 🧠 from thinking.start
          await waitForCalls(
            ctx.messaging.addReactionToMessage as ReturnType<typeof vi.fn>,
            2,
          );
          expect(ctx.messaging.addReactionToMessage).toHaveBeenCalledWith(
            'ch-1',
            'user-msg-1',
            '🧠',
          );
        } finally {
          ctx.server.stop();
        }
      }
    });

    it('both platforms replace brain with checkmark on thinking.stop', async () => {
      for (const platform of ['discord', 'slack'] as const) {
        const ctx = await startFullHookServer({
          platform,
          projectName: 'test-proj',
          channelId: 'ch-1',
        });
        try {
          await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');

          await postEvent(ctx.port, {
            projectName: 'test-proj',
            type: 'thinking.start',
            agentType: 'claude',
          });
          await postEvent(ctx.port, {
            projectName: 'test-proj',
            type: 'thinking.stop',
            agentType: 'claude',
          });

          await waitForCalls(
            ctx.messaging.replaceOwnReactionOnMessage as ReturnType<typeof vi.fn>,
            1,
          );
          expect(ctx.messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith(
            'ch-1',
            'user-msg-1',
            '🧠',
            '✅',
          );
        } finally {
          ctx.server.stop();
        }
      }
    });

    it('both platforms replace hourglass with question mark when session.idle has a prompt', async () => {
      for (const platform of ['discord', 'slack'] as const) {
        const ctx = await startFullHookServer({
          platform,
          projectName: 'test-proj',
          channelId: 'ch-1',
        });
        try {
          await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');

          await postEvent(ctx.port, {
            projectName: 'test-proj',
            type: 'session.idle',
            agentType: 'claude',
            text: 'Do you want to proceed?',
            promptText: 'Please choose an option.',
          });

          await waitForCalls(
            ctx.messaging.replaceOwnReactionOnMessage as ReturnType<typeof vi.fn>,
            1,
          );
          // Prompt present: hourglass replaced with question mark (not checkmark)
          expect(ctx.messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith(
            'ch-1',
            'user-msg-1',
            '⏳',
            '❓',
          );
        } finally {
          ctx.server.stop();
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Markdown conversion: Slack converts bold/links, Discord does not
  // ---------------------------------------------------------------------------

  describe('Markdown handling', () => {
    it('slack converts markdown bold (**text**) to mrkdwn (*text*) in channel messages', async () => {
      const ctx = await startFullHookServer({
        platform: 'slack',
        projectName: 'test-proj',
        channelId: 'ch-1',
      });
      try {
        await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
        await postEvent(ctx.port, {
          projectName: 'test-proj',
          type: 'session.idle',
          agentType: 'claude',
          text: 'Hello **world**',
        });

        await waitForCalls(ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>, 1);
        const messages = getChannelMessages(ctx.messaging, 'ch-1');
        // Slack mrkdwn uses single asterisks for bold
        expect(messages.some((m) => m.includes('*world*') && !m.includes('**world**'))).toBe(true);
      } finally {
        ctx.server.stop();
      }
    });

    it('discord preserves markdown bold (**text**) as-is in channel messages', async () => {
      const ctx = await startFullHookServer({
        platform: 'discord',
        projectName: 'test-proj',
        channelId: 'ch-1',
      });
      try {
        await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
        await postEvent(ctx.port, {
          projectName: 'test-proj',
          type: 'session.idle',
          agentType: 'claude',
          text: 'Hello **world**',
        });

        await waitForCalls(ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>, 1);
        const messages = getChannelMessages(ctx.messaging, 'ch-1');
        // Discord keeps standard markdown bold
        expect(messages.some((m) => m.includes('**world**'))).toBe(true);
      } finally {
        ctx.server.stop();
      }
    });

    it('slack converts markdown links to mrkdwn format', async () => {
      const ctx = await startFullHookServer({
        platform: 'slack',
        projectName: 'test-proj',
        channelId: 'ch-1',
      });
      try {
        await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
        await postEvent(ctx.port, {
          projectName: 'test-proj',
          type: 'session.idle',
          agentType: 'claude',
          text: 'See [the docs](https://example.com) for details',
        });

        await waitForCalls(ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>, 1);
        const messages = getChannelMessages(ctx.messaging, 'ch-1');
        // Slack mrkdwn link format: <url|text>
        expect(
          messages.some((m) => m.includes('<https://example.com|the docs>')),
        ).toBe(true);
      } finally {
        ctx.server.stop();
      }
    });

    it('discord preserves markdown link syntax as-is', async () => {
      const ctx = await startFullHookServer({
        platform: 'discord',
        projectName: 'test-proj',
        channelId: 'ch-1',
      });
      try {
        await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
        await postEvent(ctx.port, {
          projectName: 'test-proj',
          type: 'session.idle',
          agentType: 'claude',
          text: 'See [the docs](https://example.com) for details',
        });

        await waitForCalls(ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>, 1);
        const messages = getChannelMessages(ctx.messaging, 'ch-1');
        // Discord renders standard markdown links natively
        expect(
          messages.some((m) => m.includes('[the docs](https://example.com)')),
        ).toBe(true);
      } finally {
        ctx.server.stop();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Streaming updater debounce: shared behavior across platforms
  // ---------------------------------------------------------------------------

  describe('Streaming updater debounce', () => {
    it.each(['discord', 'slack'] as const)(
      '%s: updateMessage is called after 750ms debounce from tool.activity',
      async (platform) => {
        const ctx = await startFullHookServer({
          platform,
          projectName: 'test-proj',
          channelId: 'ch-1',
        });
        try {
          await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');

          await postEvent(ctx.port, {
            projectName: 'test-proj',
            type: 'tool.activity',
            agentType: 'claude',
            text: 'Running tool',
          });

          // Wait for start message creation first
          await waitForCalls(
            ctx.messaging.sendToChannelWithId as ReturnType<typeof vi.fn>,
            1,
          );

          // updateMessage should not have fired yet (debounce is 750ms)
          const updateBefore = (ctx.messaging.updateMessage as ReturnType<typeof vi.fn>).mock
            .calls.length;

          // Wait past the 750ms debounce window
          await new Promise((r) => setTimeout(r, 900));

          const updateAfter = (ctx.messaging.updateMessage as ReturnType<typeof vi.fn>).mock
            .calls.length;
          expect(updateAfter).toBeGreaterThan(updateBefore);
          expect(ctx.messaging.updateMessage).toHaveBeenCalledWith(
            'ch-1',
            expect.any(String),
            expect.stringContaining('Running tool'),
          );
        } finally {
          ctx.server.stop();
        }
      },
    );

    it.each(['discord', 'slack'] as const)(
      '%s: rapid tool.activity events collapse into a single updateMessage call',
      async (platform) => {
        const ctx = await startFullHookServer({
          platform,
          projectName: 'test-proj',
          channelId: 'ch-1',
        });
        try {
          await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');

          // Fire multiple activity events in rapid succession (well within 750ms)
          await postEvent(ctx.port, {
            projectName: 'test-proj',
            type: 'tool.activity',
            agentType: 'claude',
            text: 'Step A',
          });
          await postEvent(ctx.port, {
            projectName: 'test-proj',
            type: 'tool.activity',
            agentType: 'claude',
            text: 'Step B',
          });
          await postEvent(ctx.port, {
            projectName: 'test-proj',
            type: 'tool.activity',
            agentType: 'claude',
            text: 'Step C',
          });

          // Wait for start message
          await waitForCalls(
            ctx.messaging.sendToChannelWithId as ReturnType<typeof vi.fn>,
            1,
          );

          // Snapshot call count before debounce fires
          const beforeDebounce = (ctx.messaging.updateMessage as ReturnType<typeof vi.fn>).mock
            .calls.length;

          // Wait past the debounce window
          await new Promise((r) => setTimeout(r, 1000));

          const afterDebounce = (ctx.messaging.updateMessage as ReturnType<typeof vi.fn>).mock
            .calls.length;

          // Only one updateMessage call should have fired (debounce collapses rapid events)
          expect(afterDebounce - beforeDebounce).toBe(1);
          // The final text should include the full cumulative history.
          const lastCall = (ctx.messaging.updateMessage as ReturnType<typeof vi.fn>).mock
            .calls.at(-1);
          expect(lastCall?.[2]).toContain('Step A');
          expect(lastCall?.[2]).toContain('Step B');
          expect(lastCall?.[2]).toContain('Step C');
        } finally {
          ctx.server.stop();
        }
      },
    );
  });

  // ---------------------------------------------------------------------------
  // session.idle finalizes the streaming updater
  // ---------------------------------------------------------------------------

  describe('session.idle finalizes streaming', () => {
    it.each(['discord', 'slack'] as const)(
      '%s: session.idle after tool.activity posts a Done message',
      async (platform) => {
        const ctx = await startFullHookServer({
          platform,
          projectName: 'test-proj',
          channelId: 'ch-1',
        });
        try {
          await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');

          // Trigger start message creation
          await postEvent(ctx.port, {
            projectName: 'test-proj',
            type: 'tool.activity',
            agentType: 'claude',
            text: 'Working',
          });
          await waitForCalls(
            ctx.messaging.sendToChannelWithId as ReturnType<typeof vi.fn>,
            1,
          );

          // Now send session.idle to finalize
          await postEvent(ctx.port, {
            projectName: 'test-proj',
            type: 'session.idle',
            agentType: 'claude',
            text: 'Final output',
          });

          // finalize posts a channel message with "✅ Done" (or a usage summary)
          await waitForCalls(ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>, 1, 5000);
          const messages = getChannelMessages(ctx.messaging, 'ch-1');
          expect(messages.some((m) => /✅/.test(m))).toBe(true);
        } finally {
          ctx.server.stop();
        }
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Auto-created pending entry (tmux-initiated prompts, no prior markPending)
  // ---------------------------------------------------------------------------

  describe('Auto-created pending entry', () => {
    it.each(['discord', 'slack'] as const)(
      '%s: tool.activity without prior markPending auto-creates a pending entry (no start message without prompt)',
      async (platform) => {
        const ctx = await startFullHookServer({
          platform,
          projectName: 'test-proj',
          channelId: 'ch-1',
        });
        try {
          // Do NOT call markPending — the pipeline auto-creates via ensurePending.
          // However, since there is no messageId and no prompt preview, the start
          // message is intentionally skipped (source-less turn without prompt text).
          await postEvent(ctx.port, {
            projectName: 'test-proj',
            type: 'tool.activity',
            agentType: 'claude',
            text: 'Auto-created entry',
          });

          // Allow time for the pipeline to run
          await new Promise((r) => setTimeout(r, 300));

          // The streaming updater still records the activity even though
          // no visible start message is sent (no sendToChannelWithId call).
          const withIdCalls = (ctx.messaging.sendToChannelWithId as ReturnType<typeof vi.fn>).mock
            .calls.length;
          expect(withIdCalls).toBe(0);
        } finally {
          ctx.server.stop();
        }
      },
    );

    it.each(['discord', 'slack'] as const)(
      '%s: session.idle without prior markPending auto-creates entry and delivers text',
      async (platform) => {
        const ctx = await startFullHookServer({
          platform,
          projectName: 'test-proj',
          channelId: 'ch-1',
        });
        try {
          // Do NOT call markPending
          await postEvent(ctx.port, {
            projectName: 'test-proj',
            type: 'session.idle',
            agentType: 'claude',
            text: 'Auto response',
          });

          await waitForCalls(ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>, 1);
          const messages = getChannelMessages(ctx.messaging, 'ch-1');
          expect(messages.some((m) => m.includes('Auto response'))).toBe(true);
        } finally {
          ctx.server.stop();
        }
      },
    );
  });

  // ---------------------------------------------------------------------------
  // permission.request handler: platform-agnostic
  // ---------------------------------------------------------------------------

  describe('permission.request handler', () => {
    it.each(['discord', 'slack'] as const)(
      '%s: permission.request posts a permission needed message',
      async (platform) => {
        const ctx = await startFullHookServer({
          platform,
          projectName: 'test-proj',
          channelId: 'ch-1',
        });
        try {
          await postEvent(ctx.port, {
            projectName: 'test-proj',
            type: 'permission.request',
            agentType: 'claude',
            toolName: 'bash',
            toolInput: 'rm -rf /tmp/test',
          });

          await waitForCalls(ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>, 1);
          const messages = getChannelMessages(ctx.messaging, 'ch-1');
          expect(messages.some((m) => m.includes('Permission needed') || m.includes('permission'))).toBe(true);
          expect(messages.some((m) => m.includes('bash'))).toBe(true);
        } finally {
          ctx.server.stop();
        }
      },
    );
  });
});

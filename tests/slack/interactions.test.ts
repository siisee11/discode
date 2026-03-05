import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SlackInteractions } from '../../src/slack/interactions.js';

function createMockApp() {
  return {
    client: {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '200.000' }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      conversations: {
        history: vi.fn().mockResolvedValue({ messages: [] }),
      },
    },
    action: vi.fn(),
  } as any;
}

function createMockChannels() {
  return {
    getChannelMapping: vi.fn().mockReturnValue(
      new Map([['C001', { projectName: 'proj', agentType: 'opencode' }]]),
    ),
    lastSeenTs: new Map([['C001', '123.000']]),
  } as any;
}

describe('SlackInteractions', () => {
  let app: ReturnType<typeof createMockApp>;
  let mockChannels: ReturnType<typeof createMockChannels>;
  let interactions: SlackInteractions;
  const token = 'xoxb-test-token';

  beforeEach(() => {
    app = createMockApp();
    mockChannels = createMockChannels();
    interactions = new SlackInteractions(app, token, mockChannels);
  });

  describe('sendApprovalRequest', () => {
    it('posts a message with approval blocks', async () => {
      // Do not await the full promise since it blocks on action handlers;
      // just verify the postMessage call was made.
      const promise = interactions.sendApprovalRequest('C001', 'bash', { cmd: 'ls' });

      // Allow the initial postMessage to resolve
      await vi.waitFor(() => {
        expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
      });

      const call = app.client.chat.postMessage.mock.calls[0][0];
      expect(call.token).toBe(token);
      expect(call.channel).toBe('C001');
      expect(call.text).toContain('bash');
      expect(call.blocks).toHaveLength(2);
      expect(call.blocks[0].type).toBe('section');
      expect(call.blocks[1].type).toBe('actions');

      // Verify action handlers were registered with unique IDs
      expect(app.action).toHaveBeenCalledTimes(2);
      const approveCall = app.action.mock.calls.find((c: any[]) => typeof c[0] === 'string' && c[0].startsWith('approve_'));
      const denyCall = app.action.mock.calls.find((c: any[]) => typeof c[0] === 'string' && c[0].startsWith('deny_'));
      expect(approveCall).toBeDefined();
      expect(denyCall).toBeDefined();

      // Clean up: simulate an action to resolve the pending promise
      const approveHandler = approveCall![1];
      await approveHandler({
        action: { value: 'approve' },
        ack: vi.fn(),
        respond: vi.fn().mockResolvedValue(undefined),
      });

      expect(await promise).toBe(true);
    });

    it('returns false when postMessage returns no ts', async () => {
      app.client.chat.postMessage.mockResolvedValueOnce({ ts: undefined });

      const result = await interactions.sendApprovalRequest('C001', 'bash', {});
      expect(result).toBe(false);
    });

    it('truncates long tool input in the preview', async () => {
      const longInput = 'x'.repeat(600);

      const promise = interactions.sendApprovalRequest('C001', 'bash', longInput);

      await vi.waitFor(() => {
        expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
      });

      const call = app.client.chat.postMessage.mock.calls[0][0];
      const blockText = call.blocks[0].text.text;
      expect(blockText).toContain('...');

      // Clean up
      const handler = app.action.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].startsWith('deny_'),
      )![1];
      await handler({
        action: { value: 'deny' },
        ack: vi.fn(),
        respond: vi.fn().mockResolvedValue(undefined),
      });

      expect(await promise).toBe(false);
    });
  });

  describe('sendQuestionWithButtons', () => {
    it('returns null for empty questions array', async () => {
      const result = await interactions.sendQuestionWithButtons('C001', []);
      expect(result).toBeNull();
      expect(app.client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('posts a message with question blocks and option buttons', async () => {
      const questions = [
        {
          question: 'Pick a color',
          header: 'Color Choice',
          options: [
            { label: 'Red', description: 'A warm color' },
            { label: 'Blue', description: 'A cool color' },
          ],
        },
      ];

      const promise = interactions.sendQuestionWithButtons('C001', questions);

      await vi.waitFor(() => {
        expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
      });

      const call = app.client.chat.postMessage.mock.calls[0][0];
      expect(call.token).toBe(token);
      expect(call.channel).toBe('C001');
      expect(call.text).toBe('Pick a color');
      // Should have section block, description fields block, and actions block
      expect(call.blocks.length).toBeGreaterThanOrEqual(2);

      // Verify action handlers registered for each option with unique IDs
      const optCalls = app.action.mock.calls.filter((c: any[]) => typeof c[0] === 'string' && c[0].match(/^opt_[a-f0-9]+_\d+$/));
      expect(optCalls).toHaveLength(2);

      // Clean up: simulate selecting the first option
      const handler = optCalls.find((c: any[]) => c[0].endsWith('_0'))![1];
      await handler({
        action: { value: 'Red' },
        ack: vi.fn(),
      });

      expect(await promise).toBe('Red');
    });

    it('returns null when postMessage returns no ts', async () => {
      app.client.chat.postMessage.mockResolvedValueOnce({ ts: undefined });

      const questions = [
        {
          question: 'Pick one',
          options: [{ label: 'A' }],
        },
      ];

      const result = await interactions.sendQuestionWithButtons('C001', questions);
      expect(result).toBeNull();
    });

    it('calls onAnswer callback with label and option index', async () => {
      const questions = [
        {
          question: 'Pick a color',
          options: [
            { label: 'Red' },
            { label: 'Blue' },
            { label: 'Green' },
          ],
        },
      ];

      const onAnswer = vi.fn().mockResolvedValue(undefined);
      const promise = interactions.sendQuestionWithButtons('C001', questions, undefined, onAnswer);

      await vi.waitFor(() => {
        expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
      });

      // Find the handler for option index 2 (Green)
      const optCalls = app.action.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].match(/^opt_[a-f0-9]+_\d+$/),
      );
      const handler2 = optCalls.find((c: any[]) => c[0].endsWith('_2'))![1];
      await handler2({
        action: { value: 'Green' },
        ack: vi.fn(),
      });

      const result = await promise;
      expect(result).toBe('Green');
      expect(onAnswer).toHaveBeenCalledWith('Green', 2);
    });

    it('handles sequential multi-question flow with onAnswer', async () => {
      // For sequential questions, each postMessage call resolves and the action
      // handler is called in order. We simulate this by queuing mock behaviors.
      let postCount = 0;
      app.client.chat.postMessage.mockImplementation(async () => {
        postCount++;
        return { ts: `${200 + postCount}.000` };
      });

      const questions = [
        { question: 'Q1?', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Q2?', options: [{ label: 'X' }, { label: 'Y' }] },
      ];

      const answers: Array<{ label: string; index: number }> = [];
      const onAnswer = vi.fn(async (label: string, index: number) => {
        answers.push({ label, index });
      });

      const promise = interactions.sendQuestionWithButtons('C001', questions, undefined, onAnswer);

      // Wait for the first question to be posted
      await vi.waitFor(() => {
        expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
      });

      // Select option B (index 1) for Q1
      const q1Calls = app.action.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].match(/^opt_[a-f0-9]+_1$/),
      );
      const q1Handler = q1Calls[0][1];
      await q1Handler({ action: { value: 'B' }, ack: vi.fn() });

      // Wait for second question
      await vi.waitFor(() => {
        expect(app.client.chat.postMessage).toHaveBeenCalledTimes(2);
      });

      // Select option X (index 0) for Q2
      const q2Calls = app.action.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].match(/^opt_[a-f0-9]+_0$/),
      );
      // The second _0 handler belongs to Q2
      const q2Handler = q2Calls[q2Calls.length - 1][1];
      await q2Handler({ action: { value: 'X' }, ack: vi.fn() });

      const result = await promise;
      expect(result).toBe('B\nX');
      expect(onAnswer).toHaveBeenCalledTimes(2);
      expect(answers[0]).toEqual({ label: 'B', index: 1 });
      expect(answers[1]).toEqual({ label: 'X', index: 0 });
    });
  });

  describe('sendSubmitConfirmation', () => {
    it('returns true when Submit is clicked', async () => {
      const summary = [
        { question: 'Color', answer: 'Red' },
        { question: 'Size', answer: 'Large' },
      ];

      const promise = interactions.sendSubmitConfirmation('C001', summary);

      await vi.waitFor(() => {
        expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
      });

      // Verify message contains summary
      const call = app.client.chat.postMessage.mock.calls[0][0];
      expect(call.text).toContain('Submit answers');

      // Find approve handler (submit)
      const approveCall = app.action.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].startsWith('approve_'),
      );
      expect(approveCall).toBeDefined();

      await approveCall![1]({
        action: { value: 'submit' },
        ack: vi.fn(),
        respond: vi.fn().mockResolvedValue(undefined),
      });

      expect(await promise).toBe(true);
    });

    it('returns false when Cancel is clicked', async () => {
      const summary = [{ question: 'Q', answer: 'A' }];

      const promise = interactions.sendSubmitConfirmation('C001', summary);

      await vi.waitFor(() => {
        expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
      });

      const denyCall = app.action.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].startsWith('deny_'),
      );
      expect(denyCall).toBeDefined();

      await denyCall![1]({
        action: { value: 'cancel' },
        ack: vi.fn(),
        respond: vi.fn().mockResolvedValue(undefined),
      });

      expect(await promise).toBe(false);
    });

    it('returns false when postMessage returns no ts', async () => {
      app.client.chat.postMessage.mockResolvedValueOnce({ ts: undefined });

      const result = await interactions.sendSubmitConfirmation('C001', [
        { question: 'Q', answer: 'A' },
      ]);
      expect(result).toBe(false);
    });
  });

  describe('pollMissedMessages', () => {
    it('returns early when messageCallback is undefined', async () => {
      await interactions.pollMissedMessages(undefined, vi.fn());

      expect(app.client.conversations.history).not.toHaveBeenCalled();
    });

    it('calls conversations.history for each mapped channel', async () => {
      const messageCallback = vi.fn();
      const handleIncoming = vi.fn();

      await interactions.pollMissedMessages(messageCallback, handleIncoming);

      expect(app.client.conversations.history).toHaveBeenCalledWith({
        token,
        channel: 'C001',
        oldest: '123.000',
        limit: 20,
      });
    });

    it('dispatches messages in chronological order via handleIncomingMessage', async () => {
      app.client.conversations.history.mockResolvedValueOnce({
        messages: [
          { ts: '125.000', text: 'newer' },
          { ts: '124.000', text: 'older' },
        ],
      });

      const messageCallback = vi.fn();
      const handleIncoming = vi.fn();

      await interactions.pollMissedMessages(messageCallback, handleIncoming);

      // Messages should be dispatched in reverse order (oldest first)
      expect(handleIncoming).toHaveBeenCalledTimes(2);
      expect(handleIncoming.mock.calls[0][0]).toEqual(
        expect.objectContaining({ ts: '124.000', text: 'older', channel: 'C001' }),
      );
      expect(handleIncoming.mock.calls[1][0]).toEqual(
        expect.objectContaining({ ts: '125.000', text: 'newer', channel: 'C001' }),
      );
    });

    it('skips the message with ts equal to oldest (already seen)', async () => {
      app.client.conversations.history.mockResolvedValueOnce({
        messages: [
          { ts: '124.000', text: 'new' },
          { ts: '123.000', text: 'already seen' },
        ],
      });

      const messageCallback = vi.fn();
      const handleIncoming = vi.fn();

      await interactions.pollMissedMessages(messageCallback, handleIncoming);

      expect(handleIncoming).toHaveBeenCalledTimes(1);
      expect(handleIncoming.mock.calls[0][0].ts).toBe('124.000');
    });

    it('skips channels without a lastSeenTs entry', async () => {
      mockChannels.getChannelMapping.mockReturnValue(
        new Map([
          ['C001', { projectName: 'proj', agentType: 'opencode' }],
          ['C002', { projectName: 'proj', agentType: 'claude' }],
        ]),
      );
      // Only C001 has a lastSeenTs; C002 does not
      mockChannels.lastSeenTs = new Map([['C001', '123.000']]);

      const messageCallback = vi.fn();
      const handleIncoming = vi.fn();

      await interactions.pollMissedMessages(messageCallback, handleIncoming);

      expect(app.client.conversations.history).toHaveBeenCalledTimes(1);
      expect(app.client.conversations.history).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C001' }),
      );
    });

    it('does not throw when conversations.history fails', async () => {
      app.client.conversations.history.mockRejectedValueOnce(new Error('api error'));

      const messageCallback = vi.fn();
      const handleIncoming = vi.fn();

      await expect(
        interactions.pollMissedMessages(messageCallback, handleIncoming),
      ).resolves.toBeUndefined();
    });
  });
});

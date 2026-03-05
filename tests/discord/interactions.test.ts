/**
 * Tests for DiscordInteractions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordInteractions } from '../../src/discord/interactions.js';

vi.mock('discord.js', () => ({
  TextChannel: class {},
  ButtonBuilder: class {
    setCustomId() { return this; }
    setLabel() { return this; }
    setStyle() { return this; }
  },
  ButtonStyle: { Primary: 1, Secondary: 2 },
  ActionRowBuilder: class {
    addComponents() { return this; }
  },
  ComponentType: { Button: 2 },
  EmbedBuilder: class {
    setTitle() { return this; }
    setDescription() { return this; }
    setColor() { return this; }
    addFields() { return this; }
    setFooter() { return this; }
  },
}));

function createMockClient() {
  const client = {
    channels: { fetch: vi.fn() },
    user: { id: 'bot-user-id' },
  } as any;
  return client;
}

describe('DiscordInteractions', () => {
  let client: any;
  let interactions: DiscordInteractions;

  beforeEach(() => {
    client = createMockClient();
    interactions = new DiscordInteractions(client);
  });

  // ---------- sendApprovalRequest ----------

  describe('sendApprovalRequest', () => {
    it('returns false when the channel is not text-based', async () => {
      client.channels.fetch.mockResolvedValueOnce({ isTextBased: () => false });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await interactions.sendApprovalRequest('ch-1', 'rm', { path: '/tmp' });

      expect(result).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a text channel'));
      warnSpy.mockRestore();
    });

    it('returns false when the channel is null', async () => {
      client.channels.fetch.mockResolvedValueOnce(null);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await interactions.sendApprovalRequest('ch-1', 'rm', {});

      expect(result).toBe(false);
      warnSpy.mockRestore();
    });
  });

  // ---------- sendQuestionWithButtons ----------

  describe('sendQuestionWithButtons', () => {
    it('returns null when the channel is not text-based', async () => {
      client.channels.fetch.mockResolvedValueOnce({ isTextBased: () => false });

      const result = await interactions.sendQuestionWithButtons('ch-1', [
        { question: 'Pick one', options: [{ label: 'A' }] },
      ]);

      expect(result).toBeNull();
    });

    it('returns null when the channel is null', async () => {
      client.channels.fetch.mockResolvedValueOnce(null);

      const result = await interactions.sendQuestionWithButtons('ch-1', [
        { question: 'Pick one', options: [{ label: 'A' }] },
      ]);

      expect(result).toBeNull();
    });

    it('returns null when questions array is empty', async () => {
      const mockMessage = {
        awaitMessageComponent: vi.fn(),
      };
      const mockChannel = {
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue(mockMessage),
      };
      client.channels.fetch.mockResolvedValueOnce(mockChannel);

      const result = await interactions.sendQuestionWithButtons('ch-1', []);

      expect(result).toBeNull();
    });

    it('calls onAnswer callback with label and option index', async () => {
      const mockInteraction = {
        customId: 'opt_abc12345_1',
        update: vi.fn().mockResolvedValue(undefined),
      };
      const mockMessage = {
        awaitMessageComponent: vi.fn().mockResolvedValue(mockInteraction),
      };
      const mockChannel = {
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue(mockMessage),
      };
      client.channels.fetch.mockResolvedValueOnce(mockChannel);

      const onAnswer = vi.fn().mockResolvedValue(undefined);
      const result = await interactions.sendQuestionWithButtons(
        'ch-1',
        [{ question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }],
        undefined,
        onAnswer,
      );

      expect(result).toBe('B');
      expect(onAnswer).toHaveBeenCalledWith('B', 1);
    });

    it('handles sequential multi-question flow', async () => {
      // First question: user selects option 0
      const interaction1 = {
        customId: 'opt_abc12345_0',
        update: vi.fn().mockResolvedValue(undefined),
      };
      const message1 = {
        awaitMessageComponent: vi.fn().mockResolvedValue(interaction1),
      };

      // Second question: user selects option 2
      const interaction2 = {
        customId: 'opt_def67890_2',
        update: vi.fn().mockResolvedValue(undefined),
      };
      const message2 = {
        awaitMessageComponent: vi.fn().mockResolvedValue(interaction2),
      };

      const mockChannel = {
        isTextBased: () => true,
        send: vi.fn()
          .mockResolvedValueOnce(message1)
          .mockResolvedValueOnce(message2),
      };
      client.channels.fetch.mockResolvedValueOnce(mockChannel);

      const answers: Array<{ label: string; index: number }> = [];
      const onAnswer = vi.fn(async (label: string, index: number) => {
        answers.push({ label, index });
      });

      const result = await interactions.sendQuestionWithButtons(
        'ch-1',
        [
          { question: 'Q1?', options: [{ label: 'X' }, { label: 'Y' }] },
          { question: 'Q2?', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
        ],
        undefined,
        onAnswer,
      );

      expect(result).toBe('X\nC');
      expect(onAnswer).toHaveBeenCalledTimes(2);
      expect(answers[0]).toEqual({ label: 'X', index: 0 });
      expect(answers[1]).toEqual({ label: 'C', index: 2 });
    });
  });

  // ---------- sendSubmitConfirmation ----------

  describe('sendSubmitConfirmation', () => {
    it('returns true when Submit is clicked', async () => {
      const mockInteraction = {
        customId: 'submit',
        update: vi.fn().mockResolvedValue(undefined),
      };
      const mockMessage = {
        awaitMessageComponent: vi.fn().mockResolvedValue(mockInteraction),
      };
      const mockChannel = {
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue(mockMessage),
      };
      client.channels.fetch.mockResolvedValueOnce(mockChannel);

      const result = await interactions.sendSubmitConfirmation('ch-1', [
        { question: 'Color', answer: 'Red' },
      ]);

      expect(result).toBe(true);
    });

    it('returns false when Cancel is clicked', async () => {
      const mockInteraction = {
        customId: 'cancel',
        update: vi.fn().mockResolvedValue(undefined),
      };
      const mockMessage = {
        awaitMessageComponent: vi.fn().mockResolvedValue(mockInteraction),
      };
      const mockChannel = {
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue(mockMessage),
      };
      client.channels.fetch.mockResolvedValueOnce(mockChannel);

      const result = await interactions.sendSubmitConfirmation('ch-1', [
        { question: 'Q', answer: 'A' },
      ]);

      expect(result).toBe(false);
    });

    it('returns false when channel is not text-based', async () => {
      client.channels.fetch.mockResolvedValueOnce({ isTextBased: () => false });

      const result = await interactions.sendSubmitConfirmation('ch-1', [
        { question: 'Q', answer: 'A' },
      ]);

      expect(result).toBe(false);
    });

    it('returns false when channel is null', async () => {
      client.channels.fetch.mockResolvedValueOnce(null);

      const result = await interactions.sendSubmitConfirmation('ch-1', [
        { question: 'Q', answer: 'A' },
      ]);

      expect(result).toBe(false);
    });
  });
});

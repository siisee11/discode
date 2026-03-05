/**
 * Slack user interactions — approval requests, question buttons, polling.
 */

import { randomUUID } from 'crypto';
import type { App } from '@slack/bolt';
import type { MessageCallback } from '../messaging/interface.js';
import type { SlackChannels } from './channels.js';

function getEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.trunc(n);
}


export class SlackInteractions {
  constructor(
    private app: App,
    private botToken: string,
    private channels: SlackChannels,
  ) {}

  async sendApprovalRequest(
    channelId: string,
    toolName: string,
    toolInput: any,
    timeoutMs: number = getEnvInt('DISCODE_APPROVAL_TIMEOUT_MS', 120000),
  ): Promise<boolean> {
    const requestId = randomUUID().slice(0, 8);
    const approveId = `approve_${requestId}`;
    const denyId = `deny_${requestId}`;

    let inputPreview = '';
    if (toolInput) {
      const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput, null, 2);
      inputPreview = inputStr.length > 500 ? inputStr.substring(0, 500) + '...' : inputStr;
    }

    const result = await this.app.client.chat.postMessage({
      token: this.botToken,
      channel: channelId,
      text: `Permission Request: Tool \`${toolName}\``,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:lock: *Permission Request*\nTool: \`${toolName}\`\n\`\`\`${inputPreview}\`\`\`\n_${Math.round(timeoutMs / 1000)}s timeout, auto-deny on timeout_`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Allow' },
              style: 'primary',
              action_id: approveId,
              value: 'approve',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Deny' },
              style: 'danger',
              action_id: denyId,
              value: 'deny',
            },
          ],
        },
      ],
    });

    const messageTs = result.ts;
    if (!messageTs) return false;

    return new Promise<boolean>((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.app.client.chat.update({
          token: this.botToken,
          channel: channelId,
          ts: messageTs,
          text: `Permission Request: Tool \`${toolName}\` - Timed out`,
          blocks: [],
        }).catch(() => undefined);
        resolve(false);
      }, timeoutMs);

      const handler = async ({ action, ack, respond }: any) => {
        await ack();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const approved = action.value === 'approve';
        await respond({
          text: approved ? ':white_check_mark: *Allowed*' : ':x: *Denied*',
          replace_original: true,
        }).catch(() => undefined);
        resolve(approved);
      };

      this.app.action(approveId, handler);
      this.app.action(denyId, handler);
    });
  }

  async sendQuestionWithButtons(
    channelId: string,
    questions: Array<{
      question: string;
      header?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>,
    timeoutMs: number = getEnvInt('DISCODE_QUESTION_TIMEOUT_MS', 300000),
    onAnswer?: (answer: string, optionIndex: number) => Promise<void>,
  ): Promise<string | null> {
    if (questions.length === 0) return null;

    // Sequential: send each question one at a time
    // When onAnswer callback is provided, deliver each answer immediately
    // so the caller can send it to Claude before the next question appears.
    const answers: string[] = [];
    for (const q of questions) {
      const result = await this.sendSingleQuestion(channelId, q, timeoutMs);
      if (!result) return null; // timed out
      answers.push(result.label);
      if (onAnswer) {
        await onAnswer(result.label, result.index);
      }
    }
    // Return combined answers (for callers that don't use onAnswer)
    return answers.join('\n');
  }

  private async sendSingleQuestion(
    channelId: string,
    q: { question: string; header?: string; options: Array<{ label: string; description?: string }> },
    timeoutMs: number = getEnvInt('DISCODE_QUESTION_TIMEOUT_MS', 300000),
  ): Promise<{ label: string; index: number } | null> {
    const requestId = randomUUID().slice(0, 8);

    const buttons = q.options.map((opt, i) => ({
      type: 'button' as const,
      text: { type: 'plain_text' as const, text: opt.label.slice(0, 75) },
      action_id: `opt_${requestId}_${i}`,
      value: opt.label,
      ...(i === 0 ? { style: 'primary' as const } : {}),
    }));

    const blocks: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:question: *${q.header || 'Question'}*\n${q.question}`,
        },
      },
    ];

    if (q.options.some((o) => o.description)) {
      blocks.push({
        type: 'section',
        fields: q.options.map((opt) => ({
          type: 'mrkdwn',
          text: `*${opt.label}*\n${opt.description || ' '}`,
        })),
      });
    }

    blocks.push({
      type: 'actions',
      elements: buttons,
    });

    const result = await this.app.client.chat.postMessage({
      token: this.botToken,
      channel: channelId,
      text: q.question,
      blocks,
    });

    const messageTs = result.ts;
    if (!messageTs) return null;

    return new Promise<{ label: string; index: number } | null>((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.app.client.chat.update({
          token: this.botToken,
          channel: channelId,
          ts: messageTs,
          text: `${q.question} - Timed out`,
          blocks: [],
        }).catch(() => undefined);
        resolve(null);
      }, timeoutMs);


      for (let i = 0; i < q.options.length; i++) {
        const actionId = `opt_${requestId}_${i}`;
        this.app.action(actionId, async ({ action, ack }: any) => {
          await ack();
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const selected = action.value || q.options[i].label;
          this.app.client.chat.update({
            token: this.botToken,
            channel: channelId,
            ts: messageTs,
            text: `${q.question} - Selected: ${selected}`,
            blocks: [],
          }).catch(() => undefined);
          resolve({ label: selected, index: i });
        });
      }
    });
  }

  async sendSubmitConfirmation(
    channelId: string,
    summary: Array<{ question: string; answer: string }>,
  ): Promise<boolean> {
    const requestId = randomUUID().slice(0, 8);
    const submitId = `approve_${requestId}`;
    const cancelId = `deny_${requestId}`;

    const summaryText = summary
      .map((s) => `*${s.question}*\n${s.answer}`)
      .join('\n\n');

    const result = await this.app.client.chat.postMessage({
      token: this.botToken,
      channel: channelId,
      text: 'Submit answers?',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:clipboard: *Submit Answers*\n\n${summaryText}`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Submit' },
              style: 'primary',
              action_id: submitId,
              value: 'submit',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Cancel' },
              style: 'danger',
              action_id: cancelId,
              value: 'cancel',
            },
          ],
        },
      ],
    });

    const messageTs = result.ts;
    if (!messageTs) return false;

    const timeoutMs = getEnvInt('DISCODE_QUESTION_TIMEOUT_MS', 300000);
    return new Promise<boolean>((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.app.client.chat.update({
          token: this.botToken,
          channel: channelId,
          ts: messageTs,
          text: 'Submit answers? - Timed out',
          blocks: [],
        }).catch(() => undefined);
        resolve(false);
      }, timeoutMs);

      const handler = async ({ action, ack, respond }: any) => {
        await ack();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const submitted = action.value === 'submit';
        await respond({
          text: submitted
            ? ':white_check_mark: *Submitted*'
            : ':x: *Cancelled*',
          replace_original: true,
        }).catch(() => undefined);
        resolve(submitted);
      };

      this.app.action(submitId, handler);
      this.app.action(cancelId, handler);
    });
  }


  /**
   * Poll conversations.history for each mapped channel to catch messages
   * that the WebSocket may have dropped.
   */
  async pollMissedMessages(
    messageCallback: MessageCallback | undefined,
    handleIncomingMessage: (message: Record<string, any>) => Promise<void>,
  ): Promise<void> {
    if (!messageCallback) return;

    for (const [channelId] of this.channels.getChannelMapping()) {
      try {
        const oldest = this.channels.lastSeenTs.get(channelId);
        if (!oldest) continue;

        const result = await this.app.client.conversations.history({
          token: this.botToken,
          channel: channelId,
          oldest,
          limit: 20,
        });

        const messages = result.messages || [];
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i] as Record<string, any>;
          if (msg.ts === oldest) continue;
          await handleIncomingMessage({ ...msg, channel: channelId });
        }
      } catch (error) {
        console.warn(`Poll conversations.history failed for ${channelId}:`, error);
      }
    }
  }
}

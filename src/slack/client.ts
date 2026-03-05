/**
 * Slack client implementation using @slack/bolt Socket Mode.
 *
 * Implements MessagingClient so it can be used interchangeably with DiscordClient.
 * Delegates to SlackMessaging, SlackChannels, and SlackInteractions for sub-concerns.
 */

import { App, type LogLevel } from '@slack/bolt';
import type { AgentConfig } from '../agents/index.js';
import type { MessageAttachment } from '../types/index.js';
import type { MessagingClient, MessageCallback, ChannelInfo } from '../messaging/interface.js';
import { SlackMessaging } from './messaging.js';
import { SlackChannels } from './channels.js';
import { SlackInteractions } from './interactions.js';

const SLACK_FILE_DOMAINS = ['files.slack.com', 'files-pri.slack.com'];
function isSlackFileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return SLACK_FILE_DOMAINS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

export class SlackClient implements MessagingClient {
  readonly platform = 'slack' as const;
  private app: App;
  private botToken: string;
  private messageCallback?: MessageCallback;
  private botUserId?: string;
  /** Recently handled message timestamps for deduplication. */
  private recentMessageTs = new Set<string>();
  /** Polling interval handle. */
  private pollTimer?: ReturnType<typeof setInterval>;

  // Sub-modules
  private msg: SlackMessaging;
  private ch: SlackChannels;
  private interactions: SlackInteractions;

  constructor(botToken: string, appToken: string) {
    this.botToken = botToken;
    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: 'ERROR' as LogLevel,
    });

    this.msg = new SlackMessaging(this.app, botToken);
    this.ch = new SlackChannels(this.app, botToken);
    this.interactions = new SlackInteractions(this.app, botToken, this.ch);

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.app.message(async ({ message }) => {
      this.handleIncomingMessage(message);
    });

    this.app.event('app_mention', async ({ event }) => {
      this.handleIncomingMessage(event);
    });

    this.app.action(/^opt_[a-f0-9]+_\d+$/, async ({ ack }) => {
      await ack();
    });
    this.app.action(/^approve_[a-f0-9]+$/, async ({ ack }) => {
      await ack();
    });
    this.app.action(/^deny_[a-f0-9]+$/, async ({ ack }) => {
      await ack();
    });
  }

  private async handleIncomingMessage(message: Record<string, any>): Promise<void> {
    if (!('user' in message)) return;
    const subtype = 'subtype' in message ? message.subtype : undefined;
    if (subtype && subtype !== 'file_share') return;
    if ('bot_id' in message && message.bot_id) return;
    if (this.botUserId && message.user === this.botUserId) return;

    const ts = message.ts as string | undefined;
    if (!ts) return;
    if (this.recentMessageTs.has(ts)) return;
    this.recentMessageTs.add(ts);
    if (this.recentMessageTs.size > 100) {
      const first = this.recentMessageTs.values().next().value!;
      this.recentMessageTs.delete(first);
    }

    const channelId = message.channel;
    if (!channelId) return;

    const prevTs = this.ch.lastSeenTs.get(channelId);
    if (!prevTs || ts > prevTs) {
      this.ch.lastSeenTs.set(channelId, ts);
    }

    const channelInfo = this.ch.getChannelInfo(channelId);
    if (!channelInfo) {
      const mapping = this.ch.getChannelMapping();
      console.log(`Slack message ignored: channel ${channelId} not in mapping (${mapping.size} mapped channels)`);
      return;
    }
    if (!this.messageCallback) {
      console.warn(`Slack message ignored: no message callback registered yet`);
      return;
    }

    try {
      let attachments: MessageAttachment[] | undefined;
      if ('files' in message && Array.isArray(message.files) && message.files.length > 0) {
        attachments = message.files.map((f: any) => {
          const fileUrl = f.url_private_download || f.url_private || '';
          return {
            url: fileUrl,
            filename: f.name || 'unknown',
            contentType: f.mimetype || null,
            size: f.size || 0,
            authHeaders: isSlackFileUrl(fileUrl) ? { Authorization: `Bearer ${this.botToken}` } : undefined,
          };
        });
      }

      let text = message.text || '';
      if (this.botUserId) {
        text = text.replace(new RegExp(`<@${this.botUserId}>\\s*`, 'g'), '').trim();
      }

      await this.messageCallback(
        channelInfo.agentType,
        text,
        channelInfo.projectName,
        channelId,
        message.ts,
        channelInfo.instanceId,
        attachments && attachments.length > 0 ? attachments : undefined,
      );
    } catch (error) {
      console.error(
        `Slack message handler error [${channelInfo.projectName}/${channelInfo.agentType}] channel=${channelId}:`,
        error,
      );
    }
  }

  async connect(): Promise<void> {
    await this.app.start();

    const auth = await this.app.client.auth.test({ token: this.botToken });
    this.botUserId = auth.user_id as string;
    console.log(`Slack bot connected as ${auth.user} (${this.botUserId})`);
    await this.ch.scanExistingChannels();

    const nowTs = `${Math.floor(Date.now() / 1000)}.000000`;
    for (const channelId of this.ch.getChannelMapping().keys()) {
      if (!this.ch.lastSeenTs.has(channelId)) {
        this.ch.lastSeenTs.set(channelId, nowTs);
      }
    }

    const pollMs = parseInt(process.env.SLACK_HISTORY_POLL_MS || '5000', 10);
    this.pollTimer = setInterval(() => {
      this.interactions.pollMissedMessages(
        this.messageCallback,
        (msg) => this.handleIncomingMessage(msg),
      );
    }, pollMs);
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    await this.app.stop();
  }

  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  // --- Delegate to SlackMessaging ---
  sendToChannel(channelId: string, content: string): Promise<void> {
    return this.msg.sendToChannel(channelId, content);
  }
  sendToChannelWithId(channelId: string, content: string): Promise<string | undefined> {
    return this.msg.sendToChannelWithId(channelId, content);
  }
  replyInThread(channelId: string, parentMessageId: string, content: string): Promise<void> {
    return this.msg.replyInThread(channelId, parentMessageId, content);
  }
  replyInThreadWithId(channelId: string, parentMessageId: string, content: string): Promise<string | undefined> {
    return this.msg.replyInThreadWithId(channelId, parentMessageId, content);
  }
  updateMessage(channelId: string, messageId: string, content: string): Promise<void> {
    return this.msg.updateMessage(channelId, messageId, content);
  }
  sendToChannelWithFiles(channelId: string, content: string, filePaths: string[]): Promise<void> {
    return this.msg.sendToChannelWithFiles(channelId, content, filePaths);
  }
  addReactionToMessage(channelId: string, messageId: string, emoji: string): Promise<void> {
    return this.msg.addReactionToMessage(channelId, messageId, emoji);
  }
  replaceOwnReactionOnMessage(channelId: string, messageId: string, fromEmoji: string, toEmoji: string): Promise<void> {
    return this.msg.replaceOwnReactionOnMessage(channelId, messageId, fromEmoji, toEmoji);
  }

  // --- Delegate to SlackChannels ---
  createAgentChannels(
    guildId: string,
    projectName: string,
    agentConfigs: AgentConfig[],
    customChannelName?: string,
    instanceIdByAgent?: { [agentName: string]: string | undefined },
  ): Promise<{ [agentName: string]: string }> {
    return this.ch.createAgentChannels(guildId, projectName, agentConfigs, customChannelName, instanceIdByAgent);
  }
  registerChannelMappings(mappings: { channelId: string; projectName: string; agentType: string; instanceId?: string }[]): void {
    this.ch.registerChannelMappings(mappings);
  }
  getChannelMapping(): Map<string, ChannelInfo> {
    return this.ch.getChannelMapping();
  }
  getGuilds(): { id: string; name: string }[] {
    return this.ch.getGuilds();
  }
  deleteChannel(channelId: string): Promise<boolean> {
    return this.ch.deleteChannel(channelId);
  }

  // --- Delegate to SlackInteractions ---
  sendApprovalRequest(
    channelId: string,
    toolName: string,
    toolInput: any,
    timeoutMs?: number,
  ): Promise<boolean> {
    return this.interactions.sendApprovalRequest(channelId, toolName, toolInput, timeoutMs);
  }
  async sendQuestionWithButtons(
    channelId: string,
    questions: Array<{
      question: string;
      header?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>,
    timeoutMs?: number,
  ): Promise<string | null> {
    const info = this.ch.getChannelInfo(channelId);
    let answerCount = 0;
    const collectedAnswers: Array<{ question: string; answer: string }> = [];
    const selected = await this.interactions.sendQuestionWithButtons(
      channelId, questions, timeoutMs,
      // onAnswer: send arrow key navigation to Claude's PTY
      async (answer, optionIndex) => {
        const qIndex = answerCount;
        answerCount++;
        collectedAnswers.push({
          question: questions[qIndex].header || questions[qIndex].question,
          answer,
        });
        console.log(`🔘 [question-button] answer #${answerCount}/${questions.length}: ${JSON.stringify(answer)} index=${optionIndex} channel=${channelId}`);
        if (this.messageCallback && info) {
          // Navigate to correct option using Down arrow keys, then Enter selects it
          const downArrows = '\x1b[B'.repeat(optionIndex);
          console.log(`🔘 [question-button] sending ${optionIndex} down arrows to select option`);
          try {
            await this.messageCallback(info.agentType, `\x01${downArrows}`, info.projectName, channelId, undefined, info.instanceId);
          } catch (err) {
            console.warn('Failed to route question button selection to agent:', err);
          }
          // "Give feedback" opens text input in Claude CLI — guide the user
          if (answer === 'Give feedback') {
            await this.msg.sendToChannel(channelId, '✏️ Type your feedback below and it will be sent to Claude.');
          }
          // Wait for Claude to process and render next question UI
          if (answerCount < questions.length) {
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      },
    );
    console.log(`🔘 [question-button] all done: ${answerCount} answers, selected=${JSON.stringify(selected)}`);
    // Claude CLI shows "Submit answers" / "Cancel" only for multi-question flows.
    // Single question is confirmed immediately after selection.
    if (selected && this.messageCallback && info && questions.length > 1) {
      const shouldSubmit = await this.interactions.sendSubmitConfirmation(channelId, collectedAnswers);
      await new Promise(r => setTimeout(r, 1500));
      if (shouldSubmit) {
        console.log(`🔘 [question-button] submitting answers`);
        try {
          await this.messageCallback(info.agentType, `\x01`, info.projectName, channelId, undefined, info.instanceId);
        } catch (err) {
          console.warn('Failed to send Submit answers confirmation:', err);
        }
      } else {
        // Cancel: Down arrow to select "Cancel" option, then Enter
        console.log(`🔘 [question-button] cancelling answers`);
        try {
          await this.messageCallback(info.agentType, `\x01\x1b[B`, info.projectName, channelId, undefined, info.instanceId);
        } catch (err) {
          console.warn('Failed to send Cancel:', err);
        }
      }
    }
    return selected;
  }
}

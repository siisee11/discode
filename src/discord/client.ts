/**
 * Discord client setup and management
 */

import {
  Client,
  GatewayIntentBits,
  TextChannel,
} from 'discord.js';
import type { AgentMessage, MessageAttachment } from '../types/index.js';
import { agentRegistry as defaultAgentRegistry, type AgentConfig, type AgentRegistry } from '../agents/index.js';
import { normalizeDiscordToken } from '../config/token.js';
import type { MessagingClient, MessageCallback, ChannelInfo } from '../messaging/interface.js';
import { DiscordMessaging } from './messaging.js';
import { DiscordChannels } from './channels.js';
import { DiscordInteractions } from './interactions.js';

export type { MessageCallback, ChannelInfo };

export class DiscordClient implements MessagingClient {
  readonly platform = 'discord' as const;
  private client: Client;
  private token: string;
  private targetChannel?: TextChannel;
  private messageCallback?: MessageCallback;
  private registry: AgentRegistry;

  private messaging: DiscordMessaging;
  private channels: DiscordChannels;
  private interactions: DiscordInteractions;

  constructor(token: string, registry?: AgentRegistry) {
    this.token = normalizeDiscordToken(token);
    this.registry = registry || defaultAgentRegistry;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    this.messaging = new DiscordMessaging(this.client);
    this.channels = new DiscordChannels(this.client, this.registry);
    this.interactions = new DiscordInteractions(this.client);

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.on('clientReady', () => {
      console.log(`Discord bot logged in as ${this.client.user?.tag}`);
      this.channels.scanExistingChannels();
    });

    this.client.on('error', (error) => {
      console.error('Discord client error:', error);
    });

    this.client.on('messageCreate', async (message) => {
      if (message.author.bot) return;
      if (!message.channel.isTextBased()) return;

      const channelInfo = this.channels.channelMapping.get(message.channelId);
      if (channelInfo && this.messageCallback) {
        try {
          const attachments: MessageAttachment[] = message.attachments.map((a) => ({
            url: a.url,
            filename: a.name ?? 'unknown',
            contentType: a.contentType,
            size: a.size,
          }));

          await this.messageCallback(
            channelInfo.agentType,
            message.content,
            channelInfo.projectName,
            message.channelId,
            message.id,
            channelInfo.instanceId,
            attachments.length > 0 ? attachments : undefined
          );
        } catch (error) {
          console.error(
            `Discord message handler error [${channelInfo.projectName}/${channelInfo.agentType}] channel=${message.channelId}:`,
            error
          );
        }
      }
    });
  }

  async connect(): Promise<void> {
    if (!this.token) {
      throw new Error(
        'Discord login failed: bot token is empty. Run `discode config --token <your-token>` or `discode onboard`.'
      );
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Discord login timed out after 30 seconds'));
      }, 30000);

      this.client.once('clientReady', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.client.login(this.token).catch((error) => {
        clearTimeout(timeout);
        const rawMessage = error instanceof Error ? error.message : String(error);
        if (/invalid token/i.test(rawMessage)) {
          reject(
            new Error(
              'Discord login failed: invalid bot token. Run `discode config --token <your-token>` or `discode onboard`.'
            )
          );
          return;
        }
        reject(new Error(`Discord login failed: ${rawMessage}`));
      });
    });
  }

  async setTargetChannel(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }
    this.targetChannel = channel as TextChannel;
  }

  async sendMessage(message: AgentMessage): Promise<void> {
    if (!this.targetChannel) {
      console.warn('No target channel set, skipping message');
      return;
    }

    const formatted = this.formatMessage(message);
    await this.targetChannel.send(formatted);
  }

  private formatMessage(message: AgentMessage): string {
    const emoji = this.getEmojiForType(message.type);
    const header = `${emoji} **${message.type}** ${message.agentName ? `(${message.agentName})` : ''}`;

    return `${header}\n${message.content}`;
  }

  private getEmojiForType(type: AgentMessage['type']): string {
    switch (type) {
      case 'tool-output':
        return '🔧';
      case 'agent-output':
        return '🤖';
      case 'error':
        return '❌';
      default:
        return '📝';
    }
  }

  async disconnect(): Promise<void> {
    await this.client.destroy();
  }

  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  // --- Delegate to DiscordChannels ---

  createAgentChannels(
    guildId: string,
    projectName: string,
    agentConfigs: AgentConfig[],
    customChannelName?: string,
    instanceIdByAgent?: { [agentName: string]: string | undefined },
  ): Promise<{ [agentName: string]: string }> {
    return this.channels.createAgentChannels(guildId, projectName, agentConfigs, customChannelName, instanceIdByAgent);
  }

  registerChannelMappings(mappings: { channelId: string; projectName: string; agentType: string; instanceId?: string }[]): void {
    this.channels.registerChannelMappings(mappings);
  }

  getGuilds(): { id: string; name: string }[] {
    return this.channels.getGuilds();
  }

  getChannelMapping(): Map<string, ChannelInfo> {
    return this.channels.getChannelMapping();
  }

  deleteChannel(channelId: string): Promise<boolean> {
    return this.channels.deleteChannel(channelId);
  }

  // --- Delegate to DiscordMessaging ---

  sendToChannel(channelId: string, content: string): Promise<void> {
    return this.messaging.sendToChannel(channelId, content);
  }

  sendToChannelWithId(channelId: string, content: string): Promise<string | undefined> {
    return this.messaging.sendToChannelWithId(channelId, content);
  }

  replyInThread(channelId: string, parentMessageId: string, content: string): Promise<void> {
    return this.messaging.replyInThread(channelId, parentMessageId, content);
  }

  replyInThreadWithId(channelId: string, parentMessageId: string, content: string): Promise<string | undefined> {
    return this.messaging.replyInThreadWithId(channelId, parentMessageId, content);
  }

  updateMessage(channelId: string, messageId: string, content: string): Promise<void> {
    return this.messaging.updateMessage(channelId, messageId, content);
  }

  sendToChannelWithFiles(channelId: string, content: string, filePaths: string[]): Promise<void> {
    return this.messaging.sendToChannelWithFiles(channelId, content, filePaths);
  }

  addReactionToMessage(channelId: string, messageId: string, emoji: string): Promise<void> {
    return this.messaging.addReactionToMessage(channelId, messageId, emoji);
  }

  replaceOwnReactionOnMessage(channelId: string, messageId: string, fromEmoji: string, toEmoji: string): Promise<void> {
    return this.messaging.replaceOwnReactionOnMessage(channelId, messageId, fromEmoji, toEmoji);
  }

  // --- Delegate to DiscordInteractions ---

  sendApprovalRequest(channelId: string, toolName: string, toolInput: any, timeoutMs?: number): Promise<boolean> {
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
    const info = this.channels.channelMapping.get(channelId);
    let answerCount = 0;
    const collectedAnswers: Array<{ question: string; answer: string }> = [];
    const selected = await this.interactions.sendQuestionWithButtons(
      channelId, questions, timeoutMs,
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
            await this.messaging.sendToChannel(channelId, '✏️ Type your feedback below and it will be sent to Claude.');
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

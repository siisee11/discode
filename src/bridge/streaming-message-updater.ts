import type { MessagingClient } from '../messaging/interface.js';

interface StreamingEntry {
  channelId: string;
  messageId: string;
  /** Stable origin ID for staleness guard (e.g. startMessageId). */
  originId?: string;
  /** The latest status text to display (replaces previous on each update). */
  currentText: string;
  /** Accumulated activity lines for cumulative mode. */
  historyLines: string[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Promise for any in-progress flush (prevents finalize from racing). */
  flushPromise?: Promise<void>;
  /** When true, the next flush should create a new message instead of updating. */
  needsNewMessage?: boolean;
}

const DEBOUNCE_MS = 750;

export class StreamingMessageUpdater {
  private entries = new Map<string, StreamingEntry>();

  constructor(private messaging: MessagingClient) {}

  private key(projectName: string, instanceKey: string): string {
    return `${projectName}:${instanceKey}`;
  }

  canStream(): boolean {
    return typeof this.messaging.updateMessage === 'function';
  }

  start(projectName: string, instanceKey: string, channelId: string, messageId: string, originId?: string): void {
    if (!this.canStream()) return;
    const k = this.key(projectName, instanceKey);

    // Discard any previous entry for this key
    const existing = this.entries.get(k);
    if (existing?.debounceTimer) clearTimeout(existing.debounceTimer);

    this.entries.set(k, {
      channelId,
      messageId,
      originId,
      currentText: '',
      historyLines: [],
      debounceTimer: null,
    });
  }

  /**
   * Replace the displayed status text with the latest activity.
   * Returns true if updated successfully, false if not streaming.
   */
  append(projectName: string, instanceKey: string, text: string): boolean {
    const k = this.key(projectName, instanceKey);
    const entry = this.entries.get(k);
    if (!entry) return false;

    entry.currentText = text;
    this.scheduleFlush(k, entry);
    return true;
  }

  /**
   * Append a line to cumulative status text.
   * Used for tool activity streams where preserving history is useful.
   */
  appendCumulative(projectName: string, instanceKey: string, text: string): boolean {
    const k = this.key(projectName, instanceKey);
    const entry = this.entries.get(k);
    if (!entry) return false;

    if (text.length > 0) {
      const newLength = entry.currentText.length + 1 + text.length; // +1 for \n
      if (entry.historyLines.length > 0 && newLength > this.platformLimit()) {
        entry.historyLines = [text];
        entry.needsNewMessage = true;
      } else {
        entry.historyLines.push(text);
      }
    }
    entry.currentText = entry.historyLines.join('\n');
    this.scheduleFlush(k, entry);
    return true;
  }

  /**
   * Finalize streaming: flush latest stream update, then post a finalize header as a new message.
   * If expectedMessageId is provided, only finalize if the entry still belongs to the same request
   * (prevents a stale handler from finalizing a newer request's entry after markPending overwrites).
   */
  async finalize(projectName: string, instanceKey: string, customHeader?: string, expectedMessageId?: string): Promise<void> {
    const k = this.key(projectName, instanceKey);
    const entry = this.entries.get(k);
    if (!entry) return;

    // Guard: if a newer request took over this streaming slot, don't finalize it.
    // Compare against originId (the stable startMessageId) when available,
    // since entry.messageId may differ (separate streaming message).
    const guardId = entry.originId || entry.messageId;
    if (expectedMessageId && guardId !== expectedMessageId) return;

    const hadPendingTimer = !!entry.debounceTimer;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);

    // Wait for any in-progress flush to complete before posting the finalize line.
    if (entry.flushPromise) await entry.flushPromise;

    // Flush any content that was waiting in the cancelled debounce timer.
    if (hadPendingTimer && entry.currentText) {
      await this.flush(k);
    }


    const content = customHeader || '\u2705 Done';
    this.entries.delete(k);

    try {
      await this.messaging.sendToChannel(entry.channelId, content);
    } catch {
      // Non-fatal
    }
  }

  discard(projectName: string, instanceKey: string): void {
    const k = this.key(projectName, instanceKey);
    const entry = this.entries.get(k);
    if (!entry) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    this.entries.delete(k);
  }

  has(projectName: string, instanceKey: string): boolean {
    return this.entries.has(this.key(projectName, instanceKey));
  }

  private async flush(k: string): Promise<void> {
    const entry = this.entries.get(k);
    if (!entry) return;

    const content = this.clampForPlatform(entry.currentText || '\u23F3 Working...');

    if (entry.needsNewMessage) {
      const promise = (async () => {
        const newId = await this.messaging.sendToChannelWithId(entry.channelId, content);
        if (newId) entry.messageId = newId;
        entry.needsNewMessage = false;
      })().catch(() => {});
      entry.flushPromise = promise;
      await promise;
      if (entry.flushPromise === promise) entry.flushPromise = undefined;
      return;
    }


    if (this.messaging.updateMessage) {
      const promise = this.messaging.updateMessage(entry.channelId, entry.messageId, content).catch(() => {});
      entry.flushPromise = promise;
      await promise;
      // Clear only if this is still the active flush
      if (entry.flushPromise === promise) entry.flushPromise = undefined;
    }
  }

  private scheduleFlush(key: string, entry: StreamingEntry): void {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      this.flush(key).catch(() => {});
    }, DEBOUNCE_MS);
  }

  private platformLimit(): number {
    return this.messaging.platform === 'slack' ? 3900 : 1900;
  }

  private clampForPlatform(content: string): string {
    const limit = this.platformLimit();
    if (content.length <= limit) return content;

    const prefix = '...(truncated)\n';
    const keep = Math.max(0, limit - prefix.length);
    return prefix + content.slice(-keep);
  }
}

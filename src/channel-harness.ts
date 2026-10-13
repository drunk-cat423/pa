import { createHash } from 'node:crypto';
import type { PaConfig } from './config.js';
import type { ChannelRoute, DeliveryResult, InboundMessage, OutboundMessage } from './channel-types.js';
import { openRecordedConversation, type RecordedConversation } from './conversation.js';
import { DuplicateMessageError } from './store.js';
import { RequestError } from './runtime.js';
import { configuredPersons, isMemoryOwner, isPrimaryPerson, NO_OWNER_POLICY, validateHarnessPolicy, type HarnessPolicy } from './harness-policy.js';
import { executeMemoryRequest, parseMemoryRequest, safeProfileError } from './memory-service.js';
import { MemoryError } from './memory-types.js';
import type { MemorySource } from './memory-service.js';
import type { MemoryProvider } from './memory-provider.js';

export interface ChannelTransport {
  send(message: OutboundMessage): Promise<DeliveryResult>;
}

export function channelConversationKey(route: ChannelRoute): string {
  return `channel:${createHash('sha256').update(JSON.stringify([
    route.channel, route.accountId, route.roomType, route.roomId,
  ])).digest('hex')}`;
}

export type HarnessResult = 'ignored' | 'observed' | 'duplicate' | 'budget_exhausted'
  | 'sent' | 'uncertain' | 'rejected' | 'failed';

// Policy and budget live here, independent of the transport's platform protocol.
export class ChannelHarness {
  private readonly allowed: Set<string>;
  private readonly conversations = new Map<string, RecordedConversation>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly opening = new Map<string, Promise<RecordedConversation>>();
  private closed = false;
  private calls = 0;
  private readonly policy: HarnessPolicy;

  constructor(private readonly config: PaConfig, private readonly routes: ChannelRoute[],
    private readonly transport: ChannelTransport, private readonly maxCalls: number, policy: HarnessPolicy = NO_OWNER_POLICY,
    private readonly memoryProvider?: MemoryProvider) {
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 0) throw new Error('调用上限必须是非负整数，0 表示不限次数。');
    if (!routes.length) throw new Error('必须显式配置允许接入的房间。');
    this.allowed = new Set(routes.map(channelConversationKey));
    this.policy = validateHarnessPolicy(policy);
  }

  info() { return { calls: this.calls, maxCalls: this.maxCalls,
    memory: [...this.conversations].map(([key, conversation]) => ({ conversation: key, ...conversation.memoryStatus() })) }; }

  async waitForMemory(): Promise<void> {
    await Promise.all([...this.conversations.values()].map(conversation => conversation.waitForMemory()));
  }

  async start(): Promise<void> {
    if (this.config.memory?.enabled && !this.closed) {
      await Promise.all(this.routes.map(route => this.open(channelConversationKey(route), route)));
    }
  }

  private open(key: string, route: ChannelRoute): Promise<RecordedConversation> {
    let pending = this.opening.get(key);
    if (!pending) {
      pending = openRecordedConversation(this.config, key, route, undefined,
        { persons: configuredPersons(this.policy), ...(this.memoryProvider ? { memoryProvider: this.memoryProvider } : {}) });
      this.opening.set(key, pending);
      pending.then(conversation => this.conversations.set(key, conversation)).catch(() => this.opening.delete(key));
    }
    return pending;
  }

  handle(message: InboundMessage): Promise<HarnessResult> {
    const key = channelConversationKey(message.route);
    if (this.closed || !this.allowed.has(key) || !message.eventId || !message.senderId
      || !message.text.trim() || message.text.length > 4000
      || !Number.isFinite(Date.parse(message.sentAt))) return Promise.resolve('ignored');
    const input = { ...message, route: { ...message.route },
      ...(message.mentionedSenderIds ? { mentionedSenderIds: [...message.mentionedSenderIds] } : {}) };
    return this.accept(key, input);
  }

  private async accept(key: string, message: InboundMessage): Promise<HarnessResult> {
    const conversation = await this.open(key, message.route);
    if (this.closed) { await conversation.close(); return 'ignored'; }
    const memoryRequest = parseMemoryRequest(message.text);
    const source = conversation.ingest(message.text, {
      eventId: message.eventId, senderId: message.senderId, modelInputText: message.text, sentAt: message.sentAt,
      ...(message.senderName ? { senderName: message.senderName.slice(0, 100) } : {}),
      ...(memoryRequest ? { messageKind: 'memory' as const } : {}),
    });
    if (!source) return 'duplicate';
    if (message.route.roomType === 'group' && !message.mentioned) return 'observed';
    const job = (this.queues.get(key) ?? Promise.resolve()).then(() => this.process(conversation, message, source));
    this.queues.set(key, job.catch(() => {}));
    return job;
  }

  private async process(conversation: RecordedConversation, message: InboundMessage, source: MemorySource): Promise<HarnessResult> {
    if (this.closed) return 'ignored';
    const sender = {
      eventId: message.eventId, senderId: message.senderId, existingMessageId: source.id, sentAt: message.sentAt,
      ...(message.mentionedSenderIds ? { mentionedSenderIds: message.mentionedSenderIds } : {}),
      ...(message.senderName ? { senderName: message.senderName.slice(0, 100) } : {}),
    };
    const memoryRequest = parseMemoryRequest(message.text);
    // Process recent messages only, reserving time inside QQ's passive reply window.
    if (Date.now() - Date.parse(message.sentAt) > 240_000) return 'ignored';
    if (memoryRequest) {
      const control = conversation.control(message.text, { ...sender, modelInputText: message.text, messageKind: 'memory' }, source => {
        try { return executeMemoryRequest(memoryRequest, conversation!, source, isMemoryOwner(this.policy, message),
          isPrimaryPerson(this.policy, message)); }
        catch (error) { if (error instanceof MemoryError) return safeProfileError(error); throw error; }
      });
      return this.deliver(conversation, message, control);
    }
    if (this.maxCalls > 0 && this.calls >= this.maxCalls) return 'budget_exhausted';
    // Reserve before invoking Pi; errors also consume the attempt. No automatic retry.
    this.calls++;
    let reply;
    try {
      reply = await conversation.prompt(message.text, { ...sender, modelInputText: message.text });
    } catch (error) {
      if (error instanceof DuplicateMessageError) { this.calls--; return 'duplicate'; }
      if (error instanceof RequestError) return 'failed';
      // An API failure is recoverable on a new message; broken persistence is fatal.
      throw error;
    }
    return this.deliver(conversation, message, reply);
  }

  private async deliver(conversation: RecordedConversation, message: InboundMessage,
    reply: { text: string; deliveryId: string }): Promise<HarnessResult> {
    if (this.closed) {
      conversation.acknowledge(reply.deliveryId, 'uncertain');
      return 'uncertain';
    }
    let delivery: DeliveryResult;
    try {
      delivery = await this.transport.send({ route: message.route, replyToMessageId: message.eventId, text: reply.text });
    } catch { delivery = { status: 'uncertain' }; }
    // A rejected send also remains unconfirmed in the existing delivery state model.
    conversation.acknowledge(reply.deliveryId, delivery.status === 'sent' ? 'sent' : 'uncertain',
      delivery.status === 'sent' ? delivery.externalMessageId : undefined);
    return delivery.status;
  }

  async close(): Promise<void> {
    this.closed = true;
    // Closing active conversations aborts their model requests while preserving the run.
    await Promise.all([...this.conversations.values()].map(conversation => conversation.close()));
    await Promise.allSettled(this.opening.values());
    await Promise.allSettled(this.queues.values());
    // An open operation already in progress may have completed after the first close pass.
    await Promise.all([...this.conversations.values()].map(conversation => conversation.close()));
  }
}

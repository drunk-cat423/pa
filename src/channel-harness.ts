import { createHash } from 'node:crypto';
import type { PaConfig } from './config.js';
import type { ChannelRoute, DeliveryResult, InboundMessage, OutboundMessage } from './channel-types.js';
import { openRecordedConversation, type RecordedConversation } from './conversation.js';
import { DuplicateMessageError } from './store.js';
import { RequestError } from './runtime.js';
import { configuredPersons, isMemoryOwner, NO_OWNER_POLICY, validateHarnessPolicy, type HarnessPolicy } from './harness-policy.js';
import { executeMemoryRequest, parseMemoryRequest, safeProfileError } from './memory-service.js';
import { MemoryError } from './memory-types.js';
import type { MemorySource } from './memory-service.js';
import type { MemoryProvider } from './memory-provider.js';
import { toPlainText } from './plain-text.js';
import { appendReferenceUrls, splitReply, QQ_PASSIVE_REPLY_LIMIT } from './reply-chunks.js';

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
  private readonly outputs = new Map<string, Promise<unknown>>();
  private readonly pending: { run: (release: () => void) => Promise<HarnessResult>; resolve: (value: HarnessResult) => void; reject: (error: unknown) => void }[] = [];
  private readonly jobs = new Set<Promise<unknown>>();
  private computing = 0;
  private fatal: unknown;
  private readonly opening = new Map<string, Promise<RecordedConversation>>();
  private closed = false;
  private calls = 0;
  private readonly policy: HarnessPolicy;

  constructor(private readonly config: PaConfig, private readonly routes: ChannelRoute[],
    private readonly transport: ChannelTransport, private readonly maxCalls: number, policy: HarnessPolicy = NO_OWNER_POLICY,
    private readonly memoryProvider?: MemoryProvider, private readonly onTaskError?: () => void) {
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 0) throw new Error('调用上限必须是非负整数，0 表示不限次数。');
    if (!routes.length) throw new Error('必须显式配置允许接入的房间。');
    const concurrency = config.tasks?.maxConcurrent ?? 2;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('任务并发数必须是1到16。');
    this.allowed = new Set(routes.map(channelConversationKey));
    this.policy = validateHarnessPolicy(policy);
  }

  info() { return { calls: this.calls, maxCalls: this.maxCalls, computing: this.computing, queued: this.pending.length,
    memory: [...this.conversations].map(([key, conversation]) => ({ conversation: key, ...conversation.memoryStatus() })) }; }

  async waitForMemory(): Promise<void> {
    await Promise.all([...this.conversations.values()].map(conversation => conversation.waitForMemory()));
  }

  async waitForTasks(): Promise<void> {
    // Include work admitted by a preceding job's released computation slot.
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }

  async start(): Promise<void> {
    if (!this.closed) {
      await Promise.all(this.routes.map(route => this.open(channelConversationKey(route), route)));
    }
  }

  private open(key: string, route: ChannelRoute): Promise<RecordedConversation> {
    let pending = this.opening.get(key);
    if (!pending) {
      pending = openRecordedConversation(this.config, key, route, undefined,
        { persons: configuredPersons(this.policy), policy: this.policy, ...(this.memoryProvider ? { memoryProvider: this.memoryProvider } : {}) });
      this.opening.set(key, pending);
      pending.then(conversation => {
        this.conversations.set(key, conversation);
        if (!this.closed) for (const task of conversation.tasks('queued')) {
          void this.schedule(release => this.process(conversation, task.input, { id: task.messageId,
            actorId: conversation.findActor(task.input.senderId)!, senderId: task.input.senderId, text: task.input.text }, task.id, release))
            .catch(() => this.onTaskError?.());
        }
      }).catch(() => this.opening.delete(key));
    }
    return pending;
  }

  handle(message: InboundMessage): Promise<HarnessResult> {
    const key = channelConversationKey(message.route);
    if (this.closed || !this.allowed.has(key) || !message.eventId || !message.senderId
      || !message.text.trim() || message.text.length > 4000
      || !Number.isFinite(Date.parse(message.sentAt))) return Promise.resolve('ignored');
    const input = { ...message, route: { ...message.route },
      ...(message.mentionedSenderIds ? { mentionedSenderIds: [...message.mentionedSenderIds] } : {}),
      ...(message.quote ? { quote: { ...message.quote,
        ...(message.quote.inlineMessages ? { inlineMessages: message.quote.inlineMessages.map(item => ({ ...item })) } : {}) } } : {}) };
    return this.accept(key, input);
  }

  private async accept(key: string, message: InboundMessage): Promise<HarnessResult> {
    if (this.fatal) throw this.fatal;
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
    const task = conversation.enqueueTask(source.id, message);
    return this.schedule(release => this.process(conversation, message, source, task.id, release));
  }

  private schedule(run: (release: () => void) => Promise<HarnessResult>): Promise<HarnessResult> {
    const result = new Promise<HarnessResult>((resolve, reject) => this.pending.push({ run, resolve, reject }));
    this.pump();
    return result;
  }

  private pump(): void {
    while (!this.closed && !this.fatal && this.computing < (this.config.tasks?.maxConcurrent ?? 2) && this.pending.length) {
      const job = this.pending.shift()!;
      this.computing++;
      let released = false;
      const release = () => { if (!released) { released = true; this.computing--; this.pump(); } };
      const running = Promise.resolve().then(() => job.run(release)).then(job.resolve, error => {
        this.fatal = error;
        job.reject(error);
        for (const waiting of this.pending.splice(0)) waiting.reject(error);
      }).finally(() => { release(); this.jobs.delete(running); });
      this.jobs.add(running);
    }
  }

  private output<T>(route: ChannelRoute, operation: () => Promise<T>): Promise<T> {
    const key = channelConversationKey(route);
    const sending = (this.outputs.get(key) ?? Promise.resolve()).then(operation);
    const settled = sending.catch(() => {});
    this.outputs.set(key, settled);
    void settled.then(() => { if (this.outputs.get(key) === settled) this.outputs.delete(key); });
    return sending;
  }

  private passiveAvailable(message: InboundMessage, offset: number): boolean {
    return offset < QQ_PASSIVE_REPLY_LIMIT && (message.route.channel !== 'qq' || Date.now() - Date.parse(message.sentAt) < 300_000);
  }

  private async process(conversation: RecordedConversation, message: InboundMessage, source: MemorySource,
    taskId: string, release: () => void): Promise<HarnessResult> {
    if (this.closed) return 'ignored';
    if (!conversation.claimTask(taskId)) return 'duplicate';
    const sender = {
      eventId: message.eventId, senderId: message.senderId, existingMessageId: source.id, sentAt: message.sentAt,
      ...(message.mentionedSenderIds ? { mentionedSenderIds: message.mentionedSenderIds } : {}),
      ...(message.senderName ? { senderName: message.senderName.slice(0, 100) } : {}),
      ...(message.quote ? { quote: message.quote } : {}),
      ...(message.route.channel === 'qq' ? { responseFormat: 'plain_text' as const } : {}),
    };
    const memoryRequest = parseMemoryRequest(message.text);
    const resultRequest = /^\/result(?:\s+([0-9a-f-]+))?\s*$/i.exec(message.text);
    if (resultRequest) {
      const result = conversation.taskResult(message.senderId, resultRequest[1]);
      const control = conversation.control(message.text, { ...sender, modelInputText: message.text }, () => result?.text ?? '没有找到你在本会话中已完成的结果。');
      conversation.finishTask(taskId, 'completed', control.deliveryId);
      release();
      return this.deliver(conversation, message, control, 0, taskId);
    }
    if (memoryRequest) {
      const operation = (source: MemorySource) => {
        try {
          return executeMemoryRequest(memoryRequest, conversation, source, isMemoryOwner(this.policy, message));
        }
        catch (error) { if (error instanceof MemoryError) return safeProfileError(error); throw error; }
      };
      const external = { ...sender, modelInputText: message.text, messageKind: 'memory' as const };
      const control = conversation.control(message.text, external, operation);
      conversation.finishTask(taskId, 'completed', control.deliveryId);
      release();
      return this.deliver(conversation, message, control, 0, taskId);
    }
    if (this.maxCalls > 0 && this.calls >= this.maxCalls) { conversation.finishTask(taskId, 'failed'); return 'budget_exhausted'; }
    // Reserve before invoking Pi; errors also consume the attempt. No automatic retry.
    this.calls++;
    let reply;
    let replyOffset = 0;
    try {
      reply = await conversation.prompt(message.text, { ...sender, modelInputText: message.text }, async progress => {
        return this.output(message.route, async () => {
          const mode = this.passiveAvailable(message, replyOffset) ? 'passive' : 'active';
          const partIndex = mode === 'passive' ? replyOffset++ : 0;
          progress.begin(mode, mode === 'passive' ? partIndex + 1 : undefined);
          if (this.closed) return { status: 'uncertain' };
          try { return await this.transport.send({ route: message.route, deliveryMode: mode,
            ...(mode === 'passive' ? { replyToMessageId: message.eventId } : {}),
            text: message.route.channel === 'qq' ? toPlainText(progress.text) : progress.text,
            partIndex, ...(message.route.channel === 'qq' ? { plainText: true } : {}) }); }
          catch { return { status: 'uncertain' }; }
        });
      }, () => !this.closed && this.passiveAvailable(message, replyOffset)
        && !this.outputs.has(channelConversationKey(message.route)));
    } catch (error) {
      if (error instanceof DuplicateMessageError) { this.calls--; conversation.finishTask(taskId, 'interrupted'); return 'duplicate'; }
      if (error instanceof RequestError) { conversation.finishTask(taskId, this.closed ? 'interrupted' : 'failed'); return 'failed'; }
      // An API failure is recoverable on a new message; broken persistence is fatal.
      throw error;
    }
    conversation.finishTask(taskId, 'completed', reply.deliveryId);
    release();
    return this.deliver(conversation, message, reply, replyOffset, taskId);
  }

  private async deliver(conversation: RecordedConversation, message: InboundMessage,
    reply: { text: string; deliveryId: string; referenceUrls?: readonly string[] }, replyOffset = 0, taskId?: string): Promise<HarnessResult> {
    return this.output(message.route, async () => {
    const qq = message.route.channel === 'qq';
    let text = appendReferenceUrls(qq ? toPlainText(reply.text) : reply.text, reply.referenceUrls);
    const activeBatch = qq && (!this.passiveAvailable(message, replyOffset) || splitReply(text).length > QQ_PASSIVE_REPLY_LIMIT - replyOffset);
    if (activeBatch) text = `回复 ${toPlainText(message.senderName ?? '提问者').slice(0, 50)} · ${taskId?.slice(0, 8) ?? ''}\n问题：${[...toPlainText(message.text)].slice(0, 80).join('')}\n\n${text}`;
    const parts = splitReply(text);
    if (!parts.length) {
      conversation.acknowledge(reply.deliveryId, 'uncertain');
      return 'rejected';
    }
    conversation.prepareDeliveryParts(reply.deliveryId, parts);
    for (const [partIndex, part] of parts.entries()) {
      if (this.closed) {
        conversation.acknowledge(reply.deliveryId, 'uncertain');
        return 'uncertain';
      }
      const mode = activeBatch || !this.passiveAvailable(message, replyOffset) ? 'active' : 'passive';
      const slot = mode === 'passive' ? replyOffset++ : undefined;
      conversation.beginDeliveryPart(reply.deliveryId, partIndex, mode, slot === undefined ? undefined : slot + 1);
      let delivery: DeliveryResult;
      try {
        delivery = await this.transport.send({ route: message.route, deliveryMode: mode,
          ...(mode === 'passive' ? { replyToMessageId: message.eventId } : {}),
          text: part, partIndex: slot ?? partIndex, ...(qq ? { plainText: true } : {}) });
      } catch { delivery = { status: 'uncertain' }; }
      conversation.acknowledgePart(reply.deliveryId, partIndex, delivery.status,
        delivery.status === 'sent' ? delivery.externalMessageId : undefined);
      if (delivery.status !== 'sent') return delivery.status;
    }
    return 'sent';
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const waiting of this.pending.splice(0)) waiting.resolve('ignored');
    // Abort model work first; in-flight transport receipts still need the open store.
    await Promise.all([...this.conversations.values()].map(conversation => conversation.abort()));
    await Promise.allSettled(this.opening.values());
    await Promise.all([...this.conversations.values()].map(conversation => conversation.abort()));
    await Promise.allSettled(this.jobs);
    await Promise.allSettled(this.outputs.values());
    // An open operation already in progress may have completed after the first close pass.
    await Promise.all([...this.conversations.values()].map(conversation => conversation.close()));
  }
}

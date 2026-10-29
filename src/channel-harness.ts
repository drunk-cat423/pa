import { createHash } from 'node:crypto';
import type { PaConfig } from './config.js';
import type { ChannelRoute, DeliveryResult, InboundMessage, OutboundMessage } from './channel-types.js';
import { openRecordedConversation, type RecordedConversation } from './conversation.js';
import { DuplicateMessageError, StoreInitializationScope } from './store.js';
import { RequestError } from './runtime.js';
import { configuredPersons, isMemoryOwner, NO_OWNER_POLICY, validateHarnessPolicy, type HarnessPolicy } from './harness-policy.js';
import { executeMemoryRequest, parseMemoryRequest, safeProfileError } from './memory-service.js';
import { MemoryError } from './memory-types.js';
import type { MemorySource } from './memory-service.js';
import type { MemoryProvider } from './memory-provider.js';
import { toPlainText } from './plain-text.js';
import { appendReferenceUrls, splitReply, QQ_PASSIVE_REPLY_LIMIT } from './reply-chunks.js';
import { splitMarkdown } from './markdown-chunks.js';
import { ImageAssets, ImageAssetError } from './image-assets.js';
import { ResearchService } from './research-service.js';
import { SessionIntegrityError } from './session-integrity.js';
import {ReminderService} from './reminder-service.js';
import {TrendingService} from './trending-service.js';

export interface ChannelTransport {
  send(message: OutboundMessage): Promise<DeliveryResult>;
}

export function channelConversationKey(route: ChannelRoute): string {
  return `channel:${createHash('sha256').update(JSON.stringify([
    route.channel, route.accountId, route.roomType, route.roomId,
  ])).digest('hex')}`;
}

export type HarnessResult = 'ignored' | 'observed' | 'duplicate' | 'budget_exhausted'
  | 'accepted' | 'sent' | 'uncertain' | 'rejected' | 'failed';

const RESULT_COMMAND = /^\/result(?:\s+([0-9a-f-]+))?\s*$/i;

// Policy and budget live here, independent of the transport's platform protocol.
export class ChannelHarness {
  private readonly allowed: Set<string>;
  private readonly conversations = new Map<string, RecordedConversation>();
  private readonly storeInitialization = new StoreInitializationScope();
  private readonly outputs = new Map<string, Promise<unknown>>();
  // Durable queued payloads stay in SQLite. Optional callers awaiting completion
  // retain only resolvers; the production ingress returns after admission.
  private readonly waiters = new Map<string, { key: string; resolve: (value: HarnessResult) => void; reject: (error: unknown) => void }>();
  private readonly busyRooms = new Map<string,string>();
  private readonly isolatedRooms = new Map<string, string>();
  private nextRoom = 0;
  private readonly jobs = new Set<Promise<unknown>>();
  private computing = 0;
  private fatal: unknown;
  private readonly opening = new Map<string, Promise<RecordedConversation>>();
  private closed = false;
  private calls = 0;
  private readonly policy: HarnessPolicy;
  private readonly imageAssets: ImageAssets;
  private readonly admissions = new Map<string, Promise<unknown>>();
  private readonly admissionAbort = new AbortController();
  private readonly research?: ResearchService;
  private readonly reminders: ReminderService;
  private readonly trending?: TrendingService;

  constructor(private readonly config: PaConfig, private readonly routes: ChannelRoute[],
    private readonly transport: ChannelTransport, private readonly maxCalls: number, policy: HarnessPolicy = NO_OWNER_POLICY,
    private readonly memoryProvider?: MemoryProvider, private readonly onTaskError?: () => void,
    private readonly onTaskResult?: (result: HarnessResult) => void) {
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 0) throw new Error('调用上限必须是非负整数，0 表示不限次数。');
    if (!routes.length) throw new Error('必须显式配置允许接入的房间。');
    const concurrency = config.tasks?.maxConcurrent ?? 2;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('任务并发数必须是1到16。');
    this.allowed = new Set(routes.map(channelConversationKey));
    this.policy = validateHarnessPolicy(policy);
    this.imageAssets = new ImageAssets(config);
    this.reminders=new ReminderService(config,
      ()=>this.routes.filter(route=>{
        const key=channelConversationKey(route),room=this.conversations.get(key);
        return !this.closed&&!this.fatal&&!this.isolatedRooms.has(key)&&room?.integrityStatus().status==='healthy';
      }), (route,operation)=>this.output(route,operation),message=>this.transport.send(message),
      error=>{this.fatal=error;this.onTaskError?.();});
    if(config.trending?.enabled)this.trending=new TrendingService(config,routes,
      ()=>this.routes.filter(route=>{
        const key=channelConversationKey(route),room=this.conversations.get(key);
        return !this.closed&&!this.fatal&&!this.isolatedRooms.has(key)&&room?.integrityStatus().status==='healthy';
      }),(route,operation)=>this.output(route,operation),message=>this.transport.send(message),
      error=>{this.fatal=error;this.onTaskError?.();});
    if (config.research?.enabled) this.research = new ResearchService(config, routes,
      (message, shouldSend) => this.output(message.route, () => this.closed || (shouldSend && !shouldSend())
        ? Promise.resolve({ status: 'rejected' as const }) : this.transport.send(message)),
      () => { this.fatal = new Error('研究任务持久化失败。'); this.onTaskError?.(); });
  }

  info() { return { calls: this.calls, maxCalls: this.maxCalls, computing: this.computing,
    queued: [...this.conversations.values()].reduce((n,c) => n+c.queuedTaskCount(),0),
    deliveringRooms: this.outputs.size, outstandingRooms: this.busyRooms.size,
    isolatedRooms: [...this.isolatedRooms].map(([conversation,error]) => ({conversation,error})),
    integrity: [...this.conversations].map(([conversation,c]) => ({conversation,...c.integrityStatus()})),
    ...(this.research ? { research: this.research.info() } : {}),
    reminders:this.reminders.info(),
    ...(this.trending?{trending:this.trending.info()}:{}),
    memory: [...this.conversations].map(([key, conversation]) => ({ conversation: key, ...conversation.memoryStatus() })) }; }

  async waitForMemory(): Promise<void> {
    await Promise.all([...this.conversations.values()].map(conversation => conversation.waitForMemory()));
  }

  async waitForTasks(): Promise<void> {
    await Promise.allSettled([...this.admissions.values()]);
    this.pump();
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }

  async waitForResearch(): Promise<void> { await this.research?.wait(); }

  async start(): Promise<void> {
    if (!this.closed) {
      await Promise.all(this.routes.map(async route => {
        const key=channelConversationKey(route);
        try { await this.open(key,route); }
        catch(error) { if (!(error instanceof SessionIntegrityError)) throw error; this.isolate(key,error); }
      }));
      this.pump();
      if (!this.closed) this.research?.start();
      if (!this.closed) this.reminders.start();
      if (!this.closed) this.trending?.start();
    }
  }

  private open(key: string, route: ChannelRoute): Promise<RecordedConversation> {
    let pending = this.opening.get(key);
    if (!pending) {
      pending = openRecordedConversation(this.config, key, route,
        { persons: configuredPersons(this.policy), policy: this.policy, storeInitialization:this.storeInitialization,
          ...(this.memoryProvider ? { memoryProvider: this.memoryProvider } : {}),
          onIntegrityFailure:error=>{
            if(error instanceof SessionIntegrityError) this.isolate(key,error);
            else {this.fatal=error;this.onTaskError?.();}
          },
          reminderContext:(conversationId,sourceId)=>this.reminders.context(conversationId,sourceId),
          ...(this.research ? { researchContext: (conversationId, sourceId, send) => this.research!.context(conversationId, sourceId, send) } : {}) });
      this.opening.set(key, pending);
      pending.then(conversation => {
        this.conversations.set(key, conversation);
        if (!this.closed) this.pump();
      }).catch(() => this.opening.delete(key));
    }
    return pending;
  }

  handle(message: InboundMessage, options: { waitForResult?: boolean } = {}): Promise<HarnessResult> {
    const key = channelConversationKey(message.route);
    if (this.closed || !this.allowed.has(key) || !message.eventId || !message.senderId
      || (!message.text.trim() && !message.imageSources?.length && !message.images?.length) || message.text.length > 4000
      || !Number.isFinite(Date.parse(message.sentAt))) return Promise.resolve('ignored');
    const input = { ...message, route: { ...message.route },
      ...(message.imageSources ? { imageSources: message.imageSources.map(source=>({...source})) } : {}),
      ...(message.images ? { images: message.images.map(image=>({...image})) } : {}),
      ...(message.mentionedSenderIds ? { mentionedSenderIds: [...message.mentionedSenderIds] } : {}),
      ...(message.quote ? { quote: { ...message.quote,
        ...(message.quote.inlineMessages ? { inlineMessages: message.quote.inlineMessages.map(item => ({ ...item })) } : {}) } } : {}) };
    // Serialize only admission/preparation; model and complete output queues remain independent.
    const admitted = (this.admissions.get(key) ?? Promise.resolve()).then(() => this.accept(key, input,options.waitForResult!==false))
      .catch(error=>{
        if(!(error instanceof SessionIntegrityError)) throw error;
        this.isolate(key,error);return 'failed' as const;
      });
    this.admissions.set(key, admitted.then(() => undefined, () => undefined));
    return admitted.then(result => this.closed ? 'ignored' : typeof result === 'function' ? result() : result);
  }

  private async accept(key: string, message: InboundMessage, waitForResult: boolean): Promise<HarnessResult | (() => Promise<HarnessResult>)> {
    if (this.fatal) throw this.fatal;
    if (this.isolatedRooms.has(key)) return 'failed';
    let conversation: RecordedConversation;
    try { conversation=await this.open(key,message.route); }
    catch(error) { if (!(error instanceof SessionIntegrityError)) throw error; this.isolate(key,error); return 'failed'; }
    if (this.closed) return 'ignored';
    if (conversation.hasInbound(message.eventId)) return 'duplicate';
    if (message.imageSources?.length) {
      try {
        const images = [];
        for (const source of message.imageSources) images.push({ ...await this.imageAssets.prepare(source,this.admissionAbort.signal),
          ...(source.quoted ? { quoted: true } : {}), ...(source.referenceHash ? { referenceHash: source.referenceHash } : {}),
          ...(source.sourceSenderId ? { sourceSenderId: source.sourceSenderId } : {}) });
        const { imageSources: _sources, ...safe } = message;
        message = { ...safe, images };
      } catch (error) {
        if (!(error instanceof ImageAssetError) || error.code === 'persistence') throw error;
        if (this.closed) return 'ignored';
        const source = conversation.ingest(message.text,{eventId:message.eventId,senderId:message.senderId,
          modelInputText:message.text,sentAt:message.sentAt,imageFailure:error.code,
          ...(message.mentionedSenderIds?{mentionedSenderIds:message.mentionedSenderIds}:{}),
          ...(message.senderName?{senderName:message.senderName.slice(0,100)}:{})});
        if (!source) return 'duplicate';
        if (!this.closed && message.text.trim() && (message.route.roomType === 'private' || message.mentioned)) {
          await this.output(message.route, async () => {
            try { await this.transport.send({ route: message.route, replyToMessageId: message.eventId,
              text: error.message, deliveryMode: 'passive', plainText: true }); } catch {}
          });
        }
        return 'failed';
      }
    }
    if (this.closed) return 'ignored';
    const memoryRequest = parseMemoryRequest(message.text);
    const admission = conversation.admit(message,memoryRequest || RESULT_COMMAND.test(message.text) ? 'memory' : 'chat');
    if (!admission) return 'duplicate';
    const {task} = admission;
    if (!task) return 'observed';
    return () => {
      const completion=waitForResult ? new Promise<HarnessResult>((resolve,reject) => this.waiters.set(task.id,{key,resolve,reject}))
        : Promise.resolve<HarnessResult>('accepted');
      this.pump();
      return completion;
    };
  }

  private isolate(key: string,error: SessionIntegrityError): void {
    this.isolatedRooms.set(key,error.message);
    // Queued tasks remain durable; callers must not wait forever for an isolated room.
    for (const [id,waiting] of this.waiters) {
      if(waiting.key===key) {waiting.resolve('failed'); this.waiters.delete(id);}
    }
  }

  private pump(): void {
    while (!this.closed && !this.fatal && this.computing < (this.config.tasks?.maxConcurrent ?? 2)) {
      let selected: {key: string; conversation: RecordedConversation; task: ReturnType<RecordedConversation['claimNextTask']>} | undefined;
      try {
        for(let checked=0;checked<this.routes.length;checked++) {
          const index=(this.nextRoom+checked)%this.routes.length;
          const key=channelConversationKey(this.routes[index]!);
          const conversation=this.conversations.get(key);
          if(!conversation||this.busyRooms.has(key)||this.outputs.has(key)||this.isolatedRooms.has(key)) continue;
          let task: ReturnType<RecordedConversation['claimNextTask']>;
          try {task=conversation.claimNextTask();}
          catch(error) {if(!(error instanceof SessionIntegrityError)) throw error;this.isolate(key,error);continue;}
          if(!task) continue;
          this.nextRoom=(index+1)%this.routes.length;
          selected={key,conversation,task}; break;
        }
      } catch(error) {
        this.fatal=error;
        for(const waiting of this.waiters.values()) waiting.reject(error);
        this.waiters.clear(); this.onTaskError?.(); return;
      }
      if(!selected?.task) return;
      const {key,conversation,task}=selected;
      this.busyRooms.set(key,task.id);
      this.computing++;
      let released = false;
      const release = () => { if (!released) { released = true; this.computing--; this.pump(); } };
      const running = Promise.resolve().then(() => this.process(conversation,task.input,{id:task.messageId,
        actorId:conversation.findActor(task.input.senderId)!,senderId:task.input.senderId,text:task.input.text},task.id,release)).then(result => {
          this.waiters.get(task.id)?.resolve(result);
          this.onTaskResult?.(result);
        }).catch(error => {
          if(error instanceof SessionIntegrityError) {
            try {conversation.releaseUnstartedTask(task.id);}
            catch(persistenceError) {error=persistenceError;}
          }
          if(error instanceof SessionIntegrityError) {
            this.isolate(key,error);this.waiters.get(task.id)?.resolve('failed');this.onTaskResult?.('failed');
            return;
          }
          this.fatal=error;
          for(const waiting of this.waiters.values()) waiting.reject(error);
          this.waiters.clear(); this.onTaskError?.();
        }).finally(() => {
          this.waiters.delete(task.id); release(); this.busyRooms.delete(key); this.jobs.delete(running); this.pump();
        });
      this.jobs.add(running);
    }
  }

  private output<T>(route: ChannelRoute, operation: () => Promise<T>): Promise<T> {
    const key = channelConversationKey(route);
    const sending = (this.outputs.get(key) ?? Promise.resolve()).then(operation);
    const settled = sending.catch(() => {});
    this.outputs.set(key, settled);
    void settled.then(() => { if (this.outputs.get(key) === settled) {this.outputs.delete(key);this.pump();} });
    return sending;
  }

  private passiveAvailable(message: InboundMessage, offset: number): boolean {
    return offset < QQ_PASSIVE_REPLY_LIMIT && (message.route.channel !== 'qq' || Date.now() - Date.parse(message.sentAt) < 300_000);
  }

  private async process(conversation: RecordedConversation, message: InboundMessage, source: MemorySource,
    taskId: string, release: () => void): Promise<HarnessResult> {
    if (this.closed) {conversation.releaseUnstartedTask(taskId);return 'ignored';}
    const sender = {
      eventId: message.eventId, senderId: message.senderId, existingMessageId: source.id, taskId, sentAt: message.sentAt,
      ...(message.mentionedSenderIds ? { mentionedSenderIds: message.mentionedSenderIds } : {}),
      ...(message.senderName ? { senderName: message.senderName.slice(0, 100) } : {}),
      ...(message.quote ? { quote: message.quote } : {}),
      ...(message.images?.length ? { images: message.images } : {}),
      ...(message.route.channel === 'qq' ? { responseFormat: 'markdown' as const } : {}),
    };
    const memoryRequest = parseMemoryRequest(message.text);
    const resultRequest = RESULT_COMMAND.exec(message.text);
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
    if (this.maxCalls > 0 && this.calls >= this.maxCalls) {
      conversation.finishTask(taskId, 'failed'); release();
      await this.failureNotice(conversation,message,taskId,'本次服务的对话额度已用完，暂时无法继续回答。',0);
      return 'budget_exhausted';
    }
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
        && !this.outputs.has(channelConversationKey(message.route)), fileMessage => this.output(message.route, async () => {
          if (this.closed) return { status: 'rejected' };
          const mode = this.passiveAvailable(message, replyOffset) ? 'passive' : 'active';
          const partIndex = mode === 'passive' ? replyOffset++ : 0;
          try { return await this.transport.send({ ...fileMessage, route: message.route, deliveryMode: mode, partIndex,
            ...(mode === 'passive' ? { replyToMessageId: message.eventId } : {}), plainText: true }); }
          catch { return { status: 'uncertain' }; }
        }));
    } catch (error) {
      if (error instanceof DuplicateMessageError) { this.calls--; conversation.finishTask(taskId, 'interrupted'); return 'duplicate'; }
      if (error instanceof RequestError) {
        conversation.finishTask(taskId, this.closed ? 'interrupted' : 'failed'); release();
        const confirmed = error.confirmedActions.join('\n');
        const receipt = Buffer.from(confirmed,'utf8').subarray(0,700).toString('utf8').replace(/\ufffd$/u,'');
        if (!this.closed) await this.failureNotice(conversation,message,taskId,
          receipt ? `${receipt}\n其余操作未能确认完成，不会自动重试。`
          : error.kind==='timeout' ? '这次请求超时，未能完成答复。原消息和已保存的操作会保留，不会自动重试。'
            : '这次未能完成答复。原消息和已保存的操作会保留；你可以再发消息继续。',replyOffset);
        return 'failed';
      }
      // An API failure is recoverable on a new message; broken persistence is fatal.
      throw error;
    }
    conversation.finishTask(taskId, 'completed', reply.deliveryId);
    release();
    return this.deliver(conversation, message, reply, replyOffset, taskId);
  }

  private failureNotice(conversation: RecordedConversation, message: InboundMessage, taskId: string, text: string, offset: number): Promise<void> {
    return this.output(message.route, async () => {
      if (this.closed) return;
      const mode=this.passiveAvailable(message,offset)?'passive':'active';
      if (!conversation.reserveTaskFailure(taskId,text,mode,mode==='passive'?offset+1:undefined)) return;
      let result: DeliveryResult;
      try { result=await this.transport.send({route:message.route,deliveryMode:mode,text,plainText:true,
        ...(mode==='passive'?{replyToMessageId:message.eventId,partIndex:offset}:{})}); }
      catch { result={status:'uncertain'}; }
      conversation.ackTaskFailure(taskId,result.status,result.status==='sent'?result.externalMessageId:undefined,
        result.status==='sent'?result.referenceIndex:undefined);
    });
  }

  private async deliver(conversation: RecordedConversation, message: InboundMessage,
    reply: { text: string; deliveryId: string; referenceUrls?: readonly string[] }, replyOffset = 0, taskId?: string): Promise<HarnessResult> {
    return this.output(message.route, async () => {
    const qq = message.route.channel === 'qq';
    const renderedBody = appendReferenceUrls(reply.text, reply.referenceUrls);
    let text = renderedBody;
    let parts = qq ? splitMarkdown(text) : splitReply(text);
    const activeBatch = qq && (!this.passiveAvailable(message, replyOffset) || parts.length > QQ_PASSIVE_REPLY_LIMIT - replyOffset);
    if (activeBatch) text = `回复 ${toPlainText(message.senderName ?? '提问者').slice(0, 50)} · ${taskId?.slice(0, 8) ?? ''}\n问题：${[...toPlainText(message.text)].slice(0, 80).join('')}\n\n${text}`;
    if (activeBatch) parts = splitMarkdown(text);
    if (!parts.length) {
      conversation.acknowledge(reply.deliveryId, 'uncertain');
      return 'rejected';
    }
    if (qq) conversation.prepareMarkdownDelivery(reply.deliveryId, renderedBody, parts);
    else conversation.prepareDeliveryParts(reply.deliveryId, parts);
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
          text: part, partIndex: slot ?? partIndex, ...(qq ? { markdown: true } : {}) });
      } catch { delivery = { status: 'uncertain' }; }
      conversation.acknowledgePart(reply.deliveryId, partIndex, delivery.status,
        delivery.status === 'sent' ? delivery.externalMessageId : undefined,
        delivery.status === 'sent' ? delivery.referenceIndex : undefined);
      if (delivery.status !== 'sent') return delivery.status;
    }
    return 'sent';
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.admissionAbort.abort();
    const researchClosing = this.research?.abort();
    const reminderClosing=this.reminders.close();
    const trendingClosing=this.trending?.close();
    for (const [id,waiting] of this.waiters) if(this.busyRooms.get(waiting.key)!==id) {
      waiting.resolve('ignored'); this.waiters.delete(id);
    }
    // Abort model work first; in-flight transport receipts still need the open store.
    await Promise.all([...this.conversations.values()].map(conversation => conversation.abort()));
    await Promise.allSettled(this.opening.values());
    await Promise.allSettled(this.admissions.values());
    await Promise.all([...this.conversations.values()].map(conversation => conversation.abort()));
    await Promise.allSettled(this.jobs);
    await researchClosing;
    await this.research?.close();
    await reminderClosing;
    await trendingClosing;
    await Promise.allSettled(this.outputs.values());
    // An open operation already in progress may have completed after the first close pass.
    await Promise.all([...this.conversations.values()].map(conversation => conversation.close()));
  }
}

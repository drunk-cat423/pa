import { randomUUID } from 'node:crypto';
import type { PaConfig } from './config.js';
import { sameFact, type AutoMemoryStore } from './auto-memory-store.js';
import type { AutoMemoryJob, AutoMemoryTaskInput, ValidatedExtract, PersonProfile, ProfileFact } from './auto-memory-types.js';
import { createMemoryProvider, MemoryInputTooLargeError, type MemoryProvider } from './memory-provider.js';

type Budget = { calls: number; embeddingCalls: number };
const budgets = new WeakMap<PaConfig, Budget>();
function sharedBudget(config: PaConfig): Budget {
  let budget = budgets.get(config);
  if (!budget) { budget = { calls: 0, embeddingCalls: 0 }; budgets.set(config, budget); }
  return budget;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Reject malformed model output before any write; the store independently validates sources at commit. */
export function validateExtract(value: unknown, input: AutoMemoryTaskInput, mergedProfile = false): ValidatedExtract {
  if (!record(value) || !Array.isArray(value.topics) || !Array.isArray(value.fragments)
    || !Array.isArray(value.profiles) || !Array.isArray(value.ignoredMessageIds)) throw new Error('记忆输出必须包含结构化数组。');
  const messages = new Map(input.messages.map(message => [message.id, message]));
  const people = new Map(input.profiles.map(profile => [profile.personId, profile]));
  function text(v: unknown, max = 16000): asserts v is string {
    if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('记忆输出正文无效。');
  }
  function ids(v: unknown, allowEmpty = false): asserts v is string[] {
    if (!Array.isArray(v) || (!allowEmpty && !v.length) || new Set(v).size !== v.length
      || v.some(id => typeof id !== 'string' || !messages.has(id))) throw new Error('记忆输出引用了输入以外的消息。');
  }
  function fact(v: unknown, personId: string): void {
    if (!record(v)) throw new Error('人物事实无效。');
    text(v.content, 4000);
    if (!['self', 'third_party', 'inference'].includes(String(v.sourceType))) throw new Error('人物来源类型无效。');
    if (v.field !== undefined) text(v.field, 100);
    for (const key of ['occurredAt', 'expiresAt']) if (v[key] != null && (typeof v[key] !== 'string' || !Number.isFinite(Date.parse(v[key])))) {
      throw new Error('人物事实时间无效。');
    }
    const inherited = Array.isArray(v.messageIds) && people.get(personId)?.facts.some(old => sameFact(old, v as unknown as ProfileFact));
    if (inherited) return;
    ids(v.messageIds);
    const human = v.messageIds.map(id => messages.get(id)!).filter(message => message.role === 'user');
    if (!human.length || (v.sourceType === 'self' && human.some(message => message.personId !== personId))) {
      throw new Error('人物事实缺少本人自述或有效原始依据。');
    }
  }
  if (value.topics.length > 100 || value.fragments.length > 200 || value.profiles.length > people.size) throw new Error('记忆输出数量过大。');
  for (const topic of value.topics) {
    if (!record(topic)) throw new Error('Topic无效。');
    text(topic.summary); ids(topic.messageIds);
  }
  for (const fragment of value.fragments) {
    if (!record(fragment) || typeof fragment.personId !== 'string' || !people.has(fragment.personId)) throw new Error('人物片段身份无效。');
    fact(fragment, fragment.personId);
    if (fragment.topicIndex !== undefined && (!Number.isSafeInteger(fragment.topicIndex)
      || Number(fragment.topicIndex) < 0 || Number(fragment.topicIndex) >= value.topics.length)) throw new Error('人物片段话题索引无效。');
  }
  const updated = new Set<string>();
  for (const profile of value.profiles) {
    if (!record(profile) || typeof profile.personId !== 'string' || !people.has(profile.personId)
      || updated.has(profile.personId) || profile.baseVersion !== people.get(profile.personId)!.baseVersion
      || !Array.isArray(profile.facts) || (!mergedProfile && profile.facts.length > 200)) throw new Error('人物画像版本或结构无效。');
    updated.add(profile.personId);
    profile.facts.forEach(item => fact(item, profile.personId as string));
  }
  ids(value.ignoredMessageIds, true);
  const covered = new Set([...value.ignoredMessageIds,
    ...value.topics.flatMap(topic => (topic as { messageIds: string[] }).messageIds),
    ...value.fragments.flatMap(fragment => (fragment as { messageIds: string[] }).messageIds)]);
  if (input.messages.some(message => message.role === 'user' && !covered.has(message.id))) throw new Error('整理遗漏了真人消息。');
  if (input.roomType === 'private') text(value.continuationSummary);
  else if (value.continuationSummary !== undefined) throw new Error('群聊不生成独立群摘要。');
  return value as unknown as ValidatedExtract;
}

interface Progress {
  remaining: string[][];
  extract: ValidatedExtract;
  profiles: PersonProfile[];
  summary?: string;
}

/** One worker per conversation, independent of the chat Session and of other rooms. */
export class BackgroundMemory {
  private work: Promise<void> | undefined;
  private embeddingWork: Promise<void> | undefined;
  private closed = false;
  private readonly owner = randomUUID();
  private readonly controllers = new Set<AbortController>();
  private readonly provider: MemoryProvider;
  private readonly budget: Budget;
  private lastError: string | undefined;
  private embeddingError: string | undefined;
  private readonly timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly config: PaConfig, private readonly store: AutoMemoryStore,
    private readonly conversationId: string, provider?: MemoryProvider) {
    this.provider = provider ?? createMemoryProvider(config);
    this.budget = sharedBudget(config);
    if (config.memory?.enabled) {
      this.timer = setInterval(() => {
        try { this.start(); } catch { this.lastError = '后台任务巡检失败。'; }
      }, 1000);
      this.timer.unref();
    }
  }

  info() {
    const { summary, ...status } = this.store.status(this.conversationId);
    return { enabled: this.config.memory?.enabled === true, ...status, hasSummary: Boolean(summary),
      calls: this.budget.calls, embeddingCalls: this.budget.embeddingCalls,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      embedding: this.provider.embedding ? (this.embeddingError ?? 'configured') : 'unconfigured' };
  }

  start(reason: 'count' | 'capacity' = 'count', excludeMessageId?: string): void {
    if (this.closed || !this.config.memory?.enabled) return;
    if (reason === 'capacity') this.store.reserveBatch(this.conversationId, reason, 50, excludeMessageId);
    else while (this.store.reserveBatch(this.conversationId, reason, 50, excludeMessageId)) { /* reserve immutable batches */ }
    if (!this.work) {
      this.work = this.run().catch(() => { this.lastError = '后台持久化或任务状态异常。'; })
        .finally(() => {
          this.work = undefined;
          if (!this.closed) {
            const status = this.store.status(this.conversationId);
            if (status.queued && !status.failed && !status.running) queueMicrotask(() => this.start());
          }
        });
    }
    this.startEmbeddings();
  }

  retry(jobId: string): void {
    this.store.retry(jobId);
    this.start();
  }

  async wait(afterCompleted?: number, timeoutMs = (this.config.memory?.timeoutMs ?? 120000) * 2 + 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    do {
      const status = this.store.status(this.conversationId);
      if (this.closed || status.failed) throw new Error(this.lastError ?? '后台任务失败或已关闭。');
      if (afterCompleted !== undefined && status.completed > afterCompleted) return;
      if (!status.running && !status.queued) return;
      if (!this.config.memory?.enabled || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
      this.start();
    } while (Date.now() < deadline);
    throw new Error('记忆整理尚未完成，请检查任务状态、租约和调用预算。');
  }

  private async request<T>(kind: 'extract' | 'embedding', action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const setting = this.config.memory!;
    const key = kind === 'extract' ? 'calls' : 'embeddingCalls';
    const max = kind === 'extract' ? setting.maxCalls : setting.embedding?.maxCalls ?? 100;
    if (this.closed || this.budget[key] >= max) throw new Error('后台模型调用预算已用完或正在关闭。');
    this.budget[key]++;
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), setting.timeoutMs);
    try {
      const result = await action(controller.signal);
      if (controller.signal.aborted) throw new Error('后台调用已取消。');
      return result;
    } catch (error) {
      if (kind === 'extract' && error instanceof MemoryInputTooLargeError) this.budget.calls--;
      throw error;
    }
    finally { clearTimeout(timer); this.controllers.delete(controller); }
  }

  private async run(): Promise<void> {
    const setting = this.config.memory!;
    while (!this.closed) {
      const job = this.store.claimNext(this.conversationId, { owner: this.owner, leaseMs: setting.timeoutMs + 10000 });
      if (!job) return;
      const lease = job.leaseToken!;
      try {
        if (this.budget.calls >= setting.maxCalls) throw new Error('budget');
        const input = this.store.taskInput(job);
        const progress = this.readProgress(job, input);
        while (progress.remaining.length) {
          if (this.closed) throw new Error('closed');
          this.store.renewLease(job.id, lease, setting.timeoutMs + 10000);
          const ids = new Set(progress.remaining[0]!);
          const chunkMessages = input.messages.filter(message => ids.has(message.id));
          const people = new Set(chunkMessages.flatMap(message => message.personId ? [message.personId] : []));
          const profileView = progress.profiles.filter(profile => people.has(profile.personId))
            .map(profile => ({ ...profile, facts: [] as ProfileFact[] }));
          const profileBudget = Math.min(20000, Math.floor(this.config.contextWindow / 5));
          for (let i = 0; i < 200; i++) for (const profile of profileView) {
            const source = progress.profiles.find(p => p.personId === profile.personId)!;
            const fact = source.facts[source.facts.length - 1 - i];
            if (!fact) continue;
            profile.facts.push(fact);
            if (Buffer.byteLength(JSON.stringify(profileView)) > profileBudget) profile.facts.pop();
          }
          const chunk: AutoMemoryTaskInput = { ...input,
            messages: chunkMessages, profiles: profileView,
            ...(progress.summary ? { previousSummary: progress.summary } : {}) };
          let result: ValidatedExtract;
          try { result = validateExtract(await this.request('extract', signal => this.provider.extract(chunk, signal)), chunk); }
          catch (error) {
            if (!(error instanceof MemoryInputTooLargeError) || chunk.messages.length < 2) throw error;
            let split = Math.floor(chunk.messages.length / 2);
            if (chunk.messages[split]?.role === 'assistant') split++;
            if (split >= chunk.messages.length) throw error;
            progress.remaining.splice(0, 1, chunk.messages.slice(0, split).map(message => message.id),
              chunk.messages.slice(split).map(message => message.id));
            this.store.saveProgress(job.id, lease, progress);
            continue;
          }
          const offset = progress.extract.topics.length;
          progress.extract.topics.push(...result.topics);
          progress.extract.fragments.push(...result.fragments.map(fragment => ({ ...fragment,
            ...(fragment.topicIndex === undefined ? {} : { topicIndex: fragment.topicIndex + offset }) })));
          progress.extract.ignoredMessageIds.push(...result.ignoredMessageIds);
          for (const profile of result.profiles) {
            const original = progress.profiles.find(old => old.personId === profile.personId)!;
            const viewed = profileView.find(old => old.personId === profile.personId)!;
            const unseen = original.facts.filter(fact => !viewed.facts.some(old => sameFact(old, fact))
              && !profile.facts.some(next => sameFact(next, fact) || (next.field !== undefined && next.field === fact.field)));
            profile.facts = [...unseen, ...profile.facts];
            progress.profiles = progress.profiles.map(old => old.personId === profile.personId ? profile : old);
            progress.extract.profiles = progress.extract.profiles.filter(old => old.personId !== profile.personId);
            progress.extract.profiles.push(profile);
          }
          if (result.continuationSummary !== undefined) {
            progress.summary = result.continuationSummary;
            progress.extract.continuationSummary = result.continuationSummary;
          }
          progress.remaining.shift();
          this.store.saveProgress(job.id, lease, progress);
        }
        this.store.commit(job.id, lease, validateExtract(progress.extract, input, true));
        this.lastError = undefined;
        this.startEmbeddings();
      } catch (error) {
        this.lastError = this.closed ? '后台整理已取消。' : '后台整理失败；原文和批次已保留，可检查并重试。';
        const conflict = error instanceof Error && /版本冲突|输入版本/.test(error.message);
        if (conflict) this.store.clearProgress(job.id, lease);
        this.store.fail(job.id, lease, conflict ? 'profile_conflict' : this.lastError);
        if (this.closed) { this.store.retry(job.id); return; }
        if (job.attempts < setting.maxRetries && this.budget.calls < setting.maxCalls) this.store.retry(job.id);
        else return;
      }
    }
  }

  private readProgress(job: AutoMemoryJob, input: AutoMemoryTaskInput): Progress {
    const existing = this.store.loadProgress(job.id, job.leaseToken!);
    if (existing !== undefined && existing !== null) {
      if (!record(existing) || !Array.isArray(existing.remaining) || !record(existing.extract)
        || !Array.isArray(existing.profiles)) throw new Error('后台整理检查点损坏。');
      const available = new Set(input.messages.map(message => message.id));
      if (existing.remaining.some(ids => !Array.isArray(ids) || ids.some(id => !available.has(id)))) throw new Error('后台检查点来源不匹配。');
      return existing as unknown as Progress;
    }
    return { remaining: [input.messages.map(message => message.id)], profiles: input.profiles,
      extract: { topics: [], fragments: [], profiles: [], ignoredMessageIds: [] },
      ...(input.previousSummary ? { summary: input.previousSummary } : {}) };
  }

  private startEmbeddings(): void {
    const embedding = this.provider.embedding;
    if (this.closed || !this.config.memory?.enabled || !embedding || this.embeddingWork) return;
    this.embeddingWork = (async () => {
      for (const topic of this.store.pendingTopicsForConversation(this.conversationId, embedding)) {
        if (this.closed) return;
        const vector = await this.request('embedding', signal => embedding.embed(topic.summary, signal));
        this.store.saveEmbedding(topic.id, { model: embedding.model, dimensions: embedding.dimensions,
          inputVersion: embedding.inputVersion, vector, topicVersion: topic.version, contentHash: topic.contentHash });
      }
      this.embeddingError = undefined;
    })().catch(() => { this.embeddingError = 'failed_or_budget_exhausted'; })
      .finally(() => { this.embeddingWork = undefined; });
  }

  async retrieve(query: string) {
    const embedding = this.provider.embedding;
    if (!this.config.memory?.enabled || !embedding) return { status: 'unavailable' as const, topics: [] };
    try {
      const vector = await this.request('embedding', signal => embedding.embed(query, signal));
      return this.store.searchTopics(this.conversationId, { model: embedding.model, dimensions: embedding.dimensions,
        inputVersion: embedding.inputVersion, vector, limit: 5 });
    } catch { this.embeddingError = 'failed_or_budget_exhausted'; return { status: 'unavailable' as const, topics: [] }; }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([this.work, this.embeddingWork]);
  }
}

import { randomUUID } from 'node:crypto';
import type { PaConfig } from './config.js';
import { ObsoletePersonalMemoryError, assertCurrentMemoryProtocol, mergeProfileFacts, sameFact, sameFactContent, type AutoMemoryStore } from './auto-memory-store.js';
import type { AutoMemoryJob, AutoMemoryTaskInput, ValidatedExtract, PersonProfile, ProfileFact } from './auto-memory-types.js';
import { createMemoryProvider, MemoryInputTooLargeError, type MemoryProvider } from './memory-provider.js';
import { selfProfileBudget, validateSelfProfileProposal } from './self-profile-store.js';
import { memoryFailure } from './memory-diagnostics.js';

type Budget = { calls: number };
const budgets = new WeakMap<PaConfig, Budget>();
function sharedBudget(config: PaConfig): Budget {
  let budget = budgets.get(config);
  if (!budget) { budget = { calls: 0 }; budgets.set(config, budget); }
  return budget;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Reject malformed model output before any write; the store independently validates sources at commit. */
export function validateExtract(value: unknown, input: AutoMemoryTaskInput, mergedProfile = false): ValidatedExtract {
  if (!record(value) || !Array.isArray(value.topics) || !Array.isArray(value.fragments)
    || !Array.isArray(value.profiles) || !Array.isArray(value.ignoredMessageIds)) throw new Error('记忆输出必须包含结构化数组。');
  assertCurrentMemoryProtocol(input); assertCurrentMemoryProtocol(value);
  const excludedProfileSources = new Set(input.excludedProfileSourceIds ?? []);
  if ((input.profileFragments ?? []).some(fragment => fragment.messageIds.some(id => excludedProfileSources.has(id)))
    || input.profiles.some(profile => (profile.pending ?? []).some(pending => excludedProfileSources.has(pending.sourceMessageId)))) {
    throw new ObsoletePersonalMemoryError();
  }
  const messages = new Map(input.messages.map(message => [message.id, message]));
  const people = new Map(input.profiles.map(profile => [profile.personId, profile]));
  const conversationId = input.job?.conversationId ?? input.messages[0]?.conversationId;
  const topicSources = messages;
  function text(v: unknown, max = 16000): asserts v is string {
    if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('记忆输出正文无效。');
  }
  function ids(v: unknown, allowEmpty = false, sources = messages): asserts v is string[] {
    if (!Array.isArray(v) || (!allowEmpty && !v.length) || new Set(v).size !== v.length
      || v.some(id => typeof id !== 'string' || !sources.has(id))) throw new Error('记忆输出引用了输入以外的消息。');
  }
  function fact(v: unknown, personId: string, profileFact = false): void {
    if (!record(v)) throw new Error('人物事实无效。');
    text(v.content, 4000);
    if (!['self', 'third_party', 'inference'].includes(String(v.sourceType))) throw new Error('人物来源类型无效。');
    if (v.field !== undefined && !mergedProfile) throw new Error('人物事实不能输出分类字段。');
    for (const key of ['occurredAt', 'expiresAt']) if (v[key] != null && (typeof v[key] !== 'string' || !Number.isFinite(Date.parse(v[key])))) {
      throw new Error('人物事实时间无效。');
    }
    const inherited = profileFact && Array.isArray(v.messageIds) && people.get(personId)?.facts.some(old => sameFact(old, v as unknown as ProfileFact));
    if (inherited) return;
    if (profileFact && Array.isArray(v.messageIds) && v.messageIds.some(id => input.excludedProfileSourceIds?.includes(id))) {
      throw new ObsoletePersonalMemoryError();
    }
    const captured = profileFact ? people.get(personId)?.pending ?? [] : [];
    const priorIds = new Set(profileFact ? [...(input.profileFragments ?? []).filter(fragment => fragment.personId === personId).flatMap(fragment => fragment.messageIds),
      ...(people.get(personId)?.facts ?? []).filter(old => sameFactContent(old, v as unknown as ProfileFact)).flatMap(old => old.messageIds)] : []);
    const allowed = new Map([...input.messages,...(input.profileSources ?? []).filter(message => captured.some(item => item.sourceMessageId === message.id)||priorIds.has(message.id))]
      .map(message => [message.id,message]));
    if (!Array.isArray(v.messageIds) || !v.messageIds.length || new Set(v.messageIds).size !== v.messageIds.length
      || v.messageIds.some(id => typeof id !== 'string' || !allowed.has(id) || allowed.get(id)!.role !== 'user')) throw new Error('人物事实必须引用有效原始真人消息。');
    const human = v.messageIds.map(id => allowed.get(id)!);
    if (!human.length || (v.sourceType === 'self' && human.some(message => message.personId !== personId))) {
      throw new Error('人物事实缺少本人自述或有效原始依据。');
    }
  }
  if (value.topics.length > 100 || value.fragments.length > 200 || value.profiles.length > people.size) throw new Error('记忆输出数量过大。');
  for (const topic of value.topics) {
    if (!record(topic)) throw new Error('Topic无效。');
    text(topic.summary); ids(topic.messageIds, false, topicSources);
    if (topic.messageIds.some(id=>topicSources.get(id)?.conversationId!==conversationId)) throw new Error('Topic来源必须属于当前会话。');
  }
  for (const fragment of value.fragments) {
    if (!record(fragment) || typeof fragment.personId !== 'string' || !people.has(fragment.personId)) throw new Error('人物片段身份无效。');
    fact(fragment, fragment.personId);
    if ((fragment.messageIds as string[]).some(id => excludedProfileSources.has(id))) throw new ObsoletePersonalMemoryError();
    if (input.roomType === 'private' && ![...people.get(fragment.personId)!.facts,
      ...value.profiles.filter(profile => record(profile) && profile.personId === fragment.personId)
        .flatMap(profile => record(profile) && Array.isArray(profile.facts) ? profile.facts : [])]
      .some(fact => record(fact) && sameFactContent(fact as unknown as ProfileFact, fragment as unknown as ProfileFact)
        && Array.isArray(fact.messageIds) && (fragment.messageIds as string[]).every(id => (fact.messageIds as unknown[]).includes(id)))) {
      throw new Error('私聊人物片段只能保存稳定画像证据。');
    }
    if (fragment.topicIndex !== undefined && (!Number.isSafeInteger(fragment.topicIndex)
      || Number(fragment.topicIndex) < 0 || Number(fragment.topicIndex) >= value.topics.length)) throw new Error('人物片段话题索引无效。');
  }
  const updated = new Set<string>();
  for (const profile of value.profiles) {
    if (!record(profile) || typeof profile.personId !== 'string' || !people.has(profile.personId)
      || updated.has(profile.personId) || profile.baseVersion !== people.get(profile.personId)!.baseVersion
      || !Array.isArray(profile.facts) || (!mergedProfile && profile.facts.length > 200)) throw new Error('人物画像版本或结构无效。');
    updated.add(profile.personId);
    profile.facts.forEach(item => fact(item, profile.personId as string, true));
    if (profile.pendingIds !== undefined && (!Array.isArray(profile.pendingIds) || new Set(profile.pendingIds).size !== profile.pendingIds.length
      || profile.pendingIds.some(id => {
        const pending = people.get(profile.personId as string)!.pending?.find(item => item.id === id);
        return !pending || !(profile.facts as ProfileFact[]).some(item => item.messageIds.includes(pending.sourceMessageId));
      }))) throw new Error('只能归档已捕获且保留来源的人物待整理条目。');
  }
  ids(value.ignoredMessageIds, true);
  if (value.ignoredMessageIds.some(id => messages.get(id)?.role !== 'user')) throw new Error('忽略项只能引用真人消息。');
  const covered = new Set([...value.ignoredMessageIds,
    ...value.topics.flatMap(topic => (topic as { messageIds: string[] }).messageIds),
    ...value.fragments.flatMap(fragment => (fragment as { messageIds: string[] }).messageIds)]);
  if (input.messages.some(message => message.role === 'user' && !covered.has(message.id))) throw new Error('整理遗漏了真人消息。');
  if (input.roomType === 'private') text(value.continuationSummary);
  else if (value.continuationSummary !== undefined) throw new Error('群聊不生成独立群摘要。');
  if (value.selfProfile !== undefined) {
    if (!input.selfProfile) throw new Error('自我画像缺少输入快照。');
    validateSelfProfileProposal(value.selfProfile, input.selfProfile, input.messages, input.selfProfileBudgetBytes);
  }
  const result = value as unknown as ValidatedExtract;
  return { ...result, profiles: result.profiles.map(profile => ({ ...profile, facts: mergeProfileFacts(profile.facts) })) };
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
  private closed = false;
  private readonly owner = randomUUID();
  private readonly controllers = new Set<AbortController>();
  private readonly provider: MemoryProvider;
  private readonly budget: Budget;
  private lastError: string | undefined;
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
      calls: this.budget.calls,
      ...(this.lastError ? { lastError: this.lastError } : {}) };
  }

  start(reason: 'count' | 'capacity' = 'count', excludeMessageId?: string): void {
    if (this.closed || !this.config.memory?.enabled) return;
    if (reason === 'capacity') this.store.reserveBatch(this.conversationId, reason, 50, excludeMessageId);
    else while (this.store.reserveBatch(this.conversationId, reason, 50, excludeMessageId)) { /* reserve immutable batches */ }
    if (!this.work) {
      this.work = this.run().catch(error => { this.lastError = memoryFailure(error, 'worker'); })
        .finally(() => {
          this.work = undefined;
          if (!this.closed) {
            const status = this.store.status(this.conversationId);
            if (status.queued && !status.failed && !status.running) queueMicrotask(() => this.start());
          }
        });
    }
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

  private async request<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const setting = this.config.memory!;
    const max = setting.maxCalls;
    if (this.closed || (max > 0 && this.budget.calls >= max)) {
      throw new Error('后台模型调用预算已用完或正在关闭。');
    }
    this.budget.calls++;
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), setting.timeoutMs);
    try {
      const result = await action(controller.signal);
      if (controller.signal.aborted) throw new Error('后台调用已取消。');
      return result;
    } catch (error) {
      if (error instanceof MemoryInputTooLargeError) this.budget.calls--;
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
      let phase = 'input';
      try {
        if (setting.maxCalls > 0 && this.budget.calls >= setting.maxCalls) throw new Error('budget');
        const input: AutoMemoryTaskInput = { ...this.store.taskInput(job), selfProfileBudgetBytes: selfProfileBudget(this.config.contextWindow) };
        assertCurrentMemoryProtocol(input);
        this.store.assertProfileEvidenceCurrent(input);
        const progress = this.readProgress(job, input);
        while (progress.remaining.length) {
          if (this.closed) throw new Error('closed');
          this.store.renewLease(job.id, lease, setting.timeoutMs + 10000);
          const ids = new Set(progress.remaining[0]!);
          const chunkMessages = input.messages.filter(message => ids.has(message.id));
          const people = new Set(chunkMessages.flatMap(message => message.personId ? [message.personId] : []));
          for (const profile of progress.profiles) if (profile.pending?.length) people.add(profile.personId);
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
            profileFragments: (input.profileFragments ?? []).filter(fragment => people.has(fragment.personId)),
            profileSources: (input.profileSources ?? []).filter(message=>profileView.some(profile=>(profile.pending??[]).some(item=>item.sourceMessageId===message.id)
              || profile.facts.some(fact => fact.messageIds.includes(message.id)))
              || (input.profileFragments ?? []).some(fragment => people.has(fragment.personId) && fragment.messageIds.includes(message.id))),
            ...(progress.summary ? { previousSummary: progress.summary } : {}) };
          if (input.selfProfile && progress.extract.selfProfile) {
            const previous = progress.extract.selfProfile;
            chunk.selfProfile = { baseVersion: previous.baseVersion, content: previous.content,
              sourceMessageIds: previous.sourceMessageIds,
              pending: input.selfProfile.pending.filter(item => !previous.pendingIds.includes(item.id)) };
          }
          let result: ValidatedExtract;
          try {
            phase = 'extract';
            const proposal = await this.request(signal => this.provider.extract(chunk, signal));
            phase = 'validate'; result = validateExtract(proposal, chunk);
            this.store.assertProfileEvidenceCurrent(input, result);
          }
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
              && !profile.facts.some(next => sameFact(next, fact)));
            profile.facts = mergeProfileFacts([...unseen, ...profile.facts]);
            profile.pendingIds = [...new Set([...(progress.extract.profiles.find(old=>old.personId===profile.personId)?.pendingIds ?? []),...(profile.pendingIds ?? [])])];
            profile.pending = (original.pending ?? []).filter(item=>!profile.pendingIds!.includes(item.id));
            progress.profiles = progress.profiles.map(old => old.personId === profile.personId ? profile : old);
            progress.extract.profiles = progress.extract.profiles.filter(old => old.personId !== profile.personId);
            progress.extract.profiles.push(profile);
          }
          if (result.continuationSummary !== undefined) {
            progress.summary = result.continuationSummary;
            progress.extract.continuationSummary = result.continuationSummary;
          }
          if (result.selfProfile) {
            const pendingIds = [...new Set([...(progress.extract.selfProfile?.pendingIds ?? []), ...result.selfProfile.pendingIds])];
            const archivedSources = input.selfProfile?.pending.filter(item => pendingIds.includes(item.id)).map(item => item.sourceMessageId) ?? [];
            const mergedSelf = { ...result.selfProfile, pendingIds,
              sourceMessageIds: [...new Set([...result.selfProfile.sourceMessageIds, ...archivedSources])] };
            validateSelfProfileProposal(mergedSelf, input.selfProfile!, input.messages, input.selfProfileBudgetBytes);
            progress.extract.selfProfile = mergedSelf;
          }
          progress.remaining.shift();
          phase = 'checkpoint'; this.store.saveProgress(job.id, lease, progress);
        }
        phase = 'validate';
        const completed = validateExtract(progress.extract, input, true);
        phase = 'commit';
        this.store.commit(job.id, lease, completed, input.selfProfileBudgetBytes);
        this.lastError = undefined;
      } catch (error) {
        this.lastError = `后台整理失败；${memoryFailure(error, phase)}`;
        const conflict = error instanceof Error && /版本冲突|输入版本/.test(error.message);
        if (conflict) this.store.clearProgress(job.id, lease);
        this.store.fail(job.id, lease, this.lastError);
        // A failed/aborted request may have been billed or completed upstream. Only explicit retry may call again.
        return;
      }
    }
  }

  private readProgress(job: AutoMemoryJob, input: AutoMemoryTaskInput): Progress {
    const existing = this.store.loadProgress(job.id, job.leaseToken!);
    if (existing !== undefined && existing !== null) {
      assertCurrentMemoryProtocol(existing);
      if (!record(existing) || !Array.isArray(existing.remaining) || !record(existing.extract)
        || !Array.isArray(existing.profiles)) throw new Error('后台整理检查点损坏。');
      const available = new Set(input.messages.map(message => message.id));
      if (existing.remaining.some(ids => !Array.isArray(ids) || ids.some(id => !available.has(id)))) throw new Error('后台检查点来源不匹配。');
      this.store.assertProfileEvidenceCurrent(input, existing.extract as unknown as ValidatedExtract);
      this.store.assertProfileEvidenceCurrent(input, { profiles: existing.profiles as PersonProfile[] });
      return existing as unknown as Progress;
    }
    return { remaining: [input.messages.map(message => message.id)], profiles: input.profiles,
      extract: { topics: [], fragments: [], profiles: [], ignoredMessageIds: [] },
      ...(input.previousSummary ? { summary: input.previousSummary } : {}) };
  }

  async retrieve(query: string, signal?: AbortSignal) {
    if (!this.config.memory?.enabled || signal?.aborted) return { status: 'unavailable' as const, topics: [] };
    return this.store.searchTopics(this.conversationId, { text: query, limit: 5 });
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([this.work]);
  }
}

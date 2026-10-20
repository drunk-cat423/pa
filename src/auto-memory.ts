import { randomUUID } from 'node:crypto';
import type { PaConfig } from './config.js';
import { ObsoletePersonalMemoryError, assertCurrentMemoryProtocol, mergeProfileFacts, sameFact, sameFactContent, type AutoMemoryStore } from './auto-memory-store.js';
import type { AutoMemoryJob, AutoMemoryTaskInput, AutoMemoryPipeline, ValidatedExtract, PersonProfile, ProfileFact } from './auto-memory-types.js';
import { createMemoryProvider, MemoryInputTooLargeError, type MemoryProvider } from './memory-provider.js';
import { selfProfileBudget, validateSelfProfileProposal } from './self-profile-store.js';
import { memoryFailure, memoryFailurePhase, MemoryProviderError } from './memory-diagnostics.js';
import { DiagnosticLog, DiagnosticPersistenceError, type DiagnosticContext } from './diagnostics.js';
import { assertProfileCapacity, profileCapacity } from './profile-limits.js';
import { assertProfileEvidenceStrength, assertProfileProtocol, PersonProfileProtocolError, validateProfilePendingResults } from './profile-pending.js';
import { assertMemoryOutputFits, assertMemorySourceRange, assertProcessedRanges, COMPACT_TOPIC_LIMITS,
  memoryOutputBudget, memorySourceRange, MemoryOutputBudgetError } from './memory-work.js';

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
  const compact = input.extractionProtocol === 2;
  if (compact && input.mode === 'self' && record(value)) {
    const proposal = value;
    if (['topics', 'fragments', 'profiles', 'ignoredMessageIds'].some(key => proposal[key] !== undefined
      && (!Array.isArray(proposal[key]) || proposal[key].length > 0)) || value.continuationSummary !== undefined
      || !value.selfProfile) throw new Error('自我画像步骤只能返回自我画像。');
    value = { ...value, topics: [], fragments: [], profiles: [], ignoredMessageIds: [] };
  }
  if (input.mode === 'profiles' && record(value)) {
    const proposal = value;
    if (['topics', 'fragments', 'ignoredMessageIds'].some(key => proposal[key] !== undefined
      && (!Array.isArray(proposal[key]) || proposal[key].length > 0))
      || value.continuationSummary !== undefined || value.selfProfile !== undefined) throw new Error('画像任务只能返回人物画像。');
    value = { ...value, topics: [], fragments: [], ignoredMessageIds: [] };
  }
  if (!record(value) || !Array.isArray(value.topics) || !Array.isArray(value.fragments)
    || !Array.isArray(value.profiles) || !Array.isArray(value.ignoredMessageIds)) throw new Error('记忆输出必须包含结构化数组。');
  if (input.pipeline === 'compression' && (value.topics.length || value.fragments.length || value.profiles.length
    || value.ignoredMessageIds.length || value.selfProfile !== undefined)) throw new Error('对话压缩不能修改资料。');
  if (input.pipeline === 'materials' && value.continuationSummary !== undefined) throw new Error('资料整理不能修改续聊摘要。');
  if (compact && (value.ignoredMessageIds.length || value.fragments.length)) throw new Error('新整理协议不接受逐条覆盖清单或人物事件片段。');
  if (input.mode === 'messages' && (value.profiles.length || (input.roomType === 'private' && value.fragments.length))) {
    throw new Error('消息任务不能修改人物画像或生成私聊人物片段。');
  }
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
    // Retaining an already archived fact is not a new conversion of an old event.
    // A source message may contain both an old event and a legitimate stable fact.
    if (inherited) return;
    if (profileFact && Array.isArray(v.messageIds) && v.messageIds.some(id => input.excludedProfileSourceIds?.includes(id))) {
      throw new ObsoletePersonalMemoryError();
    }
    const captured = profileFact ? people.get(personId)?.pending ?? [] : [];
    const priorIds = new Set(profileFact ? [...(input.profileFragments ?? []).filter(fragment => fragment.personId === personId).flatMap(fragment => fragment.messageIds),
      ...(people.get(personId)?.facts ?? []).filter(old => input.profileProtocol === 2 || sameFactContent(old, v as unknown as ProfileFact)).flatMap(old => old.messageIds)] : []);
    const allowed = new Map([...input.messages,...(input.profileSources ?? []).filter(message => captured.some(item => item.sourceMessageId === message.id)||priorIds.has(message.id))]
      .map(message => [message.id,message]));
    if (!Array.isArray(v.messageIds) || !v.messageIds.length || new Set(v.messageIds).size !== v.messageIds.length
      || v.messageIds.some(id => typeof id !== 'string' || !allowed.has(id) || allowed.get(id)!.role !== 'user')) throw new Error('人物事实必须引用有效原始真人消息。');
    const human = v.messageIds.map(id => allowed.get(id)!);
    if (!human.length || (v.sourceType === 'self' && human.some(message => message.personId !== personId))) {
      throw new Error('人物事实缺少本人自述或有效原始依据。');
    }
    if (input.profileProtocol === 2 && profileFact && !inherited) {
      assertProfileEvidenceStrength(v as unknown as ProfileFact, people.get(personId)!, input);
    }
  }
  // Each provider result is bounded; the trusted aggregate may contain many
  // independently validated chunks from a capacity snapshot larger than 50 messages.
  if ((!mergedProfile && (value.topics.length > 100 || value.fragments.length > 200))
    || value.profiles.length > people.size) throw new Error('记忆输出数量过大。');
  for (const topic of value.topics) {
    if (!record(topic)) throw new Error('Topic无效。');
    text(topic.summary);
    if (compact) {
      if (!Array.isArray(topic.messageIds) || topic.messageIds.length || [...String(topic.summary)].length > COMPACT_TOPIC_LIMITS.characters
        || (!mergedProfile && topic.sourceRange !== undefined)) throw new Error('Topic只能包含有界摘要，来源范围由程序记录。');
      if (mergedProfile) assertMemorySourceRange(topic.sourceRange as Parameters<typeof assertMemorySourceRange>[0], input.job.messageIds.length);
    } else ids(topic.messageIds, false, topicSources);
    if (topic.messageIds.some(id=>topicSources.get(id)?.conversationId!==conversationId)) throw new Error('Topic来源必须属于当前会话。');
  }
  if (compact && !mergedProfile) {
    const limits = input.outputBudget;
    if (value.topics.length > (limits?.topicCount ?? COMPACT_TOPIC_LIMITS.count)
      || value.topics.reduce((sum, topic) => sum + [...String((topic as {summary: string}).summary)].length, 0)
        > (limits?.topicTotalCharacters ?? COMPACT_TOPIC_LIMITS.totalCharacters)) throw new Error('Topic摘要超过本步骤输出预算。');
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
    if (input.profileProtocol !== 2 && profile.pendingIds !== undefined && (!Array.isArray(profile.pendingIds) || new Set(profile.pendingIds).size !== profile.pendingIds.length
      || profile.pendingIds.some(id => {
        const pending = people.get(profile.personId as string)!.pending?.find(item => item.id === id);
        return !pending || !(profile.facts as ProfileFact[]).some(item => item.messageIds.includes(pending.sourceMessageId));
      }))) throw new Error('只能归档已捕获且保留来源的人物待整理条目。');
  }
  if (input.profileProtocol === 2 && input.mode !== 'messages' && input.mode !== 'self') for (const baseline of input.profiles) {
    const capacity = profileCapacity(baseline);
    if ((input.mode === 'profiles' || baseline.pending?.length || capacity.needsConsolidation || capacity.exceedsLimits)
      && !updated.has(baseline.personId)) throw new Error('人物画像整理遗漏了必须收敛或处理待办的人物。');
  }
  ids(value.ignoredMessageIds, true);
  if (value.ignoredMessageIds.some(id => messages.get(id)?.role !== 'user')) throw new Error('忽略项只能引用真人消息。');
  const covered = new Set([...value.ignoredMessageIds,
    ...value.topics.flatMap(topic => (topic as { messageIds: string[] }).messageIds),
    ...value.fragments.flatMap(fragment => (fragment as { messageIds: string[] }).messageIds)]);
  if (!compact && input.mode !== 'profiles' && input.messages.some(message => message.role === 'user' && !covered.has(message.id))) throw new Error('整理遗漏了真人消息。');
  if (input.pipeline !== 'materials' && (input.roomType === 'private' || input.contextProtocol === 1) && input.mode !== 'profiles' && input.mode !== 'self') {
    text(value.continuationSummary);
    if (compact && [...String(value.continuationSummary)].length > (input.outputBudget?.summaryCharacters ?? 2000)) throw new Error('续聊摘要超过本步骤输出预算。');
  }
  else if (value.continuationSummary !== undefined) throw new Error('群聊不生成独立群摘要。');
  if (value.selfProfile !== undefined) {
    if (!input.selfProfile) throw new Error('自我画像缺少输入快照。');
    validateSelfProfileProposal(value.selfProfile, input.selfProfile, input.messages, input.selfProfileBudgetBytes);
  }
  const result = value as unknown as ValidatedExtract;
  const range = compact && input.messages.length > 0 && !mergedProfile && input.mode !== 'profiles' && input.mode !== 'self' ? memorySourceRange(input) : undefined;
  if (compact && mergedProfile) {
    assertProcessedRanges(result.processedRanges, input.job.messageIds.length);
    for (const topic of result.topics) if (!result.processedRanges!.some(range =>
      range.startOrdinal === topic.sourceRange!.startOrdinal && range.endOrdinal === topic.sourceRange!.endOrdinal)) {
      throw new Error('Topic来源没有对应的整理完成回执。');
    }
  }
  return { ...result, ...(range ? { processedRanges: [range], topics: result.topics.map(topic => ({ ...topic, sourceRange: range })) } : {}),
    profiles: result.profiles.map(profile => {
    const normalized = { ...profile, facts: mergeProfileFacts(profile.facts) };
    if (input.profileProtocol === 2) {
      // Pending indices refer to the submitted array; exact duplicate merging can move them.
      if (Array.isArray(profile.pendingResults)) normalized.pendingResults = profile.pendingResults.map(outcome => {
        const target = outcome.status === 'merged' && Number.isSafeInteger(outcome.factIndex) && outcome.factIndex >= 0
          ? profile.facts[outcome.factIndex] : undefined;
        return outcome.status === 'merged' && target ? { ...outcome,
          factIndex: normalized.facts.findIndex(fact => sameFactContent(fact, target)) } : outcome;
      });
      normalized.pendingResults = validateProfilePendingResults(normalized, people.get(profile.personId)!, input);
      assertProfileCapacity(normalized);
    }
    return normalized;
  }) };
}

interface WorkItem {
  mode?: 'messages' | 'profiles' | 'self';
  messageIds: string[];
  personIds: string[];
  pendingIds?: string[];
}
interface Progress {
  version: 2 | 3;
  remaining: WorkItem[];
  extract: ValidatedExtract;
  profiles: PersonProfile[];
  summary?: string;
}

/** Local maintenance may drain a frozen set without observing or reserving new work. */
export interface MemoryExecutionScope {
  pipeline: 'materials';
  jobIds: readonly string[];
}

/** One worker per conversation, independent of the chat Session and of other rooms. */
export class BackgroundMemory {
  private readonly work = new Map<AutoMemoryPipeline, Promise<void>>();
  private readonly pipelineErrors = new Map<AutoMemoryPipeline, string>();
  private closed = false;
  private diagnosticFailed = false;
  private diagnostics: DiagnosticLog | undefined;
  private readonly owner = randomUUID();
  private readonly controllers = new Set<AbortController>();
  private readonly provider: MemoryProvider;
  private readonly budget: Budget;
  private lastError: string | undefined;
  private readonly timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly config: PaConfig, private readonly store: AutoMemoryStore,
    private readonly conversationId: string, provider?: MemoryProvider, private readonly scope?: MemoryExecutionScope) {
    if (scope) {
      if (scope.pipeline !== 'materials' || !scope.jobIds.length || new Set(scope.jobIds).size !== scope.jobIds.length
        || scope.jobIds.some(id => typeof id !== 'string' || !id)) throw new Error('回填执行范围无效。');
      this.scope = { pipeline: scope.pipeline, jobIds: [...scope.jobIds] };
      const status = this.store.status(conversationId, scope.pipeline, scope.jobIds);
      if (status.queued + status.running + status.failed + status.completed + status.deferred + (status.retired ?? 0)
        + (status.isolated ?? 0) !== scope.jobIds.length) throw new Error('回填任务范围与当前会话不一致。');
    }
    this.provider = provider ?? createMemoryProvider(config);
    this.budget = sharedBudget(config);
    if (config.memory?.enabled && !scope) {
      this.timer = setInterval(() => {
        try { this.start(); } catch {
          this.lastError = '后台任务持久化巡检失败，工作器已停止。';
          this.diagnosticFailed = true;
          for (const controller of this.controllers) controller.abort();
        }
      }, 1000);
      this.timer.unref();
    }
  }

  info(pipeline?: AutoMemoryPipeline) {
    const effectivePipeline = pipeline ?? this.scope?.pipeline;
    const { summary, ...status } = this.store.status(this.conversationId, effectivePipeline, this.scope?.jobIds);
    const lastError = effectivePipeline ? this.pipelineErrors.get(effectivePipeline) : this.lastError;
    return { enabled: this.config.memory?.enabled === true, ...status, hasSummary: Boolean(summary),
      ...(status.deferred ? { deferredRanges: this.store.deferredRanges(this.conversationId) } : {}),
      calls: this.budget.calls,
      ...(pipeline || this.scope ? {} : { compression: this.store.status(this.conversationId, 'compression'),
        materials: { ...this.store.status(this.conversationId, 'materials'), ...this.store.materialSchedule(this.conversationId) } }),
      ...(lastError ? { lastError } : {}) };
  }

  start(reason?: 'count' | 'capacity', excludeMessageId?: string): void {
    if (this.closed || this.diagnosticFailed || !this.config.memory?.enabled) return;
    if (this.scope && (reason !== undefined || excludeMessageId !== undefined)) throw new Error('回填执行不能预约新的整理或压缩任务。');
    if (!this.scope) {
      if (reason === 'capacity') this.store.reserveCompressionBatch(this.conversationId, excludeMessageId);
      this.store.reserveMaterialsIfDue(this.conversationId);
    }
    const pipelines = this.scope ? [this.scope.pipeline] : ['compression', 'materials', 'legacy'] as const;
    for (const pipeline of pipelines) if (!this.work.has(pipeline)) {
      const work = this.run(pipeline).catch(error => {
        this.lastError = memoryFailure(error, 'worker');
        this.pipelineErrors.set(pipeline, this.lastError);
        this.diagnosticFailed = true;
        for (const controller of this.controllers) controller.abort();
      })
        .finally(() => {
          this.work.delete(pipeline);
          if (!this.closed && !this.diagnosticFailed && !this.scope) {
            const status = this.store.status(this.conversationId, pipeline);
            if (status.queued && !status.failed && !status.running) queueMicrotask(() => this.start());
          }
        });
      this.work.set(pipeline, work);
    }
  }

  retry(jobId: string): void {
    if (this.diagnosticFailed) throw new DiagnosticPersistenceError();
    if (this.scope && !this.scope.jobIds.includes(jobId)) throw new Error('不能重试本次回填范围外的任务。');
    this.store.retry(jobId);
    this.start();
  }

  async wait(afterCompleted?: number, timeoutMs = (this.config.memory?.timeoutMs ?? 120000) * 2 + 10000,
    pipeline?: AutoMemoryPipeline): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const effectivePipeline = pipeline ?? this.scope?.pipeline;
    do {
      const status = this.store.status(this.conversationId, effectivePipeline, this.scope?.jobIds);
      if (this.closed || this.diagnosticFailed || status.failed) throw new Error((effectivePipeline ? this.pipelineErrors.get(effectivePipeline) : this.lastError) ?? '后台任务失败或已关闭。');
      if (afterCompleted !== undefined && status.completed > afterCompleted) return;
      if (!status.running && !status.queued) return;
      if (!this.config.memory?.enabled || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
      this.start();
    } while (Date.now() < deadline);
    throw new Error('记忆整理尚未完成，请检查任务状态、租约和调用预算。');
  }

  private async request<T>(action: (signal: AbortSignal) => Promise<T>, hasCall: () => boolean): Promise<T> {
    const setting = this.config.memory!;
    const max = setting.maxCalls;
    if (this.closed || this.diagnosticFailed || (max > 0 && this.budget.calls >= max)) {
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
      if (error instanceof MemoryInputTooLargeError && !hasCall()) this.budget.calls--;
      throw error;
    }
    finally { clearTimeout(timer); this.controllers.delete(controller); }
  }

  private async run(pipeline: AutoMemoryPipeline): Promise<void> {
    const setting = this.config.memory!;
    while (!this.closed) {
      const job = this.store.claimNext(this.conversationId, { owner: this.owner, leaseMs: setting.timeoutMs + 10000, pipeline,
        ...(this.scope ? { jobIds: this.scope.jobIds } : {}) });
      if (!job) return;
      const lease = job.leaseToken!;
      let phase = 'input';
      let callId: string | undefined;
      let committed = false;
      let compactTask = false;
      const context: DiagnosticContext = { traceId: job.id, taskId: job.id, jobId: job.id,
        conversationId: job.conversationId, attempt: job.attempts };
      try {
        // Real PaConfig always has dataDir; legacy injected-provider fixtures may omit it.
        if (this.config.dataDir) this.diagnostics ??= new DiagnosticLog(this.config.dataDir, this.config.apiKey ? [this.config.apiKey] : []);
        this.diagnostics?.event(context, 'claim', 'claimed');
        if (setting.maxCalls > 0 && this.budget.calls >= setting.maxCalls) throw new Error('budget');
        const captured = this.store.taskInput(job);
        compactTask = captured.extractionProtocol === 2;
        const input: AutoMemoryTaskInput = { ...captured, selfProfileBudgetBytes: selfProfileBudget(this.config.contextWindow),
          ...(captured.extractionProtocol === 2 ? { outputBudget: memoryOutputBudget(this.config, captured.pipeline) } : {}) };
        assertCurrentMemoryProtocol(input);
        assertProfileProtocol(input);
        this.store.assertProfileEvidenceCurrent(input);
        const progress = this.readProgress(job, input);
        this.diagnostics?.event(context, phase, 'prepared', { messageIds: input.messages.map(message => message.id),
          remainingChunks: progress.remaining.length });
        while (progress.remaining.length) {
          callId = undefined;
          if (this.closed) throw new Error('closed');
          this.store.renewLease(job.id, lease, setting.timeoutMs + 10000);
          const item = progress.remaining[0]!;
          const chunk = this.workInput(input, progress, item);
          let result: ValidatedExtract;
          try {
            phase = 'extract';
            this.diagnostics?.event(context, phase, 'started', { messageIds: chunk.messages.map(message => message.id) });
            assertMemoryOutputFits(chunk, this.config);
            const proposal = await this.request(signal => this.provider.extract(chunk, signal, { onCall: id => { callId = id; } }), () => Boolean(callId));
            this.diagnostics?.event(context, phase, 'completed', undefined, callId);
            phase = 'validate';
            this.diagnostics?.event(context, phase, 'started', undefined, callId);
            result = validateExtract(proposal, chunk);
            this.store.assertProfileEvidenceCurrent(input, result);
            this.diagnostics?.event(context, phase, 'completed', undefined, callId);
          }
          catch (error) {
            if (!(error instanceof MemoryInputTooLargeError || error instanceof MemoryOutputBudgetError) || callId) throw error;
            const replacements = this.splitWork(item, chunk);
            if (!replacements) throw error;
            progress.remaining.splice(0, 1, ...replacements);
            phase = 'checkpoint';
            this.diagnostics?.event(context, phase, 'started', { split: true });
            this.store.saveProgress(job.id, lease, progress);
            this.diagnostics?.event(context, phase, 'completed', { split: true });
            continue;
          }
          const offset = progress.extract.topics.length;
          progress.extract.topics.push(...result.topics);
          progress.extract.fragments.push(...result.fragments.map(fragment => ({ ...fragment,
            ...(fragment.topicIndex === undefined ? {} : { topicIndex: fragment.topicIndex + offset }) })));
          progress.extract.ignoredMessageIds.push(...result.ignoredMessageIds);
          if (input.extractionProtocol === 2) progress.extract.processedRanges!.push(...(result.processedRanges ?? []));
          for (const profile of result.profiles) {
            const original = progress.profiles.find(old => old.personId === profile.personId)!;
            const previous = progress.extract.profiles.find(old => old.personId === profile.personId);
            const decisions = new Map((profile.pendingResults ?? []).map(outcome => [outcome.pendingId, outcome]));
            for (const prior of previous?.pendingResults ?? []) {
              if (decisions.has(prior.pendingId)) {
                if (prior.status !== 'deferred') throw new Error('已处理的人物待办结果不能被重复覆盖。');
                continue;
              }
              if (prior.status !== 'merged') { decisions.set(prior.pendingId, prior); continue; }
              const oldFact = previous!.facts[prior.factIndex!];
              const matches = profile.facts.flatMap((fact, index) => oldFact && (sameFactContent(fact, oldFact)
                || fact.messageIds.some(id => oldFact.messageIds.includes(id))) ? [index] : []);
              const exact = profile.facts.findIndex(fact => oldFact && sameFactContent(fact, oldFact));
              const index = exact >= 0 ? exact : matches.length === 1 ? matches[0]! : -1;
              if (index < 0) throw new Error('后续画像丢失已合并待办的事实绑定，保留检查点。');
              decisions.set(prior.pendingId, { ...prior, factIndex: index });
            }
            profile.pendingResults = [...decisions.values()];
            const resolved = new Set(profile.pendingResults.filter(outcome => outcome.status !== 'deferred').map(outcome => outcome.pendingId));
            profile.pending = (original.pending ?? []).filter(pending => !resolved.has(pending.id));
            assertProfileCapacity(profile);
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
          phase = 'checkpoint';
          this.diagnostics?.event(context, phase, 'started', undefined, callId);
          this.store.saveProgress(job.id, lease, progress);
          this.diagnostics?.event(context, phase, 'completed', undefined, callId);
        }
        phase = 'validate';
        this.diagnostics?.event(context, phase, 'started', { final: true }, callId);
        const completed = validateExtract(progress.extract, input, true);
        this.diagnostics?.event(context, phase, 'completed', { final: true }, callId);
        phase = 'commit';
        this.diagnostics?.event(context, phase, 'started', undefined, callId);
        this.store.commit(job.id, lease, completed, input.selfProfileBudgetBytes);
        committed = true;
        this.diagnostics?.event(context, phase, 'completed', undefined, callId);
        if (callId) this.diagnostics?.finishCall(callId, 'completed', phase);
        this.pipelineErrors.delete(pipeline);
        this.lastError = [...this.pipelineErrors.values()].at(-1);
      } catch (error) {
        phase = memoryFailurePhase(error, phase);
        let failure = error;
        try {
          if (!(error instanceof DiagnosticPersistenceError)) {
            this.diagnostics?.event(context, phase, 'failed', { failure: memoryFailure(error, phase) }, callId);
            if (callId) this.diagnostics?.finishCall(callId,
              error instanceof MemoryProviderError && error.code === 'model_request' ? 'unknown' : 'failed',
              phase, { failure: memoryFailure(error, phase) });
          }
        } catch (diagnosticError) { failure = diagnosticError; }
        if (failure instanceof DiagnosticPersistenceError) this.diagnosticFailed = true;
        this.lastError = this.diagnosticFailed ? '后台整理失败；[diagnostic_persistence] 诊断持久化失败，当前工作器已停止。'
          : `后台整理失败；${memoryFailure(error, phase)}`;
        this.pipelineErrors.set(pipeline, this.lastError);
        const conflict = error instanceof Error && /版本冲突|输入版本/.test(error.message);
        if (!committed) {
          // A compact task's protocol and completion receipts stay tied to its
          // original snapshot. A conflict requires an explicit replacement task.
          if (conflict && !compactTask) this.store.clearProgress(job.id, lease);
          this.store.fail(job.id, lease, this.lastError);
        }
        // A failed/aborted request may have been billed or completed upstream. Only explicit retry may call again.
        return;
      }
    }
  }

  private workInput(input: AutoMemoryTaskInput, progress: Progress, item: WorkItem): AutoMemoryTaskInput {
    const ids = new Set(item.messageIds);
    const people = new Set(item.personIds);
    const profiles = progress.profiles.filter(profile => people.has(profile.personId)).map(profile => {
      const { pendingResults: _results, pendingIds: _ids, ...snapshot } = profile;
      return { ...snapshot, facts: item.mode === 'messages' ? [] : profile.facts,
        pending: item.mode === 'messages' ? [] : (profile.pending ?? []).filter(pending => !item.pendingIds || item.pendingIds.includes(pending.id)) };
    });
    const fragments = item.mode === 'messages' ? [] : (input.profileFragments ?? []).filter(fragment => people.has(fragment.personId));
    const sourceIds = new Set([...profiles.flatMap(profile => [...profile.facts.flatMap(fact => fact.messageIds),
      ...(profile.pending ?? []).map(pending => pending.sourceMessageId)]), ...fragments.flatMap(fragment => fragment.messageIds)]);
    const allSources = new Map([...(input.profileSources ?? []), ...input.messages].map(message => [message.id, message]));
    const chunk: AutoMemoryTaskInput = { ...input, ...(item.mode ? { mode: item.mode } : {}),
      messages: input.messages.filter(message => ids.has(message.id)), profiles,
      profileFragments: fragments, profileSources: [...allSources.values()].filter(message => sourceIds.has(message.id)),
      ...(progress.summary ? { previousSummary: progress.summary } : {}) };
    if (input.extractionProtocol === 2) {
      if (item.mode === 'messages' || item.mode === 'self') {
        chunk.profiles = []; chunk.profileFragments = []; chunk.profileSources = [];
      }
      if (item.mode === 'messages' || !input.selfProfile?.pending.length) delete chunk.selfProfile;
    }
    if (item.mode === 'profiles') {
      delete chunk.selfProfile;
      delete chunk.previousSummary;
      delete chunk.selfProfileBudgetBytes;
    } else if (input.selfProfile && progress.extract.selfProfile) {
      const previous = progress.extract.selfProfile;
      chunk.selfProfile = { baseVersion: previous.baseVersion, content: previous.content,
        sourceMessageIds: previous.sourceMessageIds,
        pending: input.selfProfile.pending.filter(pending => !previous.pendingIds.includes(pending.id)) };
    }
    if (input.extractionProtocol === 2 && item.mode === 'self') {
      delete chunk.previousSummary;
      if (chunk.selfProfile) chunk.selfProfile = { ...chunk.selfProfile,
        pending: chunk.selfProfile.pending.filter(pending => !item.pendingIds || item.pendingIds.includes(pending.id)) };
      const sources = new Set(chunk.selfProfile?.pending.map(pending => pending.sourceMessageId));
      chunk.messages = chunk.messages.filter(message => sources.has(message.id));
    }
    if (input.extractionProtocol === 2 && item.mode === 'messages') delete chunk.selfProfile;
    if (input.pipeline === 'materials') delete chunk.previousSummary;
    return chunk;
  }

  /** Only preflight rejection may create smaller work. A complete person's facts are never split. */
  private splitWork(item: WorkItem, chunk: AutoMemoryTaskInput): WorkItem[] | undefined {
    if (item.mode === undefined) {
      if (chunk.pipeline === 'compression') return chunk.messages.length < 2 ? undefined
        : [chunk.messages.slice(0, Math.floor(chunk.messages.length / 2)), chunk.messages.slice(Math.floor(chunk.messages.length / 2))]
          .map(messages => ({ ...item, messageIds: messages.map(message => message.id) }));
      if (chunk.extractionProtocol === 2) return [{ ...item, mode: 'messages' },
        ...item.personIds.map(personId => ({ ...item, personIds: [personId], mode: 'profiles' as const })),
        ...(chunk.selfProfile?.pending.length ? [{ ...item, personIds: [], mode: 'self' as const }] : [])];
      return [{ ...item, mode: 'messages' }, ...(item.personIds.length ? [{ ...item, mode: 'profiles' as const }] : [])];
    }
    if (item.mode === 'self') {
      const pendingIds = chunk.selfProfile?.pending.map(pending => pending.id) ?? [];
      if (pendingIds.length < 2) return undefined;
      const middle = Math.floor(pendingIds.length / 2);
      return [pendingIds.slice(0, middle), pendingIds.slice(middle)].map(pendingIds => ({ ...item, pendingIds }));
    }
    if (item.mode === 'profiles' && item.personIds.length > 1) {
      const middle = Math.floor(item.personIds.length / 2);
      return [item.personIds.slice(0, middle), item.personIds.slice(middle)].map(personIds => ({ ...item, personIds }));
    }
    const pendingIds = chunk.profiles.flatMap(profile => (profile.pending ?? []).map(pending => pending.id));
    if (item.mode === 'profiles' && pendingIds.length > 1) {
      const middle = Math.floor(pendingIds.length / 2);
      return [pendingIds.slice(0, middle), pendingIds.slice(middle)].map(pendingIds => ({ ...item, pendingIds }));
    }
    if (chunk.messages.length < 2) return undefined;
    let middle = Math.floor(chunk.messages.length / 2);
    if (chunk.contextProtocol !== 1 && chunk.messages[middle]?.role === 'assistant') middle++;
    if (middle >= chunk.messages.length) return undefined;
    return [chunk.messages.slice(0, middle), chunk.messages.slice(middle)].map(messages => ({ ...item,
      messageIds: messages.map(message => message.id) }));
  }

  private readProgress(job: AutoMemoryJob, input: AutoMemoryTaskInput): Progress {
    const existing = this.store.loadProgress(job.id, job.leaseToken!);
    if (existing !== undefined && existing !== null) {
      assertCurrentMemoryProtocol(existing);
      if (!record(existing) || existing.version !== (input.extractionProtocol === 2 ? 3 : 2)) throw new PersonProfileProtocolError();
      if (!Array.isArray(existing.remaining) || !record(existing.extract)
        || !Array.isArray(existing.profiles)) throw new Error('后台整理检查点损坏。');
      const available = new Set(input.messages.map(message => message.id));
      const people = new Set(input.profiles.map(profile => profile.personId));
      const pendingIds = new Set([...input.profiles.flatMap(profile => (profile.pending ?? []).map(pending => pending.id)),
        ...(input.extractionProtocol === 2 ? input.selfProfile?.pending.map(pending => pending.id) ?? [] : [])]);
      if (existing.remaining.some(item => !record(item) || ![undefined, 'messages', 'profiles', ...(input.extractionProtocol === 2 ? ['self'] : [])].includes(item.mode as WorkItem['mode'])
        || !Array.isArray(item.messageIds) || new Set(item.messageIds).size !== item.messageIds.length || item.messageIds.some(id => !available.has(id))
        || !Array.isArray(item.personIds) || new Set(item.personIds).size !== item.personIds.length || item.personIds.some(id => !people.has(id))
        || (item.pendingIds !== undefined && (!Array.isArray(item.pendingIds) || item.pendingIds.some(id => !pendingIds.has(id)))))) throw new Error('后台检查点来源不匹配。');
      this.store.assertProfileEvidenceCurrent(input, existing.extract as unknown as ValidatedExtract);
      this.store.assertProfileEvidenceCurrent(input, { profiles: existing.profiles as PersonProfile[] });
      if (input.extractionProtocol === 2 && !Array.isArray(existing.extract.processedRanges)) throw new Error('后台整理检查点缺少步骤完成回执。');
      return existing as unknown as Progress;
    }
    return { version: input.extractionProtocol === 2 ? 3 : 2,
      remaining: input.pipeline === 'materials' && input.messages.length === 0
        ? [...input.profiles.map(profile => ({ messageIds: [] as string[], personIds: [profile.personId], mode: 'profiles' as const })),
          ...(input.selfProfile?.pending.length ? [{ messageIds: [] as string[], personIds: [] as string[], mode: 'self' as const }] : [])]
        : [{ messageIds: input.messages.map(message => message.id), personIds: input.profiles.map(profile => profile.personId) }], profiles: input.profiles,
      extract: { topics: [], fragments: [], profiles: [], ignoredMessageIds: [], ...(input.extractionProtocol === 2 ? { processedRanges: [] } : {}) },
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
    await Promise.allSettled([...this.work.values()]);
  }
}

import type { AutoMemoryTaskInput, PersonProfile, ProfileFact, ProfilePendingResult } from './auto-memory-types.js';

export class PersonProfileProtocolError extends Error {
  constructor() {
    super('人物画像整理协议已变更；旧固定输入与进度已保留，需操作者处理。');
    this.name = 'PersonProfileProtocolError';
  }
}
export function assertProfileProtocol(input: AutoMemoryTaskInput): void {
  if (input.profileProtocol !== 2) throw new PersonProfileProtocolError();
}

/** A rewrite cannot promote older third-party/inferred evidence into a self claim. */
export function assertProfileEvidenceStrength(fact: ProfileFact, baseline: PersonProfile, input: AutoMemoryTaskInput): void {
  if (fact.sourceType !== 'self') return;
  const prior = [...baseline.facts, ...(input.profileFragments ?? []).filter(fragment => fragment.personId === baseline.personId)];
  const priorSelf = new Set(prior.filter(old => old.sourceType === 'self').flatMap(old => old.messageIds));
  const weaker = new Set(prior.filter(old => old.sourceType !== 'self').flatMap(old => old.messageIds));
  const explicit = new Set([
    ...priorSelf,
    ...(baseline.pending ?? []).filter(item => item.sourceType === 'self').map(item => item.sourceMessageId),
    ...input.messages.filter(message => message.role === 'user' && message.personId === baseline.personId
      && (!weaker.has(message.id) || priorSelf.has(message.id))).map(message => message.id),
  ]);
  if (!fact.messageIds.some(id => explicit.has(id))) throw new Error('人物画像改写不能把旧转述或推断提升为本人自述。');
}

/** Pure validation; only the store may resolve the captured queue entries atomically. */
export function validateProfilePendingResults(profile: PersonProfile, baseline: PersonProfile,
  input: AutoMemoryTaskInput): ProfilePendingResult[] {
  const pending = baseline.pending ?? [];
  const results = profile.pendingResults ?? [];
  function invalid(): never { throw new Error('人物待整理处理结果无效或缺少已捕获条目的处理结果。'); }
  if (profile.pendingIds?.length || !Array.isArray(results) || results.length !== pending.length) invalid();
  const captured = new Map(pending.map(item => [item.id, item]));
  const seen = new Set<string>();
  const sources = new Map([...input.messages, ...(input.profileSources ?? [])].map(message => [message.id, message]));
  const normalized: ProfilePendingResult[] = [];
  for (const result of results) {
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || typeof result.pendingId !== 'string' || seen.has(result.pendingId)) invalid();
    seen.add(result.pendingId);
    const item = captured.get(result.pendingId);
    if (!item) invalid();
    const source = sources.get(item.sourceMessageId);
    if (!source || source.role !== 'user' || input.excludedProfileSourceIds?.includes(source.id)) invalid();
    const exactKeys = (...keys: string[]) => Object.keys(result).length === keys.length && keys.every(key => key in result);
    if (result.status === 'merged') {
      if (!exactKeys('pendingId','status','factIndex') || !Number.isSafeInteger(result.factIndex)
        || result.factIndex < 0 || !profile.facts[result.factIndex]
        || (item.sourceType === 'self' && (source.personId !== baseline.personId || profile.facts[result.factIndex]!.sourceType !== 'self'))) invalid();
      normalized.push({ pendingId: item.id, status: 'merged', factIndex: result.factIndex });
    } else if (result.status === 'superseded') {
      const replacement = sources.get(result.replacementMessageId);
      const retainedSources = new Set(profile.facts.flatMap(fact => fact.messageIds));
      for (const next of results) if (next && typeof next === 'object' && next.status === 'merged') {
        const nextPending = captured.get(next.pendingId);
        if (nextPending && profile.facts[next.factIndex]) retainedSources.add(nextPending.sourceMessageId);
      }
      if (!exactKeys('pendingId','status','replacementMessageId') || !replacement || replacement.role !== 'user'
        || source.personId !== baseline.personId || replacement.personId !== baseline.personId
        || !Number.isSafeInteger(source.ingestSeq) || !Number.isSafeInteger(replacement.ingestSeq)
        || replacement.ingestSeq <= source.ingestSeq || !retainedSources.has(replacement.id)
        || input.excludedProfileSourceIds?.includes(replacement.id)) invalid();
      normalized.push({ pendingId: item.id, status: 'superseded', replacementMessageId: replacement.id });
    } else if (result.status === 'not_profile') {
      if (!exactKeys('pendingId','status','reason') || !['temporary','not_personal','insufficient_evidence'].includes(result.reason)) invalid();
      normalized.push({ pendingId: item.id, status: 'not_profile', reason: result.reason });
    } else if (result.status === 'deferred') {
      if (!exactKeys('pendingId','status')) invalid();
      normalized.push({ pendingId: item.id, status: 'deferred' });
    } else invalid();
  }
  return normalized;
}

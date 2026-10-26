import type { AutoMemoryTaskInput, PersonProfile, ProfileFact, ProfileFactUpdate } from './auto-memory-types.js';
import { inferPersonProfileEvidence, resolveProfileSubject, type ProfileSubjectEvidence } from './profile-attribution.js';
import { materialProfileSources } from './material-profile-wire.js';

const same = (a: ProfileFact, b: ProfileFact) => a.content === b.content && a.sourceType === b.sourceType
  && (a.occurredAt ?? null) === (b.occurredAt ?? null) && (a.expiresAt ?? null) === (b.expiresAt ?? null)
  && JSON.stringify([...a.messageIds].sort()) === JSON.stringify([...b.messageIds].sort());
const evidenceKey=(value:ProfileSubjectEvidence):string=>JSON.stringify([value.messageId,value.factQuote,value.subjectKind,value.subjectQuote]);
const unique = (values: ProfileSubjectEvidence[]): ProfileSubjectEvidence[] => [...new Map(values.map(value => [evidenceKey(value), value])).values()];
function invalid(): never { throw new Error('人物画像更新缺少有效的对象依据或已授权更新来源。'); }

/** The model proposes an object; both validation and the final store commit verify it independently. */
export function validateProfileUpdates(profile: PersonProfile, baseline: PersonProfile, input: AutoMemoryTaskInput): void {
  if (input.profileAttributionProtocol !== 1) return;
  const updates = profile.updates ?? [];
  if (!Array.isArray(updates)) invalid();
  const sources = new Map([...input.messages, ...(input.profileSources ?? []), ...(input.materialsProtocol === 3 ? input.recoveryReviewMessages ?? [] : [])].map(message => [message.id, message]));
  const visible = new Set([...input.messages.map(message => message.id), ...(baseline.pending ?? []).map(item => item.sourceMessageId),
    ...(input.materialsProtocol === 3 ? materialProfileSources(input, baseline).keys() : [])]);
  const seen = new Set<number>();
  for (const update of updates) {
    if (!update || Object.keys(update).some(key => !['factIndex','baselineFactIndexes','evidence'].includes(key))
      || !Number.isSafeInteger(update.factIndex) || update.factIndex < 0 || !profile.facts[update.factIndex]
      || seen.has(update.factIndex) || !Array.isArray(update.evidence)
      || (update.baselineFactIndexes !== undefined && (!Array.isArray(update.baselineFactIndexes)
        || new Set(update.baselineFactIndexes).size !== update.baselineFactIndexes.length))) invalid();
    seen.add(update.factIndex);
    const fact = profile.facts[update.factIndex]!;
    const allowed = new Set<string>();
    for (const index of update.baselineFactIndexes ?? []) {
      const previous = baseline.facts[index];
      if (!Number.isSafeInteger(index) || index < 0 || !previous
        || (previous.sourceType !== fact.sourceType && !(input.materialsProtocol === 3 && update.evidence.length))) invalid();
      if (previous.sourceType === fact.sourceType) previous.messageIds.forEach(id => allowed.add(id));
    }
    const references = new Set<string>();
    for (const evidence of update.evidence) {
      if (!evidence || references.has(evidenceKey(evidence))) invalid();
      references.add(evidenceKey(evidence));
      const source = sources.get(evidence.messageId);
      if (!source || !visible.has(source.id) || input.excludedProfileSourceIds?.includes(source.id)) invalid();
      const subject = input.materialsProtocol === 3 && source.personId === baseline.personId
        && source.conversationId === input.job.conversationId && materialProfileSources(input, baseline).has(source.id)
        ? { personId: baseline.personId, sourceType: 'self' as const }
        : resolveProfileSubject(evidence, source, input.profileSubjects ?? []);
      if (subject.personId !== profile.personId || (fact.sourceType !== 'inference' && fact.sourceType !== subject.sourceType)) invalid();
      if (subject.sourceType === 'third_party' && !(baseline.pending ?? []).some(item => item.sourceMessageId === source.id
        && item.sourceType === 'third_party' && item.subject
        && ['messageId','factQuote','subjectKind','subjectQuote'].every(key=>item.subject![key as keyof ProfileSubjectEvidence]===evidence[key as keyof ProfileSubjectEvidence]))) invalid();
      allowed.add(source.id);
    }
    if (!fact.messageIds.length || fact.messageIds.some(id => !allowed.has(id))) invalid();
  }
  profile.facts.forEach((fact, index) => {
    if (!baseline.facts.some(previous => same(previous, fact)) && !seen.has(index)) invalid();
  });
  for (const result of profile.pendingResults ?? []) if (result.status === 'merged') {
    const item = baseline.pending?.find(pending => pending.id === result.pendingId);
    const source = item && sources.get(item.sourceMessageId);
    if (!item || !source) invalid();
    const ownPending = input.materialsProtocol === 3 && item.sourceType === 'self' && source.personId === baseline.personId;
    // New pending contains a normalized fact, not an excerpt. Its real source/target
    // was bound by prepare_turn; do not try to find that wording in the original.
    const evidence = ownPending ? undefined
      : item.subject ?? inferPersonProfileEvidence(source, item.content, input.profileSubjects ?? [], profile.personId);
    const subject = ownPending
      ? { personId: baseline.personId, sourceType: 'self' as const }
      : resolveProfileSubject(evidence!, source, input.profileSubjects ?? []);
    if (subject.personId !== profile.personId || (subject.sourceType === 'third_party' && !item.subject)) invalid();
  }
  if(input.recoveryReviewMessages!==undefined || input.materialsProtocol===3) {
    const chronologySources=new Map([...(input.recoveryReviewMessages??[]),...sources.values()].map(message=>[message.id,message]));
    const evidenceOrder=(ids:readonly string[]):[number,number]=>ids.reduce<[number,number]>((latest,id)=>{
      const source=chronologySources.get(id);const next:[number,number]=source?[Date.parse(source.createdAt),source.ingestSeq]:[-Infinity,-Infinity];
      return next[0]>latest[0]||(next[0]===latest[0]&&next[1]>latest[1])?next:latest;
    },[-Infinity,-Infinity]);
    const atLeast=(a:[number,number],b:[number,number])=>a[0]>b[0]||(a[0]===b[0]&&a[1]>=b[1]);
    const confirmationsFor=(fact:ProfileFact)=>(input.recoveryProfileFactSources??[])
      .filter(source=>source.personId===profile.personId&&same(source.fact,fact)).flatMap(source=>source.messageIds);
    baseline.facts.forEach((fact,index)=>{
      if(profile.facts.some(next=>same(next,fact))) return;
      const confirmations=confirmationsFor(fact);
      // Old recovered text may add unrelated facts, but may not erase/rewrite a later baseline.
      if(!updates.some(update=>update.baselineFactIndexes?.includes(index)
        &&atLeast(evidenceOrder(update.evidence.length ? update.evidence.map(item=>item.messageId)
          : input.materialsProtocol===3 ? (update.baselineFactIndexes??[]).flatMap(index=>{
            const previous=baseline.facts[index]!;
            return [...previous.messageIds,...confirmationsFor(previous)];
          }) : []),
          evidenceOrder([...fact.messageIds,...confirmations])))) {
        throw new Error('恢复任务不能用较早来源删除或改写较新的画像事实；缺少同等或更新的明确替代依据。');
      }
    });
  }
}

export function normalizeProfileUpdates(profile: PersonProfile, normalizedFacts: ProfileFact[]): ProfileFactUpdate[] | undefined {
  if (!profile.updates) return undefined;
  const result = new Map<number, ProfileFactUpdate>();
  for (const update of profile.updates) {
    const original = profile.facts[update.factIndex];
    const index = original ? normalizedFacts.findIndex(fact => fact.content.normalize('NFKC').trim() === original.content.normalize('NFKC').trim()
      && fact.sourceType === original.sourceType && (fact.occurredAt ?? null) === (original.occurredAt ?? null)
      && (fact.expiresAt ?? null) === (original.expiresAt ?? null)) : -1;
    if (index < 0) invalid();
    const prior = result.get(index);
    result.set(index, { factIndex: index, baselineFactIndexes: [...new Set([...(prior?.baselineFactIndexes ?? []), ...(update.baselineFactIndexes ?? [])])],
      evidence: unique([...(prior?.evidence ?? []), ...update.evidence]) });
  }
  return [...result.values()];
}

/** Translate intermediate baseline indices back to the immutable parent snapshot on split/resume. */
export function accumulateProfileUpdates(profile: PersonProfile, previous: PersonProfile, original: PersonProfile): void {
  const combined: ProfileFactUpdate[] = [];
  profile.facts.forEach((fact, index) => {
    if (original.facts.some(old => same(old, fact))) return;
    const current = profile.updates?.find(update => update.factIndex === index);
    const inheritedIndex = previous.facts.findIndex(old => same(old, fact));
    const indices = current?.baselineFactIndexes ?? (inheritedIndex >= 0 ? [inheritedIndex] : []);
    let evidence: ProfileSubjectEvidence[] = [...(current?.evidence ?? [])];
    const baselineFactIndexes: number[] = [];
    for (const previousIndex of indices) {
      const prior = previous.updates?.find(update => update.factIndex === previousIndex);
      if (prior) {
        baselineFactIndexes.push(...(prior.baselineFactIndexes ?? [])); evidence.push(...prior.evidence);
      } else {
        const old = previous.facts[previousIndex];
        const originalIndex = old ? original.facts.findIndex(fact => same(fact, old)) : -1;
        if (originalIndex < 0) invalid();
        baselineFactIndexes.push(originalIndex);
      }
    }
    combined.push({ factIndex: index, baselineFactIndexes: [...new Set(baselineFactIndexes)], evidence: unique(evidence) });
  });
  profile.updates = combined;
}

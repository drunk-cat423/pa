import type { AutoMemoryMessage } from './auto-memory-types.js';

export interface ProfileSubjectEvidence {
  messageId: string;
  factQuote: string;
  subjectKind: 'self' | 'mention' | 'name' | 'ai';
  subjectQuote: string;
}
export interface ProfileSubjectCandidate { personId: string; senderId: string; name?: string }
export class ProfileAttributionError extends Error {
  constructor() { super('画像对象无法从原文可靠确认，或与实际身份不一致；本次未保存画像。'); this.name = 'ProfileAttributionError'; }
}
const fail = (): never => { throw new ProfileAttributionError(); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Conservative evidence checks, not a general-purpose natural-language parser. */
function unquoted(text: string): string {
  // Preserve offsets. Quoted first-person statements belong to their quoted speaker.
  return text.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|^\s*>[^\n]*/gm,
    span => ' '.repeat(span.length));
}
function checked(evidence: ProfileSubjectEvidence, message: Pick<AutoMemoryMessage, 'id' | 'role' | 'text'>): string {
  if (!record(evidence) || Object.keys(evidence).some(key => !['messageId','factQuote','subjectKind','subjectQuote'].includes(key))
    || evidence.messageId !== message.id || message.role !== 'user'
    || typeof evidence.factQuote !== 'string' || !evidence.factQuote.trim() || [...evidence.factQuote].length > 4000
    || typeof evidence.subjectQuote !== 'string' || !evidence.subjectQuote.trim() || evidence.subjectQuote.length > 512
    || !['self','mention','name','ai'].includes(evidence.subjectKind)) fail();
  const visible = unquoted(message.text);
  const offsets = [...message.text.matchAll(new RegExp(escape(evidence.factQuote), 'g'))].map(match => match.index);
  if (!evidence.factQuote.includes(evidence.subjectQuote) || !offsets.some(start => {
    const subjectStart=start+evidence.factQuote.indexOf(evidence.subjectQuote);
    return visible.slice(subjectStart,subjectStart+evidence.subjectQuote.length)===evidence.subjectQuote
      && visible.slice(start,start+evidence.factQuote.length).trim();
  })) fail();
  return visible;
}
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const withoutRequest = (text: string): string => text.replace(/^(?:(?:请|麻烦|帮我|你|您|先|再|要|以后|今后|现在|从现在起|记住|记下|记一下|记住一下|记下来|保存|更新|纠正|改成|一下|这点|一点)[，,:：\s]*)+/u, '').trim();

export function resolveProfileSubject(evidence: ProfileSubjectEvidence, message: AutoMemoryMessage,
  candidates: readonly ProfileSubjectCandidate[]): { personId: string; sourceType: 'self' | 'third_party' } {
  checked(evidence, message);
  if (evidence.subjectKind === 'self') {
    if (!message.personId) return fail();
    return { personId: message.personId, sourceType: 'self' };
  }
  if (evidence.subjectKind !== 'mention' && evidence.subjectKind !== 'name') return fail();
  const matches = candidates.filter(candidate => evidence.subjectKind === 'mention'
    ? message.mentionedSenderIds?.includes(candidate.senderId)
      && [`<@${candidate.senderId}>`, `<@!${candidate.senderId}>`, `@${candidate.senderId}`].includes(evidence.subjectQuote)
    : candidate.name === evidence.subjectQuote || candidate.senderId === evidence.subjectQuote);
  const people = [...new Set(matches.map(candidate => candidate.personId))];
  if (people.length !== 1) return fail();
  return { personId: people[0]!, sourceType: people[0] === message.personId ? 'self' : 'third_party' };
}

/** Legacy local management entry points may infer only an explicit, unambiguous subject. */
export function inferPersonProfileEvidence(message: AutoMemoryMessage, factQuote: string,
  candidates: readonly ProfileSubjectCandidate[], expectedPersonId: string): ProfileSubjectEvidence {
  const clause = withoutRequest(factQuote);
  const options: ProfileSubjectEvidence[] = [];
  if (/^(?:我|本人)/u.test(clause)) options.push({ messageId: message.id, factQuote, subjectKind: 'self', subjectQuote: clause.startsWith('本人') ? '本人' : '我' });
  for (const candidate of candidates.filter(item => item.personId === expectedPersonId)) {
    for (const token of [`<@${candidate.senderId}>`, `<@!${candidate.senderId}>`, `@${candidate.senderId}`]) if (clause.startsWith(token)) {
      options.push({ messageId: message.id, factQuote, subjectKind: 'mention', subjectQuote: token });
    }
    for (const token of [candidate.name, candidate.senderId]) if (token && clause.startsWith(token)) {
      options.push({ messageId: message.id, factQuote, subjectKind: 'name', subjectQuote: token });
    }
  }
  for (const evidence of options) {
    try { if (resolveProfileSubject(evidence, message, candidates).personId === expectedPersonId) return evidence; } catch (error) {
      if (!(error instanceof ProfileAttributionError)) throw error;
    }
  }
  if(factQuote!==message.text&&message.text.includes(factQuote)) return inferPersonProfileEvidence(message,message.text,candidates,expectedPersonId);
  return fail();
}

export function assertAiProfileEvidence(evidence: ProfileSubjectEvidence,
  message: Pick<AutoMemoryMessage, 'id' | 'role' | 'text'>): void {
  checked(evidence, message);
  if (evidence.subjectKind !== 'ai') fail();

}
export function inferAiProfileEvidence(messageId: string, text: string): ProfileSubjectEvidence {
  const subjectQuote = ['你的','你','您','机器人','bot','Bot','AI','回复','回答','解释','表达','说话'].find(token => text.includes(token)) ?? fail();
  const evidence: ProfileSubjectEvidence = { messageId, factQuote: text, subjectKind: 'ai', subjectQuote };
  assertAiProfileEvidence(evidence, { id: messageId, role: 'user', text });
  return evidence;
}

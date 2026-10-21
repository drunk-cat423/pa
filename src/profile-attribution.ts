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
  if (offsets.length !== 1 || !evidence.factQuote.includes(evidence.subjectQuote)) fail();
  // Don't accept an excerpt cut out of a reported/conditional/example statement.
  const start = offsets[0]!;
  const subjectStart=start+evidence.factQuote.indexOf(evidence.subjectQuote);
  if(visible.slice(subjectStart,subjectStart+evidence.subjectQuote.length)!==evidence.subjectQuote
    || !visible.slice(start,start+evidence.factQuote.length).trim()) fail();
  const prefix = visible.slice(Math.max(visible.lastIndexOf('。', start - 1), visible.lastIndexOf('\n', start - 1),
    visible.lastIndexOf('！', start - 1), visible.lastIndexOf('？', start - 1)) + 1, start);
  if (/说|表示|声称|转述|自述|原话|觉得|认为|听说|例如|比如|假如|假设|如果|他说|她说/.test(prefix)
    || (/[:：]/.test(prefix)&&!/^(?:请)?(?:记住|记下|记一下|更新|纠正|设定)[:：\s]*$/.test(prefix.trim()))
    || /^(?:如果|假如|假设|比如|例如|听说|据说|要是|假定|举例)/.test(withoutRequest(evidence.factQuote))) fail();
  return visible;
}
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const withoutRequest = (text: string): string => text.replace(/^(?:(?:请|麻烦|帮我|你|您|先|再|要|以后|今后|现在|从现在起|记住|记下|记一下|记住一下|记下来|保存|更新|纠正|改成|一下|这点|一点)[，,:：\s]*)+/u, '').trim();

function assertSelf(evidence: ProfileSubjectEvidence, candidates: readonly ProfileSubjectCandidate[], speakerId: string): void {
  if (!['我','本人','我的'].includes(evidence.subjectQuote)) fail();
  const clause = withoutRequest(evidence.factQuote);
  if (!/^(?:我(?:的)?|本人)/u.test(clause)
    || /^(?:我们|我(?:觉得|认为|听说|听到|知道|了解|发现|记得|说|告诉|转述|问|猜|想问)|我(?:的)?(?:朋友|同事|同学|家人|父亲|母亲|爸|妈|哥|姐|弟|妹|对象|老公|老婆|老师|老板|领导|客户|用户|室友|舍友|邻居|儿子|女儿|亲戚)|本人(?:觉得|认为|听说))/u.test(clause)
    || /^我(?:对|向|给|跟|和).*(?:说|表示|称|告诉)/u.test(clause)) fail();
  // A real @ or known person as grammatical subject cannot be relabelled as self.
  for (const candidate of candidates) if (candidate.personId !== speakerId) {
    const names = [candidate.name, `<@${candidate.senderId}>`, `<@!${candidate.senderId}>`].filter((v): v is string => !!v);
    if (names.some(name => new RegExp(`${escape(name)}(?:的)?(?:不|没|喜欢|讨厌|偏好|习惯|希望|想|是|叫|需要|爱|怕)`).test(clause))) fail();
  }
}

export function resolveProfileSubject(evidence: ProfileSubjectEvidence, message: AutoMemoryMessage,
  candidates: readonly ProfileSubjectCandidate[]): { personId: string; sourceType: 'self' | 'third_party' } {
  checked(evidence, message);
  if (evidence.subjectKind === 'self') {
    if (!message.personId) return fail();
    assertSelf(evidence, candidates, message.personId);
    return { personId: message.personId, sourceType: 'self' };
  }
  if (evidence.subjectKind !== 'mention' && evidence.subjectKind !== 'name') return fail();
  const matches = candidates.filter(candidate => evidence.subjectKind === 'mention'
    ? message.mentionedSenderIds?.includes(candidate.senderId)
      && [`<@${candidate.senderId}>`, `<@!${candidate.senderId}>`, `@${candidate.senderId}`].includes(evidence.subjectQuote)
    : candidate.name === evidence.subjectQuote || candidate.senderId === evidence.subjectQuote);
  const people = [...new Set(matches.map(candidate => candidate.personId))];
  if (people.length !== 1) return fail();
  const clause = withoutRequest(evidence.factQuote);
  if (!clause.startsWith(evidence.subjectQuote) || /^(?:说|表示|认为|觉得|听说|转述)/.test(clause.slice(evidence.subjectQuote.length))) return fail();
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
  if (evidence.subjectKind !== 'ai' || !['你','你的','您','机器人','bot','Bot','AI','回复','回答','解释','表达','说话'].includes(evidence.subjectQuote)) fail();
  const clause = withoutRequest(evidence.factQuote);
  // A setting for another bot or an evaluation isn't an instruction for this bot.
  const explicitSetting=/(?:记住|记一下|记下|以后|今后|从现在起|设定|设置|改叫|改成|改为|你要|你应当|你应该|你必须|你的名字(?:是|叫)|你(?:现在|现在就|就)?叫|你是|你的定位(?:是|为)|我(?:希望|想让|要求)你|叫你|称呼你)/u.test(evidence.factQuote)
    || /^(?:回复|回答|解释|表达|说话).*(?:一点|一些|点|先|不要|别|保持|采用|用|要|应)/u.test(clause);
  if (/另一个|那个(?:机器人|bot|Bot|AI)|别的(?:机器人|bot|Bot|AI)|其他(?:机器人|bot|Bot|AI)/i.test(evidence.factQuote)
    || !explicitSetting || /(?:[?？]|什么|啥|哪个|吗|呢|么)\s*$/.test(evidence.factQuote)
    || (!/(?:你|您|机器人|bot|Bot|AI)/u.test(evidence.factQuote)
      && !/^(?:(?:请|以后|今后|从现在起|记住|记一下|先)[，,\s]*)*(?:回复|回答|解释|表达|说话)/u.test(evidence.factQuote))
    || /^(?:我(?:觉得|认为|听说)|他|她)/u.test(clause)) fail();
}
export function inferAiProfileEvidence(messageId: string, text: string): ProfileSubjectEvidence {
  const subjectQuote = ['你的','你','您','机器人','bot','Bot','AI','回复','回答','解释','表达','说话'].find(token => text.includes(token)) ?? fail();
  const evidence: ProfileSubjectEvidence = { messageId, factQuote: text, subjectKind: 'ai', subjectQuote };
  assertAiProfileEvidence(evidence, { id: messageId, role: 'user', text });
  return evidence;
}

import { MemoryError, type MemoryRecord, type ProfileField, type MemoryInput } from './memory-types.js';
import type { RecordedConversation } from './conversation.js';

export type MemoryRequest =
  | { type: 'ai_self_update'; content: string }
  | { type: 'ai_self_clarify' }
  | { type: 'ai_self_refusal' }
  | { type: 'self_update'; field: ProfileField; content: string }
  | { type: 'admin'; text: string }
  | { type: 'unsupported_delete' }
  | { type: 'profile_read' }
  | { type: 'clarify' };

const PROFILE_FIELDS: ProfileField[] = ['diet', 'preferred_name', 'interests', 'reply_style'];
const FIELD_NAMES: Record<ProfileField, string> = {
  diet: '饮食偏好', preferred_name: '称呼', interests: '兴趣偏好', reply_style: '回复偏好',
};
const CLARIFY = '请明确要更新自己的哪项信息：称呼、饮食偏好、兴趣或回复偏好。涉及他人或当前会话的管理操作仅管理者可用。';
const DENIED = '你没有记忆管理或画像查询权限；可以明确请求更新自己在当前会话提供的信息。';
const AI_SELF_ACK = '已记入我的待整理画像，下次对话会参考，后续整理时合并。';
const AI_SELF_CLARIFY = '请具体说明希望我长期采用的名称、定位或回复方式；也可以用“/self 内容”提供画像建议。';
const AI_SELF_REFUSAL = '我不能更改权限、工具配置或预算；这些设置需通过本地配置调整。';
function fieldFor(text: string): ProfileField | undefined {
  if (/饮食|口味|吃|微辣|清淡|素食|辣椒|食物|过敏/.test(text)) return 'diet';
  if (/称呼|昵称|名字|叫我|^我叫/.test(text)) return 'preferred_name';
  if (/回复|回答|交流方式|交流偏好/.test(text)) return 'reply_style';
  if (/兴趣|爱好|^我(?:喜欢|不喜欢|热爱)/.test(text)) return 'interests';
  return undefined;
}

const AI_CONFIG_CHANGE = /(?:权限|授权|工具(?:配置|设置|调用)|配置|预算|系统提示词|系统指令|api(?:\s*key)?|secret|token)/i;
const AI_CONFIG_ACTION = /(?:改(?:成|为|掉)?|设置(?:成|为)?|开启|关闭|增加|减少|提高|降低|忽略|绕过|不再遵守|授予|允许|禁止|记住|更新|纠正)/;
const QUOTE_MARKS = /["“”「」『』‘’]/;
const SELF_PROFILE_PROPERTY_REQUEST = /^你的(?:画像|性格|兴趣|倾向).{0,24}(?:是|为|更|尽量|尽可能|保持|偏向|倾向于|喜欢|热爱|简洁|简短|详细|清晰|自然|正式|轻松|幽默|亲切|温和|耐心|谨慎|乐观|谦逊|好奇|先|优先|采用|使用)/u;

function parseAiSelfRequest(text: string): MemoryRequest | undefined {
  const slash = text.match(/^\/self(?:\s+([\s\S]*))?$/i);
  const explicit = text.match(/^(?:请(?:你)?|麻烦你)?(?:你\s*)?(?:记住(?:一下)?|记一下)(?=$|[\s，,：:。！!你以])([\s\S]*)$/);
  const rawContent = slash ? slash[1] ?? '' : explicit ? explicit[1] ?? '' : text;
  const directive = rawContent.trim().replace(/^[，,：:。！!\s]+/, '');
  const normalizedDirective = directive.replace(/^你(?=(?:(?:从今)?以后|今后|往后))/u, '');
  const future = normalizedDirective.match(/^(?:(?:从今)?以后|今后|往后)\s*/u);
  const futureTarget = future ? normalizedDirective.slice(future[0].length) : '';
  const target = (future ? futureTarget : normalizedDirective)
    .replace(/^你(?=(?:叫|是|回答|回复|表达|说话|交流))/u, '');
  const hasFutureIdentityAssignment = /^(?:你的(?:名字|名称|定位|身份|角色|称呼|代号).{0,24}(?:叫(?!我)|是|为)|你(?:叫(?!我)|是))\s*\S/u.test(futureTarget);
  const speakerOwned = /(?:由我|我负责|我来)/u.test(directive);
  const hasFutureStyleRequest = /^(?!(?:.*(?:由我|我负责|我来)))(?:(?:你的|你)?(?:回答|回复|说话|交流|交流方式|表达|风格|语气)).{0,24}(?:更|尽量|尽可能|简洁|简短|详细|清晰|通俗|自然|正式|轻松|幽默|亲切|中文|英文|优先|不要|别|保持|先|使用|采用|控制|要|得)/u.test(target);
  const hasFutureTarget = Boolean(future && !speakerOwned && (hasFutureIdentityAssignment || hasFutureStyleRequest
    || SELF_PROFILE_PROPERTY_REQUEST.test(target)
    || /^(?:pa|personal\s+agent)\s*指(?:的)?(?:就是|是)/iu.test(target)));
  const question = /[?？]|(?:吗|什么|怎么|为何|为什么|什么意思|是什么(?:呀|呢)?)[。！!？?]*$/u.test(directive);
  if (!slash && !explicit && !hasFutureTarget) return undefined;
  if (!slash && question) return undefined;
  if (/在(?:这|此|本)(?:个)?(?:故事|剧情|游戏|场景)(?:里|中|下)|角色扮演|扮演|假装/u.test(directive)) return undefined;

  let content = rawContent;
  content = content.trim().replace(/^[，,：:。！!\s]+/, '').replace(/[。！!]+$/, '').trim();
  if (AI_CONFIG_CHANGE.test(content) && AI_CONFIG_ACTION.test(content)) return { type: 'ai_self_refusal' };
  const quotedAssignment = Boolean(explicit && /^(?:(?:(?:从今)?以后|今后|往后)\s*)?(?:你的(?:名字|名称|定位|身份|角色|称呼|代号).{0,24}(?:叫|是|为)|你(?:叫|是))["“「].+["”」]$/u.test(directive));
  if (!content || [...content].length > 500 || /[\r\n]/.test(content) || (!slash && QUOTE_MARKS.test(text) && !quotedAssignment)) {
    return { type: 'ai_self_clarify' };
  }
  const selfTarget = !speakerOwned && (hasFutureTarget
    || /^(?:(?:(?:从今)?以后|今后|往后)\s*)?(?:你的(?:名字|名称|定位|身份|角色|称呼|代号).{0,24}(?:叫(?!我)|是|为)|你(?:叫(?!我)|是)|pa\s*指(?:的)?(?:就是|是))/iu.test(directive)
    || SELF_PROFILE_PROPERTY_REQUEST.test(directive)
    || /^(?:(?:(?:从今)?以后|今后|往后)\s*)?(?:(?:你的|你)?(?:回答|回复|说话|交流|交流方式|表达|风格|语气)).{0,24}(?:更|尽量|尽可能|简洁|简短|详细|清晰|通俗|自然|正式|轻松|幽默|亲切|中文|英文|优先|不要|别|保持|先|使用|采用|控制|要|得)/iu.test(directive));
  if (!slash && explicit && !selfTarget && !hasFutureTarget) return undefined;
  return { type: 'ai_self_update', content };
}

// These explicit forms are handled locally. We never ask a model to choose an
// actor, grant authority or invent a stored profile from ordinary conversation.
export function parseMemoryRequest(input: string): MemoryRequest | undefined {
  const text = input.normalize('NFKC').trim();
  if (/^\/(?:forget|memory\s+(?:delete|forget))(?:\s|$)/i.test(text)) return { type: 'unsupported_delete' };
  if (/^\/(?:memory|memories|remember|correct|forget)(?:\s|$)/i.test(text)) return { type: 'admin', text };
  if (/^(?:请)?(?:记住|更新|纠正|删除|忘掉)本群/.test(text)) return { type: 'admin', text };
  if (/^\/self(?:\s|$)/i.test(text)) {
    const aiSelfRequest = parseAiSelfRequest(text);
    if (aiSelfRequest) return aiSelfRequest;
  }
  if ((/画像|个人档案|个人记忆|个人信息|我的记忆|我的偏好|关于我.*记忆|我.*偏好/.test(text)
    && /查看|查询|列出|展示|告诉|总结|记得|知道|有哪些|有什么|导出/.test(text))
    || /你(?:还)?记得我(?:有)?(?:哪些|什么|的)/.test(text)
    || /(?:列出|查看|查询|展示|导出|总结).*(?:我(?:的|不吃|喜欢|保存|提供)|关于我)/.test(text)
    || /我(?:保存的|提供的|告诉过的|的).*(?:饮食|称呼|兴趣|爱好|信息|偏好).*(?:是什么|有哪些|有什么)/.test(text)
    || /(?:知道|记得).{0,6}我.{0,12}(?:喜欢什么|叫啥|叫什么|偏好|饮食|兴趣|画像)/.test(text)
    || /^你.*记住.*我.*(?:什么|哪些|偏好|饮食|兴趣|画像)/.test(text)) return { type: 'profile_read' };
  const aiSelfRequest = parseAiSelfRequest(text);
  if (aiSelfRequest) return aiSelfRequest;
  if (/^(?:请(?:你)?|帮我)?(?:忘掉|忘记|删除|移除)(?:关于)?(?:我的|我)(?:的)?/.test(text)
    && /偏好|饮食|口味|吃|称呼|昵称|名字|兴趣|爱好|回复|交流|喜欢|不吃|不喜欢|记忆|信息/.test(text)) {
    return { type: 'unsupported_delete' };
  }
  const explicit = text.match(/^(?:请(?:你)?|麻烦你|帮我)?(?:你\s*)?(?:记住|记一下|更新|纠正)(?:一下)?[：:\s]*(.+)$/);
  const change = /^我现在(?:可以接受|不能接受|喜欢|不喜欢|更喜欢|希望)|^(?:以后)?(?:请)?(?:你)?(?:叫我|称呼我)/.test(text);
  if (!explicit && !change) return undefined;
  const content = (explicit?.[1] ?? text).trim().replace(/[。！!]+$/, '');
  if (!/^(?:我(?:现在)?(?:不喜欢|喜欢|不吃|爱吃|热爱|可以接受|不能接受|希望|更喜欢|对|的(?:饮食|口味|兴趣|爱好|昵称|称呼|回复|交流|名字)|叫)|(?:以后)?(?:请)?(?:你)?(?:叫我|称呼我))/.test(content)
    || /我(?:的)?(?:朋友|家人|妈妈|爸爸|同学|同桌|同事|兄弟|姐姐|妹妹|哥哥|老板|对象|伴侣|孩子|父亲|母亲|室友)/.test(content)
    || /[\r\n]|他人|别人|其他人|全群|本群|所有人|管理员|权限|预算|系统|工具|画像|评价|指令|读取|导出|忽略|管理员|API|secret|token/i.test(content)
    || content.length > 300) return { type: 'clarify' };
  const field = fieldFor(content);
  return field ? { type: 'self_update', field, content } : { type: 'clarify' };
}

export interface MemorySource { id: string; actorId: string; senderId: string; text: string }
export interface MemoryConfirmation { content: string; status: string }

function display(records: MemoryRecord[]): string {
  if (!records.length) return '当前范围没有有效记忆。';
  const lines: string[] = [];
  for (const record of records) {
    const label = record.profileField ? '画像' : record.subjectActorId ? '个人长期记忆' : '会话记忆';
    const line = `${record.id} [${label}] ${record.content}`;
    if ([...lines, line].join('\n').length > 3400) { lines.push('更多内容未显示，请按关键词缩小查询范围。'); break; }
    lines.push(line);
  }
  return lines.join('\n');
}

export function executeMemoryRequest(request: MemoryRequest, conversation: RecordedConversation,
  source: MemorySource, owner: boolean, primaryPerson = false,
  onSaved?: (confirmation: MemoryConfirmation) => void): string {
  if (request.type === 'ai_self_refusal') return AI_SELF_REFUSAL;
  if (request.type === 'ai_self_clarify') return AI_SELF_CLARIFY;
  if (request.type === 'ai_self_update') {
    conversation.addSelfProfile(source.id, request.content);
    onSaved?.({ content: request.content, status: 'AI待整理画像建议已保存，下次对话可参考，尚未完成正式整理归档。' });
    return AI_SELF_ACK;
  }
  if (request.type === 'unsupported_delete') return '不提供删除记忆或偏好的操作；你可以明确纠正信息，我会保留原记录并更新当前内容。';
  if (request.type === 'clarify') return CLARIFY;
  if (request.type === 'profile_read') return owner ? display(conversation.queryMemories('', 20, source.actorId)) : DENIED;
  if (request.type === 'self_update') {
    const existing = conversation.selfProfileMemory(source.actorId, request.field);
    const input = { content: request.content, kind: 'preference' as const, sourceMessageId: source.id,
      subjectActorId: source.actorId, profileField: request.field };
    if (existing) conversation.correctMemory(existing.id, input, existing.revision);
    else conversation.remember(input);
    onSaved?.({ content: request.content, status: `当前发言者的${FIELD_NAMES[request.field]}已更新。` });
    void primaryPerson;
    return `${FIELD_NAMES[request.field]}已更新，用于同一人物已绑定的场景。`;
  }
  if (!owner) return DENIED;
  let text = request.text;
  if (/^(?:请)?记住本群/.test(text)) text = `/memory remember room ${text.replace(/^(?:请)?记住本群[：:\s]*/, '')}`;
  text = text.replace(/^\/remember\s+/i, '/memory remember room ')
    .replace(/^\/memories(?:\s|$)/i, '/memory query ')
    .replace(/^\/correct\s+/i, '/memory correct ');
  const match = text.match(/^\/memory(?:\s+(remember|query|correct))?(?:\s+([\s\S]*))?$/i);
  if (!match || !match[1]) return '管理命令：/memory remember room 内容；/memory remember me 内容；/memory query [关键词]；/memory correct ID 内容。user:发送者ID 可替代 me 指定当前会话成员。';
  const action = match[1].toLowerCase();
  const args = (match[2] ?? '').trim();
  if (action === 'query') {
    const selection = args.match(/^(me|room|user:\S+)(?:\s+(.*))?$/);
    const target = selection?.[1];
    const actor = target === 'room' ? null : target === 'me' ? source.actorId : target?.startsWith('user:') ? conversation.findActor(target.slice(5)) : undefined;
    if (target?.startsWith('user:') && !actor) throw new MemoryError('当前群中没有已验证的该成员。');
    const rows = conversation.queryMemories(selection ? selection[2] ?? '' : args, 20, actor, source.actorId);
    return display(rows);
  }
  if (action === 'remember') {
    const parts = args.match(/^(room|me|user:\S+)\s+([\s\S]+)$/);
    if (!parts) throw new MemoryError('请指定 room、me 或 user:发送者ID，以及内容。');
    const actor = parts[1] === 'me' ? source.actorId : parts[1]!.startsWith('user:') ? conversation.findActor(parts[1]!.slice(5)) : undefined;
    if (parts[1]!.startsWith('user:') && !actor) throw new MemoryError('当前群中没有已验证的该成员。');
    const result = conversation.remember({ ...memoryContent(parts[2]!), sourceMessageId: source.id,
      ...(actor ? { subjectActorId: actor } : {}) });
    onSaved?.({ content: result.memory.content, status: actor ? '指定人物的长期记忆已保存。' : '当前会话的共享记忆已保存。' });
    return `记忆已保存：${result.memory.id}`;
  }
  const parts = args.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  if (!parts) throw new MemoryError('请提供当前会话的记忆 ID。');
  if (action === 'correct') {
    if (!parts[2]) throw new MemoryError('请提供纠正后的内容。');
    const result = conversation.correctMemory(parts[1]!, { ...memoryContent(parts[2]), sourceMessageId: source.id });
    onSaved?.({ content: result.memory.content, status: '指定记忆已纠正，当前内容已更新，旧版本记录保留。' });
    return `记忆已纠正：${result.memory.id}`;
  }
  return '不提供删除记忆或偏好的操作；你可以明确纠正信息，我会保留原记录并更新当前内容。';
}

// Owner-only explicit metadata. Dates are never inferred from a chat sentence.
function memoryContent(input: string): MemoryInput {
  let rest = input.trim();
  const metadata: Omit<MemoryInput, 'content'> = {};
  const seen = new Set<string>();
  while (rest.startsWith('--')) {
    const option = rest.match(/^--(kind|occurred-at|expires-at)\s+(\S+)(?:\s+|$)/);
    if (!option || seen.has(option[1]!)) throw new MemoryError('记忆选项无效或重复。');
    seen.add(option[1]!);
    const value = option[2]!;
    if (option[1] === 'kind') {
      if (!['fact', 'preference', 'episode'].includes(value)) throw new MemoryError('记忆类型须为 fact、preference 或 episode。');
      metadata.kind = value as NonNullable<MemoryInput['kind']>;
    } else {
      if (value !== 'none' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
        || !Number.isFinite(Date.parse(value)))) throw new MemoryError('时间须为带时区的 ISO 日期，清除时间可填 none。');
      metadata[option[1] === 'occurred-at' ? 'occurredAt' : 'expiresAt'] = value === 'none' ? null : new Date(value).toISOString();
    }
    rest = rest.slice(option[0].length).trim();
  }
  if (!rest) throw new MemoryError('请提供记忆内容。');
  return { ...metadata, content: rest };
}

export function safeProfileError(error: MemoryError): string {
  if (/待整理.*(?:容量|上限|已满)/.test(error.message)) return '待整理自我画像容量已满，本次没有保存。请等待后台整理完成，或缩短建议后重试。';
  return error.message.includes('版本') ? '信息版本已变化，请重新明确要更新的内容。' : '未完成记忆操作，请检查目标和内容；不会展示个人画像。';
}

export function relevantProfileFields(text: string): ProfileField[] {
  const fields: ProfileField[] = ['reply_style', 'preferred_name'];
  if (/吃|餐|饭|饮食|口味|辣|菜/.test(text)) fields.push('diet');
  if (/兴趣|爱好|周末|活动|喜欢做|娱乐/.test(text)) fields.push('interests');
  return fields.filter(field => PROFILE_FIELDS.includes(field));
}

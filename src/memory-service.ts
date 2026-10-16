import { MemoryError, type MemoryRecord, type MemoryInput } from './memory-types.js';
import type { RecordedConversation } from './conversation.js';

export type MemoryRequest = { type: 'admin'; text: string } | { type: 'unsupported_delete' };
export interface MemorySource { id: string; actorId: string; senderId: string; text: string }
const DENIED = '你没有记忆管理权限。';

// Only explicit command syntax is routed locally. Natural language always enters Pi.
export function parseMemoryRequest(input: string): MemoryRequest | undefined {
  const text = input.normalize('NFKC').trim();
  if (/^\/(?:forget|memory\s+(?:delete|forget))(?:\s|$)/i.test(text)) return { type: 'unsupported_delete' };
  if (/^\/(?:memory|memories|remember|correct)(?:\s|$)/i.test(text)) return { type: 'admin', text };
  return undefined;
}

function display(records: MemoryRecord[]): string {
  if (!records.length) return '当前范围没有有效记忆。';
  const lines: string[] = [];
  for (const record of records) {
    const line = `${record.id} ${record.content}`;
    if ([...lines, line].join('\n').length > 3400) { lines.push('更多内容未显示，请缩小查询范围。'); break; }
    lines.push(line);
  }
  return lines.join('\n');
}

export function executeMemoryRequest(request: MemoryRequest, conversation: RecordedConversation,
  source: MemorySource, owner: boolean): string {
  if (request.type === 'unsupported_delete') return '不提供删除记忆操作；可以明确纠正，原文与历史版本保留。';
  if (!owner) return DENIED;
  let text = request.text;
  text = text.replace(/^\/remember\s+/i, '/memory remember room ')
    .replace(/^\/memories(?:\s|$)/i, '/memory query ')
    .replace(/^\/correct\s+/i, '/memory correct ');
  const match = text.match(/^\/memory(?:\s+(remember|query|correct))?(?:\s+([\s\S]*))?$/i);
  if (!match || !match[1]) return '房间记忆命令：/memory remember room 内容；/memory query [关键词]；/memory correct ID 内容。';
  const action = match[1].toLowerCase();
  const args = (match[2] ?? '').trim();
  if (action === 'query') {
    const selection = args.match(/^(me|user:[^\s]*)(?:\s+|$)/);
    if (selection) throw new MemoryError('显式记忆命令只管理房间记忆；人物画像请通过普通对话补充。');
    const query = args.replace(/^room(?:\s+|$)/, '');
    const rows = conversation.queryMemories(query, 20);
    return display(rows);
  }
  if (action === 'remember') {
    const parts = args.match(/^(room|me|user:\S+)\s+([\s\S]+)$/);
    if (!parts) throw new MemoryError('房间记忆用法：remember room 内容。人物画像请通过普通对话补充。');
    if (parts[1] !== 'room') throw new MemoryError('显式记忆命令只管理房间记忆；人物画像请通过普通对话补充。');
    conversation.remember({ ...memoryContent(parts[2]!), sourceMessageId: source.id });
    return '记住了。';
  }
  const parts = args.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  if (!parts) throw new MemoryError('请提供当前会话的记忆 ID。');
  if (action === 'correct') {
    if (!parts[2]) throw new MemoryError('请提供纠正后的内容。');
    conversation.correctMemory(parts[1]!, { ...memoryContent(parts[2]), sourceMessageId: source.id });
    return '记住了。';
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
  if (/待整理.*(?:容量|上限|已满)/.test(error.message)) return '待整理记忆容量已满，本次没有保存。请等待后台整理完成，或缩短内容后重试。';
  return error.message.includes('版本') ? '信息版本已变化，请重新明确要更新的内容。' : '未完成记忆操作，请检查目标和内容；不会展示个人画像。';
}

import { lstat, readFile } from 'node:fs/promises';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { RESEARCH_TOOL_SPECS } from './research-tools.js';

const recordedTools = new Set(['web_search', 'web_fetch', 'update_profile', 'read_history', 'read_image',
  'answer_in_depth', 'prepare_turn', ...RESEARCH_TOOL_SPECS.map(tool => tool.name)]);

export type RecordedTurn = {
  runId: string;
  user?: { entryId: string; text: string };
  assistant?: { entryId: string; text: string; stopReason: string; errorMessage?: string };
};

export function recordedTurnsFromEntries(entries: readonly SessionEntry[]): RecordedTurn[] {
  const turns: RecordedTurn[] = [];
  let current: RecordedTurn | undefined;
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === 'pa_run') {
      const data = entry.data;
      current = data && typeof data === 'object' && 'runId' in data
        && typeof data.runId === 'string' && data.runId ? { runId: data.runId } : undefined;
      if (current) turns.push(current);
    } else if (entry.type === 'message' && current) {
      const message = entry.message;
      if (message.role === 'user') {
        // An unmarked second user message starts another turn; never borrow its answer.
        if (current.user) { current = undefined; continue; }
        current.user = {
          entryId: entry.id,
          text: typeof message.content === 'string' ? message.content
            : message.content.filter((part) => part.type === 'text').map((part) => part.text).join(''),
        };
      } else if (message.role === 'assistant' && current.user) {
        current.assistant = {
          entryId: entry.id,
          text: message.content.filter((part) => part.type === 'text').map((part) => part.text).join(''),
          stopReason: message.stopReason,
          ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
        };
      }
    }
  }
  return turns;
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function regularFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`会话数据必须是普通文件：${path}`);
}

function validMessageContent(role: string, content: unknown): boolean {
  if (typeof content === 'string') return role === 'user' || role === 'system';
  if (!Array.isArray(content)) return false;
  return content.every((block: unknown) => {
    if (!block || typeof block !== 'object' || Array.isArray(block) || !('type' in block)) return false;
    switch (block.type) {
      case 'text':
        return 'text' in block && typeof block.text === 'string';
      case 'image':
        return role === 'user' && 'data' in block && typeof block.data === 'string'
          && 'mimeType' in block && typeof block.mimeType === 'string';
      case 'thinking':
        return role === 'assistant' && 'thinking' in block && typeof block.thinking === 'string';
      case 'toolCall':
        return role === 'assistant' && 'id' in block && typeof block.id === 'string'
          && 'name' in block && typeof block.name === 'string' && 'arguments' in block
          && block.arguments !== null && typeof block.arguments === 'object' && !Array.isArray(block.arguments);
      default:
        return false;
    }
  });
}

export async function readSessionEntries(file: string): Promise<SessionEntry[] | undefined> {
  let text: string;
  try {
    await regularFile(file);
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  try {
    // Pi ignores some malformed JSONL lines. Reject them here instead of losing history.
    const lines = text.trim().split('\n');
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const header = entries[0];
    if (!header || header.type !== 'session' || typeof header.id !== 'string' || !header.id
      || header.version !== 3 || typeof header.cwd !== 'string'
      || entries.slice(1).some((entry) => !entry || typeof entry !== 'object'
        || entry.type === 'session' || typeof entry.type !== 'string' || typeof entry.id !== 'string')) {
      throw new Error('会话文件内容无效');
    }
    const ids = new Set<string>();
    for (const entry of entries.slice(1)) {
      if (!entry.id || ids.has(entry.id as string) || typeof entry.timestamp !== 'string'
        || (entry.parentId !== null && (typeof entry.parentId !== 'string' || !ids.has(entry.parentId)))) {
        throw new Error('会话记录标识或父记录无效');
      }
      if (entry.type === 'custom' && entry.customType === 'pa_run'
        && (!entry.data || typeof entry.data !== 'object' || !('runId' in entry.data)
          || typeof entry.data.runId !== 'string' || !entry.data.runId)) throw new Error('运行标记无效');
      if (entry.type === 'message') {
        const message = entry.message;
        if (!message || typeof message !== 'object' || !('role' in message)
          || !['system', 'user', 'assistant', 'toolResult'].includes(String(message.role)) || !('content' in message)
          || (message.role === 'toolResult' && (!('toolName' in message) || !recordedTools.has(String(message.toolName))
            || !('toolCallId' in message) || typeof message.toolCallId !== 'string' || !message.toolCallId
            || !('isError' in message) || typeof message.isError !== 'boolean'))
          || !validMessageContent(String(message.role), message.content)) {
          throw new Error('会话消息无效');
        }
      }
      ids.add(entry.id as string);
    }
    return entries.slice(1) as unknown as SessionEntry[];
  } catch (error) {
    throw new Error(`会话文件损坏，请检查：${file}`, { cause: error });
  }
}

// Pi v3 reopens at the last persisted entry, then follows parentId to the root.
// Read only: do not instantiate SessionManager, whose loader may migrate/write files.
export async function readRecordedTurns(sessionFile: string): Promise<RecordedTurn[]> {
  const entries = await readSessionEntries(sessionFile);
  if (!entries?.length) return [];
  const index = new Map(entries.map(entry => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  let entry = entries.at(-1);
  while (entry) {
    branch.push(entry);
    entry = entry.parentId ? index.get(entry.parentId) : undefined;
  }
  return recordedTurnsFromEntries(branch.reverse());
}

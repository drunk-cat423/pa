import type { DatabaseSync } from 'node:sqlite';
import { MemoryError } from './memory-types.js';

export interface ResearchTargetContext {
  kind: 'current' | 'quote' | 'recent' | 'unresolved' | 'none';
  sourceMessageId?: string;
  urls: string[];
}

const continuation = /这个|那个|这(?:个)?(?:链接|仓库|项目)|那(?:个)?(?:链接|仓库|项目)|刚才(?:的)?(?:链接|仓库|项目)|上(?:面|一条)(?:的)?(?:链接|仓库|项目)|\b(?:this|that)\s+(?:repo(?:sitory)?|project|link)\b/i;
const recentMinutes = 15;

function trimUrlPunctuation(value: string): string {
  const brackets: Record<string, string> = { ')':'(', ']':'[', '}':'{' };
  let candidate = value;
  while (candidate) {
    const closing = candidate.at(-1)!;
    if (/[.,;!?]/u.test(closing)) { candidate = candidate.slice(0, -1); continue; }
    const opening = brackets[closing];
    if (!opening || candidate.split(closing).length <= candidate.split(opening).length) break;
    candidate = candidate.slice(0, -1);
  }
  return candidate;
}

export function researchUrls(value: string): string[] {
  const found: string[] = [];
  for (const match of value.matchAll(/https?:\/\/[^\s<>"'`\u3000，。；！？、（）【】]+/giu)) {
    const candidate = trimUrlPunctuation(match[0]);
    try {
      const url = new URL(candidate);
      if (!url.username && !url.password && !found.includes(url.href)) found.push(url.href);
    } catch { /* Invalid prose is not a trusted target. */ }
  }
  return found;
}

function targetKey(value: string): string {
  const url = new URL(value);
  url.hash = '';
  const repository = url.hostname.toLowerCase() === 'github.com' && url.pathname.match(/^\/([^/]+)\/([^/]+)/u);
  if (repository) return `github.com/${repository[1]!.toLowerCase()}/${repository[2]!.replace(/\.git$/i, '').toLowerCase()}`;
  return url.href.replace(/\/$/u, '');
}

/** Only stored human messages and a persisted explicit quote can anchor a target. */
export function researchTargetContext(db: DatabaseSync, conversationId: string, sourceMessageId: string): ResearchTargetContext {
  const source = db.prepare(`SELECT m.id,m.actor_id,m.text,m.ingest_seq,m.created_at,m.sent_at FROM messages m
    JOIN conversations c ON c.id=m.conversation_id JOIN actors a ON a.id=m.actor_id AND a.room_id=c.room_id
    WHERE m.id=? AND m.conversation_id=? AND m.role='user'`).get(sourceMessageId, conversationId);
  if (!source) throw new MemoryError('研究操作缺少当前房间的真人来源。');
  const direct = researchUrls(String(source.text));
  if (direct.length) return { kind: 'current', sourceMessageId, urls: direct };
  const persisted = db.prepare('SELECT input_json FROM channel_tasks WHERE message_id=? AND conversation_id=?').get(sourceMessageId, conversationId);
  const quote = persisted ? (JSON.parse(String(persisted.input_json)) as { quote?: { messageId?: string; referenceIndex?: string } }).quote : undefined;
  if (quote?.messageId) {
    const rows = db.prepare(`SELECT id,text FROM messages WHERE conversation_id=? AND role='user'
      AND external_event_id=? AND ingest_seq<? LIMIT 2`).all(conversationId, quote.messageId, source.ingest_seq!);
    if (rows.length === 1) {
      const urls = researchUrls(String(rows[0]!.text));
      if (urls.length) return { kind: 'quote', sourceMessageId: String(rows[0]!.id), urls };
    }
  }
  if (!continuation.test(String(source.text))) return { kind: 'none', urls: [] };
  // An explicit but unresolved quote must never silently switch to another link.
  if (quote?.messageId || quote?.referenceIndex) return { kind: 'unresolved', urls: [] };
  const previous = db.prepare(`SELECT id,text,created_at,sent_at FROM messages WHERE conversation_id=? AND actor_id=?
    AND role='user' AND message_kind='chat' AND ingest_seq<? ORDER BY ingest_seq DESC LIMIT 5`)
    .all(conversationId, source.actor_id!, source.ingest_seq!);
  const at = Date.parse(String(source.sent_at ?? source.created_at));
  for (const row of previous) {
    const age = at - Date.parse(String(row.sent_at ?? row.created_at));
    const receivedAge = Date.parse(String(source.created_at)) - Date.parse(String(row.created_at));
    if (!Number.isFinite(age) || age < 0 || age > recentMinutes * 60_000 || receivedAge < 0 || receivedAge > recentMinutes * 60_000) continue;
    const urls = researchUrls(String(row.text));
    if (urls.length) return { kind: 'recent', sourceMessageId: String(row.id), urls };
    // Only a short chain of explicit continuation can bridge a linkless turn.
    if (!continuation.test(String(row.text))) break;
  }
  return { kind: 'unresolved', urls: [] };
}

const compact = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const withoutUrls = (value: string) => value.replace(/https?:\/\/\S+/giu, '');

export function validateResearchTarget(context: ResearchTargetContext, title: string, goal: string, urls: string[]): void {
  if (context.kind === 'unresolved') throw new MemoryError('研究对象不明确：本条承接请求没有可靠的当前房间本人链接或明确引用，请补充目标链接后重新组织研究标题和目标。');
  if (!context.urls.length) return;
  const allowed = new Set(context.urls.map(targetKey));
  const comparison = /比较|对比|替代|摆脱|相比|\b(?:vs\.?|versus|compar\w*|replac\w*)\b/i.test(`${title}\n${goal}`);
  if (!urls.length || !allowed.has(targetKey(urls[0]!))
    || (!comparison && (urls.some(url => !allowed.has(targetKey(url)))
      || researchUrls(`${title}\n${goal}`).some(url => !allowed.has(targetKey(url)))))) {
    throw new MemoryError(`研究对象与原始消息链接不一致：请基于锚点 ${context.urls.join('、')} 重新组织标题、目标和链接，不能替换项目。`);
  }
  // A URL-only replacement must not keep another repository's task title/goal.
  // Require a human-readable repository identity, not verbatim user wording.
  const repositories = urls.map(url => new URL(url)).filter(url => url.hostname.toLowerCase() === 'github.com')
    .map(url => url.pathname.split('/').filter(Boolean).slice(0, 2)).filter(parts => parts.length === 2);
  const anchors = repositories.filter(parts => allowed.has(`github.com/${parts[0]!.toLowerCase()}/${parts[1]!.replace(/\.git$/i, '').toLowerCase()}`));
  if (anchors.length && !anchors.some(parts => {
    const name = compact(parts[1]!.replace(/\.git$/i, ''));
    return (name.length >= 3 && compact(withoutUrls(title)).includes(name))
      || withoutUrls(title).toLowerCase().includes(`${parts[0]}/${parts[1]}`.toLowerCase());
  })) throw new MemoryError('研究标题缺少锚点仓库名称：请根据原始链接重新组织标题及目标，不能只修改链接后沿用其他项目内容。');
}

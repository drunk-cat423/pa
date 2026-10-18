import type { OutboundMessage } from './channel-types.js';

export const MARKDOWN_PAGE_BYTES = 1500;
const BODY_BYTES = 1380;
export const PAGE_COMMAND = /^\/page ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) (0|[1-9][0-9]{0,8})$/i;

function prefix(text: string, bytes: number): string {
  let result = '';
  for (const character of text) {
    if (Buffer.byteLength(result + character) > bytes) break;
    result += character;
  }
  return result;
}

// Bound display bytes, keeping every source character in order. Close and reopen
// fenced code blocks at page boundaries; the canonical message is never changed.
export function markdownBodyPages(text: string): string[] {
  const pages: string[] = [];
  let current = '', fence: { marker: string; opening: string } | undefined;
  const finish = () => {
    if (current) pages.push(current + (fence ? `\n${fence.marker}` : ''));
    current = fence ? `${fence.opening}\n` : '';
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const match = /^( {0,3})(`{3,}|~{3,})([^\n]*)\n?$/.exec(line);
    const closes = fence && match && match[2]![0] === fence.marker[0]
      && match[2]!.length >= fence.marker.length && !match[3]!.trim();
    const opens = !fence && match && Buffer.byteLength(line) < 200;
    if (match && (closes || opens)) {
      if (closes) {
        // Closing marker length and trailing whitespace are formatting only;
        // normalize them so even pathological fences fit the reserved budget.
        current += `${fence!.marker}\n`;
        fence = undefined;
        continue;
      }
      if (Buffer.byteLength(current + line) + 220 > BODY_BYTES && current) finish();
      current += line;
      fence = { marker: match[2]!, opening: line.trimEnd() };
      continue;
    }
    let remaining = line;
    while (remaining) {
      const room = BODY_BYTES - Buffer.byteLength(current) - (fence ? Buffer.byteLength(fence.marker) + 1 : 0);
      if (Buffer.byteLength(remaining) <= room) { current += remaining; break; }
      if (current && current !== (fence ? `${fence.opening}\n` : '')) { finish(); continue; }
      const part = prefix(remaining, room);
      current += part;
      remaining = remaining.slice(part.length);
      finish();
    }
  }
  if (current && current !== (fence ? `${fence.opening}\n` : '')) finish();
  return pages;
}

export function markdownDocument(text: string, force = false): { summary: string; pages: string[] } | undefined {
  if (!force && Buffer.byteLength(text) <= BODY_BYTES) return undefined;
  const pages = markdownBodyPages(text);
  const first = text.trim().split(/\n\s*\n/, 1)[0]!;
  // A bounded first prose paragraph is the model's requested conclusion. Other
  // structures are explicitly a preview, without claiming semantic summarization.
  const prose = first && Buffer.byteLength(first) <= 650 && !/^\s*(?:#|```|~~~|\||[-*] |\d+\.)/.test(first);
  const preview = prose ? first : markdownBodyPages(prefix(text.trim(), 600))[0] ?? '';
  return { summary: `**${prose ? '摘要' : '开头预览'}**\n\n${preview}\n\n正文共 ${pages.length} 页，点击下方按钮阅读。`, pages };
}

export function pageButtons(id: string, page: number, count: number): NonNullable<OutboundMessage['buttons']> {
  return [
    ...(page > 0 ? [{ label: page === 1 ? '返回摘要' : '上一页', command: `/page ${id} ${page - 1}` }] : []),
    ...(page < count ? [{ label: '下一页', command: `/page ${id} ${page + 1}` }] : []),
  ];
}

export function displayedPage(summary: string, pages: readonly string[], page: number, answerId = ''): string | undefined {
  return page === 0 ? summary : pages[page - 1] === undefined ? undefined : `**${answerId ? `回答 ${answerId.slice(0,8)} · ` : ''}正文 ${page}/${pages.length}**\n\n${pages[page - 1]}`;
}

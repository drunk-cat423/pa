export const REPLY_CHUNK_LIMIT = 500;
// QQ's documented passive reply allowance is five messages per incoming message.
export const QQ_PASSIVE_REPLY_LIMIT = 5;

/** Preserve every code point, including separators. Long URLs are safely hard split. */
export function splitReply(text: string, limit = REPLY_CHUNK_LIMIT, maxParts?: number): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('回复分段上限必须是正整数。');
  if (maxParts !== undefined && (!Number.isSafeInteger(maxParts) || maxParts < 1)) throw new Error('回复分段数量必须是正整数。');
  const characters = [...text];
  const urls = [...text.matchAll(/https?:\/\/[^\s<>]+/g)].map(match => {
    const start = [...text.slice(0, match.index)].length;
    return { start, end: start + [...match[0]].length };
  });
  const chunks: string[] = [];
  let start = 0;
  while (start < characters.length) {
    let end = Math.min(start + limit, characters.length);
    if (end < characters.length) {
      const safe = (position: number) => !urls.some(url => position > url.start && position < url.end);
      // Prefer paragraphs, then sentences, then individual newlines.
      for (const boundary of [
        (index: number) => characters[index - 1] === '\n' && characters[index - 2] === '\n',
        (index: number) => /[。！？.!?]/u.test(characters[index - 1] ?? ''),
        (index: number) => characters[index - 1] === '\n',
      ]) {
        let selected = 0;
        for (let index = end; index > start; index--) if (boundary(index) && safe(index)) { selected = index; break; }
        if (selected) { end = selected; break; }
      }
      const crossing = urls.find(url => end > url.start && end < url.end);
      if (crossing && crossing.start > start) end = crossing.start;
      // A URL longer than limit at the start has no valid whole-URL boundary.
    }
    chunks.push(characters.slice(start, end).join(''));
    start = end;
  }
  if (maxParts !== undefined && chunks.length > maxParts) {
    const balancedLimit = Math.max(limit, Math.ceil(characters.length / maxParts));
    const preferred = splitReply(text, balancedLimit);
    if (preferred.length <= maxParts) return preferred;
    // Boundary preferences can waste passive slots; evenly divide rather than omit text.
    return Array.from({ length: Math.ceil(characters.length / balancedLimit) }, (_, index) =>
      characters.slice(index * balancedLimit, (index + 1) * balancedLimit).join(''));
  }
  return chunks;
}

export function appendReferenceUrls(text: string, urls: readonly string[] = []): string {
  if (!urls.length) return text;
  // Only a clearly delimited final reference section is replaced; prose stays intact.
  const body = text.replace(/(?:^|\n)\[参考链接\][ \t]*\n(?:https?:\/\/[^\n]+\n?)+[ \t\n]*$/u, '').trimEnd();
  return `${body}\n\n[参考链接]\n${[...new Set(urls)].join('\n')}`;
}

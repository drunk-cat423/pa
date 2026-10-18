export const MARKDOWN_CHUNK_BYTES = 1500;
const FENCE_RESERVE_BYTES = 220;

function prefix(text: string, bytes: number): string {
  let result = '';
  for (const character of text) {
    if (Buffer.byteLength(result + character) > bytes) break;
    result += character;
  }
  return result;
}

/** Split Markdown without dropping source text, balancing fenced code blocks at chunk boundaries. */
export function splitMarkdown(text: string): string[] {
  const chunks: string[] = [];
  let current = '', fence: { marker: string; opening: string } | undefined;
  const finish = () => {
    if (current) chunks.push(current + (fence ? `\n${fence.marker}` : ''));
    current = fence ? `${fence.opening}\n` : '';
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const match = /^( {0,3})(`{3,}|~{3,})([^\n]*)\n?$/.exec(line);
    const closes = fence && match && match[2]![0] === fence.marker[0]
      && match[2]!.length >= fence.marker.length && !match[3]!.trim();
    const opens = !fence && match && Buffer.byteLength(line) < 200;
    if (match && (closes || opens)) {
      if (closes) {
        current += `${fence!.marker}\n`;
        fence = undefined;
        continue;
      }
      if (Buffer.byteLength(current + line) + FENCE_RESERVE_BYTES > MARKDOWN_CHUNK_BYTES && current) finish();
      current += line;
      fence = { marker: match[2]!, opening: line.trimEnd() };
      continue;
    }
    let remaining = line;
    while (remaining) {
      const room = MARKDOWN_CHUNK_BYTES - Buffer.byteLength(current) - (fence ? Buffer.byteLength(fence.marker) + 1 : 0);
      if (Buffer.byteLength(remaining) <= room) { current += remaining; break; }
      if (current && current !== (fence ? `${fence.opening}\n` : '')) { finish(); continue; }
      const part = prefix(remaining, room);
      current += part;
      remaining = remaining.slice(part.length);
      finish();
    }
  }
  if (current && current !== (fence ? `${fence.opening}\n` : '')) finish();
  return chunks;
}

// Conservative transport formatting. Code spans/blocks and URLs are opaque content.
// This does not replace the model's original persisted reply.
function prose(text: string): string {
  return text.split(/(`+[^`\n]+`+|!?\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>]+)/g).map(part => {
    if (part.startsWith('`')) {
      const code = /^(`+)([\s\S]*?)\1$/.exec(part);
      return code ? code[2]! : part;
    }
    const link = /^!?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) return `${link[1]} (${link[2]})`;
    if (/^https?:\/\//.test(part)) return part;
    return part
      .replace(/!?(\[[^\]\n]+\])\(([^\s)]+)\)/g, (_match, label: string, url: string) => `${label.slice(1, -1)} (${url})`)
      .replace(/(?:(?<![\p{L}\p{N}_*])|(?<=\p{Script=Han}))\*\*([^*\s](?:[^*\n]*[^*\s])?)\*\*(?=$|[^\p{L}\p{N}_*]|\p{Script=Han})/gu, '$1')
      .replace(/(^|[^\p{L}\p{N}_*])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?=$|[^\p{L}\p{N}_*])/gu, '$1$2')
      .replace(/(^|[^\p{L}\p{N}_])__([^_\n]*\S)__(?=$|[^\p{L}\p{N}_])/gu, '$1$2')
      .replace(/(^|[^\p{L}\p{N}_])_([^_\s](?:[^_\n]*[^_\s])?)_(?=$|[^\p{L}\p{N}_])/gu, '$1$2');
  }).join('');
}

function tableCells(line: string): string[] | undefined {
  if (/^(?: {4}|\t)/.test(line)) return undefined;
  const cells = [''];
  for (const part of line.trim().split(/(`+[^`\n]+`+)/g)) {
    if (part.startsWith('`')) { cells[cells.length - 1] += part; continue; }
    const pieces = part.split(/(?<!\\)\|/);
    cells[cells.length - 1] += pieces[0] ?? '';
    cells.push(...pieces.slice(1));
  }
  if (!cells[0]?.trim()) cells.shift();
  if (!cells.at(-1)?.trim()) cells.pop();
  return cells.length >= 2 ? cells.map(cell => cell.trim()) : undefined;
}

export function toPlainText(text: string): string {
  const lines = text.split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = /^\s{0,3}(`{3,}|~{3,})[^`]*$/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const end = lines.findIndex((candidate, next) => next > index
        && new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(candidate));
      if (end !== -1) {
        output.push(...lines.slice(index + 1, end));
        index = end;
        continue;
      }
    }
    if (/^(?: {4}|\t)/.test(line)) { output.push(line); continue; }
    const header = tableCells(line);
    const separator = tableCells(lines[index + 1] ?? '');
    if (header && separator?.length === header.length && separator.every(cell => /^:?-{3,}:?$/.test(cell))) {
      const rows: string[][] = [];
      let next = index + 2;
      while (next < lines.length) {
        const cells = tableCells(lines[next]!);
        if (!cells || cells.length !== header.length) break;
        rows.push(cells); next++;
      }
      if (rows.length) {
        output.push(...rows.map(row => row.map((cell, column) =>
          `${prose(header[column]!) || `列${column + 1}`}：${prose(cell)}`).join('；')));
        index = next - 1;
        continue;
      }
    }
    // Only full Markdown constructs are removed; e.g. #include and 2 * 3 survive.
    if (/^\s{0,3}(?:\*\s*){3,}$/.test(line) || /^\s{0,3}(?:-\s*){3,}$/.test(line)) continue;
    output.push(prose(line.replace(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/, '$1')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^(\s*)[*+-]\s+/, '$1• ')));
  }
  return output.join('\n');
}

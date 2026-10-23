import type { convertToLlm } from '@earendil-works/pi-coding-agent';

type Transcript = Parameters<typeof convertToLlm>[0];
export interface ResearchContextReference { tool: string; text: string }
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function encodedResult(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== 'string') return undefined;
  // WebFetchReader places its JSON after one fixed explanatory paragraph.
  const start = text.startsWith('{') ? 0 : text.indexOf('\n{');
  if (start < 0) return undefined;
  try { return object(JSON.parse(text.slice(start).trim())); } catch { return undefined; }
}

/** Only a reference to already persisted, readable material may replace a body. */
export function researchContextReference(tool: string, input: unknown, result: unknown,
  materialId: string): ResearchContextReference | undefined {
  if (!/^e[1-9][0-9]*$/u.test(materialId) || !['web_fetch', 'web_search', 'read_research_material'].includes(tool)) return undefined;
  const value = object(result);
  if (!value || value.error !== undefined || value.originalRead === false) return undefined;
  const decoded = tool === 'web_fetch' ? encodedResult(value.text) : undefined;
  if (tool === 'web_fetch' && !decoded) return undefined;
  if (decoded?.error !== undefined || decoded?.originalRead === false) return undefined;
  const data = decoded ?? value;
  // Do not interpret or summarize evidence. Keep source/coverage/cursor metadata
  // verbatim, and expose a small literal excerpt with an explicit omission notice.
  const metadata = Object.fromEntries(Object.entries(data).filter(([key]) =>
    !['text', 'summary', 'generatedSummary'].includes(key)));
  const body = data.text ?? data.summary ?? data.generatedSummary;
  const excerpt = typeof body === 'string' ? [...body].slice(0, 240).join('') : undefined;
  return { tool, text: JSON.stringify({ ...metadata, projection: 'saved_research_material', id: materialId, tool, input,
    ...(decoded && value.coverage ? { coverage: value.coverage } : {}),
    ...(excerpt ? { excerpt } : {}), bodyOmitted: true,
    notice: '较旧工具正文已从本次上下文省略，原材料完整保存。摘录不代表全文；需要原文时调用read_research_material按此id从offset=0读取，后续只用该工具返回的nextOffset，不使用网页coverage偏移。网页续读仍使用原url/nextCursor。' }) };
}

/** A wire-only projection: neither the transcript nor persisted results change. */
export function compactResearchContext(messages: Transcript,
  references: ReadonlyMap<string, ResearchContextReference>): Transcript {
  const lastResult = messages.findLastIndex(message => message.role === 'toolResult');
  if (lastResult < 0) return messages;
  let latestBatch = -1;
  for (let index = lastResult - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'assistant' && message.content.some(part => part.type === 'toolCall')) {
      latestBatch = index; break;
    }
  }
  if (latestBatch < 0) return messages;
  const calls = new Map<string, string>();
  return messages.map((message, index) => {
    if (message.role === 'assistant') {
      for (const part of message.content) if (part.type === 'toolCall') calls.set(part.id, part.name);
    }
    if (index >= latestBatch || message.role !== 'toolResult' || message.isError
      || message.content.some(part => part.type !== 'text')) return message;
    const reference = references.get(message.toolCallId);
    if (!reference || calls.get(message.toolCallId) !== message.toolName || reference.tool !== message.toolName) return message;
    const originalBytes = Buffer.byteLength(JSON.stringify(message.content), 'utf8');
    const content = [{ type: 'text' as const, text: reference.text }];
    return Buffer.byteLength(JSON.stringify(content), 'utf8') < originalBytes ? { ...message, content } : message;
  });
}

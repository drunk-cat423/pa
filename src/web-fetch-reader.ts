import { randomUUID } from 'node:crypto';
import { fetchWebPage, normalizeWebFetchUrl, type WebFetchConfig } from './web-fetch.js';

type Document = Awaited<ReturnType<typeof fetchWebPage>>;
type FetchDocument = typeof fetchWebPage;

/** One reader per foreground task; neither documents nor cursor authority cross tasks. */
export class WebFetchReader {
  private readonly documents = new Map<string, Promise<Document>>();
  private readonly cursors = new Map<string, { url: string; offset: number }>();
  private usedBytes = 0;
  private reads = 0;
  private disposed = false;
  private budgetExhausted = false;

  constructor(private readonly config: WebFetchConfig,
    private readonly budget: { maxResultBytes: number; maxReads: number; maxTotalBytes: number },
    private readonly fetchDocument: FetchDocument = fetchWebPage) {
    if (![budget.maxResultBytes, budget.maxReads, budget.maxTotalBytes, config.maxTextChars]
      .every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('网页读取预算无效。');
  }

  async read(input: { url: string; cursor?: string }, prefix = '', signal?: AbortSignal,
    allowContinuation = true): Promise<{ url: string; text: string }> {
    if (this.disposed) throw new Error('本轮网页缓存已释放。');
    if (!this.config.enabled) throw new Error('网页读取未启用。');
    signal?.throwIfAborted();
    if (++this.reads > this.budget.maxReads || this.budgetExhausted || this.usedBytes >= this.budget.maxTotalBytes)
      throw new Error('本轮网页读取预算已用尽，请根据已读内容回答并说明缺失部分。');
    const url = normalizeWebFetchUrl(input.url);
    const cursor = input.cursor === undefined ? undefined : this.cursors.get(input.cursor);
    if (input.cursor !== undefined && (!cursor || cursor.url !== url))
      throw new Error('网页续读游标无效、已过期或不属于此链接，请勿重试猜测游标。');
    let document = this.documents.get(url);
    const cached = Boolean(document);
    if (!document) {
      // Retain failures too: another call for this URL never becomes an implicit retry.
      document = this.fetchDocument(url, this.config, signal);
      this.documents.set(url, document);
    }
    const response = await document;
    if (this.disposed) throw new Error('本轮网页缓存已释放。');
    signal?.throwIfAborted();
    const { text, ...metadata } = response;
    const offset = cursor?.offset ?? 0;
    const nextCursor = randomUUID();
    const maxBytes = Math.min(this.budget.maxResultBytes, this.budget.maxTotalBytes - this.usedBytes);
    const serialize = (end: number, canContinue = true, start = offset) => prefix + JSON.stringify({ ...metadata,
      cached, offset: start, endOffset: end, totalChars: text.length,
      truncated: start > 0 || end < text.length, hasMore: end < text.length,
      nextCursor: end < text.length && canContinue ? nextCursor : null,
      readBudgetExhausted: end < text.length && !canContinue, text: text.slice(start, end) });
    if (Buffer.byteLength(serialize(offset), 'utf8') > maxBytes)
      throw new Error('网页元数据超过剩余工具输出预算，未返回残缺正文。');
    let low = offset, high = offset;
    for (let chars = 0; chars < this.config.maxTextChars && high < text.length; chars++) {
      high += text.codePointAt(high)! > 0xffff ? 2 : 1;
    }
    if (Buffer.byteLength(serialize(high), 'utf8') <= maxBytes) low = high;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(serialize(middle), 'utf8') <= maxBytes) low = middle;
      else high = middle - 1;
    }
    // Cursor offsets are UTF-16 indices, always on code-point boundaries.
    if (low > offset && /[\ud800-\udbff]/u.test(text[low - 1]!)) low--;
    if (low === offset && offset < text.length) throw new Error('剩余工具输出预算不足以返回网页正文。');
    let output = serialize(low);
    const remaining = this.budget.maxTotalBytes - this.usedBytes - Buffer.byteLength(output, 'utf8');
    const hasByteBudget = remaining >= Buffer.byteLength(serialize(Math.min(text.length, low + 2), true, low), 'utf8');
    const canContinue = allowContinuation && this.reads < this.budget.maxReads && hasByteBudget;
    if (low < text.length) {
      if (canContinue) this.cursors.set(nextCursor, { url, offset: low });
      else {
        output = serialize(low, false);
        // A final model turn can have several already queued fetches. Lack of a
        // future model turn must not block those while their hard budgets fit.
        if (!hasByteBudget) this.budgetExhausted = true;
      }
    }
    this.usedBytes += Buffer.byteLength(output, 'utf8');
    return { url: response.url, text: output };
  }

  dispose(): void {
    this.disposed = true;
    this.documents.clear();
    this.cursors.clear();
  }
}

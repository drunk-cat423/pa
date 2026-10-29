import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { PaConfig } from './config.js';
import { acquireConversationLock } from './conversation-lock.js';
import { requestTimeData } from './request-time.js';
import { outputLengthGuidance } from './output-length.js';
import { DiagnosticLog, DiagnosticPersistenceError, type DiagnosticContext } from './diagnostics.js';

export interface WebSearchConfig {
  enabled: boolean;
  budgetId: string;
  /** 0 disables the local total request cap; requests are still recorded. */
  maxRequests: number;
  /** 0 omits the provider's per-request max_uses cap. */
  maxUses: number;
  maxTokens: number;
  timeoutMs: number;
  model: string;
  maxResults: number;
}

export interface SearchDateRange {
  startDate?: string;
  endDate?: string;
}

export interface WebSearchResult {
  summary?: string;
  truncated: boolean;
  sources: { url: string; title?: string; snippet?: string; pageUpdatedAt?: string }[];
  freshness: {
    searchedAt: string;
    timeZone: string;
    requestedDateRange: SearchDateRange | null;
    dateFilterApplied: false;
    verification: 'unverified';
  };
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number | null;
    serverSearches: number | null;
  };
  attemptId: string;
}

export class WebSearchError extends Error {
  constructor(message: string) { super(message); this.name = 'WebSearchError'; }
}

export class WebSearchPersistenceError extends Error {
  constructor() { super('网页搜索预算记录无法安全读取或持久化。'); this.name = 'WebSearchPersistenceError'; }
}

type LedgerEvent =
  | { type: 'reserved'; attemptId: string; timestamp: string; query: string }
  | { type: 'completed'; attemptId: string; timestamp: string; sources: WebSearchResult['sources']; usage: WebSearchResult['usage']; summary?: string }
  | { type: 'failed'; attemptId: string; timestamp: string; reason: string };

const ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages';
const MAX_RESPONSE_BYTES = 1024 * 1024;

export function bailianSearchEndpoint(baseUrl?: string): string | undefined {
  if (!baseUrl || !/^https:\/\/ws-[a-z0-9]+\.cn-beijing\.maas\.aliyuncs\.com\/compatible-mode\/v1\/?$/.test(baseUrl)) return undefined;
  return new URL('/apps/anthropic/v1/messages', baseUrl).href;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new WebSearchError(`网页搜索配置 ${label} 无效。`);
}

function nonNegativeConfigInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new WebSearchError(`网页搜索配置 ${label} 无效。`);
}

function validateConfig(search: WebSearchConfig): void {
  if (!search || typeof search !== 'object' || search.enabled !== true) throw new WebSearchError('网页搜索未启用。');
  if (typeof search.budgetId !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(search.budgetId)) {
    throw new WebSearchError('网页搜索预算标识无效。');
  }
  for (const [value, label] of [[search.maxRequests, 'maxRequests'], [search.maxUses, 'maxUses']] as const) {
    nonNegativeConfigInteger(value, label);
  }
  for (const [value, label] of [
    [search.maxTokens, 'maxTokens'], [search.timeoutMs, 'timeoutMs'], [search.maxResults, 'maxResults'],
  ] as const) positiveInteger(value, label);
  if (search.timeoutMs > 2_147_483_647 || search.maxResults > 100 || search.maxUses > 100
    || search.maxTokens > 100_000 || typeof search.model !== 'string' || !search.model.trim()) {
    throw new WebSearchError('网页搜索配置超出允许范围。');
  }
}

function validUsage(value: unknown): WebSearchResult['usage'] {
  const usage = record(value) ?? {};
  const inputTokens = nonNegativeIntegerOrNull(usage.input_tokens);
  const outputTokens = nonNegativeIntegerOrNull(usage.output_tokens);
  const cacheReadTokens = nonNegativeInteger(usage.cache_read_input_tokens);
  const cacheWriteTokens = nonNegativeInteger(usage.cache_creation_input_tokens);
  const native = record(usage.server_tool_use);
  return {
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    totalTokens: inputTokens === null || outputTokens === null ? null
      : inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    serverSearches: nonNegativeIntegerOrNull(native?.web_search_requests),
  };
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseSearchResponse(body: unknown, maxResults: number): Omit<WebSearchResult, 'attemptId' | 'freshness'> {
  const root = record(body);
  if (!root || !Array.isArray(root.content)) throw new WebSearchError('DeepSeek 网页搜索响应格式无效。');
  const sourcesByUrl = new Map<string, WebSearchResult['sources'][number]>();
  let sawSearchResults = false;
  let sawSuccessfulBlock = false;
  let sawNativeError = false;
  for (const rawBlock of root.content) {
    const block = record(rawBlock);
    if (!block) continue;
    if (block.type === 'web_search_tool_error' || block.type === 'web_search_tool_result' && block.is_error === true) {
      throw new WebSearchError('DeepSeek 网页搜索工具执行失败。');
    }
    if (block.type === 'web_search_tool_result') {
      if (!Array.isArray(block.content)) throw new WebSearchError('DeepSeek 网页搜索结果格式无效。');
      sawSearchResults = true;
      if (block.content.length === 0 || block.content.some(item => record(item)?.type === 'web_search_result')) sawSuccessfulBlock = true;
      for (const itemRaw of block.content) {
        const item = record(itemRaw);
        if (item?.type === 'web_search_tool_result_error') sawNativeError = true;
        if (!item || item.type !== 'web_search_result' || typeof item.url !== 'string') continue;
        let url: URL;
        try { url = new URL(item.url); } catch { continue; }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
        const canonicalUrl = url.href.slice(0, 2048);
        if (!sourcesByUrl.has(canonicalUrl)) {
          sourcesByUrl.set(canonicalUrl, {
            url: canonicalUrl,
            ...(boundedString(item.title, 200) ? { title: boundedString(item.title, 200)! } : {}),
            ...(boundedString(item.page_age, 200) ? { pageUpdatedAt: boundedString(item.page_age, 200)! } : {}),
          });
        }
      }
    }
  }
  if (!sawSearchResults) throw new WebSearchError('DeepSeek 响应没有网页搜索结果块。');
  if (sawNativeError && !sawSuccessfulBlock) throw new WebSearchError('DeepSeek 网页搜索工具执行失败。');

  // Ordinary anchors locate the same page. Hash routes may identify different documents.
  // Keep query strings and #/ or #! routes; never join different routed pages.
  const pageKey = (value: string) => {
    const url = new URL(value);
    if (!url.hash.startsWith('#/') && !url.hash.startsWith('#!')) url.hash = '';
    return url.href;
  };
  const sourcesByPage = new Map<string, WebSearchResult['sources']>();
  for (const source of sourcesByUrl.values()) {
    const key = pageKey(source.url);
    const matches = sourcesByPage.get(key) ?? [];
    matches.push(source);
    sourcesByPage.set(key, matches);
  }
  // Citations are accepted only from text blocks and only enrich native search results.
  for (const rawBlock of root.content) {
    const block = record(rawBlock);
    if (block?.type !== 'text' || !Array.isArray(block.citations)) continue;
    for (const rawCitation of block.citations) {
      const citation = record(rawCitation);
      if (!citation || typeof citation.url !== 'string') continue;
      let url: string;
      try { url = new URL(citation.url).href.slice(0, 2048); } catch { continue; }
      const sources = sourcesByPage.get(pageKey(url)) ?? [];
      const snippet = boundedString(citation.cited_text, 1000);
      for (const source of sources) if (snippet && !source.snippet) source.snippet = snippet;
    }
  }
  const fullSummary = root.content.flatMap(block => {
    const value = record(block);
    return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : [];
  }).join('\n\n').trim();
  const summary = fullSummary.slice(0, 8000);
  return { sources: [...sourcesByUrl.values()].slice(0, maxResults), usage: validUsage(root.usage),
    truncated: root.stop_reason === 'max_tokens' || summary.length < fullSummary.length,
    ...(summary ? { summary } : {}) };
}

async function saveEvidence(directory: string, attemptId: string, kind: 'request' | 'response',
  value: unknown, apiKey: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    // Request headers are never passed here. Provider bodies remain local, bounded and ignored by Git.
    const json = JSON.stringify(value).split(apiKey).join('[redacted]');
    handle = await open(join(directory, `${attemptId}.${kind}.json`), 'wx', 0o600);
    await handle.writeFile(json + '\n', 'utf8');
    await handle.sync();
  } catch { throw new WebSearchPersistenceError(); }
  finally {
    try { await handle?.close(); } catch { throw new WebSearchPersistenceError(); }
  }
}

async function readBoundedBody(response: Response): Promise<unknown> {
  if (!response.body) throw new WebSearchError('DeepSeek 响应为空。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new WebSearchError('DeepSeek 响应超过大小限制。');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    throw new WebSearchError('DeepSeek 响应读取失败或已取消。');
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
  catch { throw new WebSearchError('DeepSeek 响应不是有效 JSON。'); }
}

function validateLedgerLine(value: unknown): LedgerEvent {
  const entry = record(value);
  if (!entry || typeof entry.type !== 'string' || typeof entry.attemptId !== 'string'
    || !/^[0-9a-f-]{36}$/.test(entry.attemptId) || typeof entry.timestamp !== 'string'
    || !Number.isFinite(Date.parse(entry.timestamp))) throw new WebSearchPersistenceError();
  const exactKeys = (...keys: string[]) => Object.keys(entry).length === keys.length && keys.every(key => key in entry);
  if (entry.type === 'reserved' && exactKeys('type', 'attemptId', 'timestamp', 'query')
    && typeof entry.query === 'string' && entry.query.length <= 500) return entry as LedgerEvent;
  if (entry.type === 'failed' && exactKeys('type', 'attemptId', 'timestamp', 'reason')
    && typeof entry.reason === 'string' && entry.reason.length <= 200) return entry as LedgerEvent;
  const usage = record(entry.usage);
  const validUsage = usage && Object.keys(usage).length === 6
    && ['cacheReadTokens', 'cacheWriteTokens'].every(key =>
      typeof usage[key] === 'number' && Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0)
    && ['inputTokens', 'outputTokens', 'totalTokens'].every(key => usage[key] === null
      || typeof usage[key] === 'number' && Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0)
    && (usage.serverSearches === null || typeof usage.serverSearches === 'number'
      && Number.isSafeInteger(usage.serverSearches) && usage.serverSearches >= 0);
  const validSources = Array.isArray(entry.sources) && entry.sources.every(sourceRaw => {
    const source = record(sourceRaw);
    return source && typeof source.url === 'string' && source.url.length <= 2048
      // Old persisted ledgers called page_age publishedAt. Read them for budget
      // accounting only; new results never expose that misleading field.
      && Object.keys(source).every(key => ['url', 'title', 'snippet', 'publishedAt', 'pageUpdatedAt'].includes(key))
      && (source.title === undefined || typeof source.title === 'string' && source.title.length <= 200)
      && (source.snippet === undefined || typeof source.snippet === 'string' && source.snippet.length <= 1000)
      && (source.publishedAt === undefined || typeof source.publishedAt === 'string' && source.publishedAt.length <= 200)
      && (source.pageUpdatedAt === undefined || typeof source.pageUpdatedAt === 'string' && source.pageUpdatedAt.length <= 200);
  });
  if (entry.type === 'completed' && exactKeys('type', 'attemptId', 'timestamp', 'sources', 'usage',
    ...('summary' in entry ? ['summary'] : [])) && validSources && validUsage
    && (entry.summary === undefined || typeof entry.summary === 'string' && entry.summary.length <= 8000)) {
    return entry as LedgerEvent;
  }
  throw new WebSearchPersistenceError();
}

async function withLedger<T>(directory: string, callback: (entries: LedgerEvent[], append: (event: LedgerEvent) => Promise<void>) => Promise<T>): Promise<T> {
  const path = join(directory, 'search-attempts.jsonl');
  let handle: FileHandle | undefined;
  try {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new WebSearchPersistenceError();
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const noFollow = constants.O_NOFOLLOW ?? 0;
    handle = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | noFollow, 0o600);
    if (!(await handle.stat()).isFile()) throw new WebSearchPersistenceError();
    const raw = await handle.readFile('utf8');
    const lines = raw.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const entries = lines.map(line => {
      if (!line) throw new WebSearchPersistenceError();
      try { return validateLedgerLine(JSON.parse(line)); } catch { throw new WebSearchPersistenceError(); }
    });
    const attempts = new Map<string, boolean>();
    for (const event of entries) {
      const completed = attempts.get(event.attemptId);
      if (event.type === 'reserved') {
        if (completed !== undefined || attempts.has(event.attemptId)) throw new WebSearchPersistenceError();
        attempts.set(event.attemptId, false);
      } else {
        if (completed !== false) throw new WebSearchPersistenceError();
        attempts.set(event.attemptId, true);
      }
    }
    const append = async (event: LedgerEvent) => {
      if (event.type === 'reserved' ? attempts.has(event.attemptId) : attempts.get(event.attemptId) !== false) {
        throw new WebSearchPersistenceError();
      }
      try {
        await handle!.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
        await handle!.sync();
        entries.push(event);
        attempts.set(event.attemptId, event.type !== 'reserved');
      } catch { throw new WebSearchPersistenceError(); }
    };
    return await callback(entries, append);
  } catch (error) {
    if (error instanceof WebSearchPersistenceError || error instanceof WebSearchError || error instanceof DiagnosticPersistenceError) throw error;
    throw new WebSearchPersistenceError();
  } finally { await handle?.close().catch(() => {}); }
}

function checkedDateRange(range?: SearchDateRange): SearchDateRange | null {
  if (!range) return null;
  const result: SearchDateRange = {};
  for (const key of ['startDate', 'endDate'] as const) {
    const value = range[key];
    if (value === undefined) continue;
    const timestamp = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value) : NaN;
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
      throw new WebSearchError('搜索日期范围必须是有效的 YYYY-MM-DD 日期。');
    }
    result[key] = value;
  }
  if (result.startDate && result.endDate && result.startDate > result.endDate) {
    throw new WebSearchError('搜索开始日期不能晚于结束日期。');
  }
  return Object.keys(result).length ? result : null;
}

export async function searchDeepSeek(config: PaConfig, query: string, signal?: AbortSignal, fetcher: typeof fetch = fetch,
  dateRange?: SearchDateRange, diagnosticContext?: DiagnosticContext): Promise<WebSearchResult> {
  const search = (config as PaConfig & { search?: WebSearchConfig }).search;
  if (!search) throw new WebSearchError('网页搜索配置缺失。');
  validateConfig(search);
  const endpoint = config.provider === 'bailian' ? bailianSearchEndpoint(config.baseUrl) : ENDPOINT;
  if (!endpoint) throw new WebSearchError('百炼搜索地址无效；未发送请求或密钥。');
  if (!config.apiKey) throw new WebSearchError('DeepSeek API 密钥未配置。');
  if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new WebSearchError('网页搜索问题必须为 1 至 500 个字符。');
  const requestedDateRange = checkedDateRange(dateRange);
  if (signal?.aborted) throw new WebSearchError('网页搜索已取消。');

  let lock: Awaited<ReturnType<typeof acquireConversationLock>>;
  try { lock = await acquireConversationLock(config.dataDir, `web-search-budget:${search.budgetId}`); }
  catch (error) {
    if (error instanceof Error && (('code' in error && error.code === 'EEXIST') || error.message.startsWith('此会话已被锁定：'))) {
      throw new WebSearchError('网页搜索预算当前被其他请求占用。');
    }
    throw new WebSearchPersistenceError();
  }

  try {
    if (signal?.aborted) throw new WebSearchError('网页搜索已取消。');
    return await withLedger(lock.directory, async (entries, append) => {
      if (signal?.aborted) throw new WebSearchError('网页搜索已取消。');
      const reservations = entries.filter(entry => entry.type === 'reserved');
      if (search.maxUses > 0 && entries.some(entry => entry.type === 'completed' && entry.usage.serverSearches !== null
        && entry.usage.serverSearches > search.maxUses)) {
        throw new WebSearchError('服务端上次报告的搜索次数超过请求上限，此预算已暂停。');
      }
      if (search.maxRequests > 0 && reservations.length >= search.maxRequests) {
        throw new WebSearchError('网页搜索请求预算已用尽。');
      }
      const attemptId = randomUUID();
      await append({ type: 'reserved', attemptId, timestamp: new Date().toISOString(), query });
      const clock = requestTimeData();
      const body = {
        model: search.model, max_tokens: search.maxTokens,
        ...(config.provider === 'bailian' ? { thinking: { type: 'disabled' },
          system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_entrypoint=cli;' }] } : {}),
        messages: [{ role: 'user', content: [{ type: 'text', text:
          '[搜索时间环境｜由harness提供]\n' + JSON.stringify({ ...clock, requestedDateRange }) + '\n'
          + '以上日期范围按北京时间理解，是查询约束提示，不是搜索引擎已执行的过滤。将相对时间明确为日期；核对来源发布时间、页面更新时间和事件发生日期，三者不能混同。'
          + '优先与目标日期范围相关的原始来源，实时可用性应查当前状态页；没有日期证据或结果过时时明确说明，不能称为最新。\n'
          + outputLengthGuidance(search.maxTokens)
          + '只输出简短的最终检索结论，最多列出5条关键信息并保留对应来源与日期；不预告搜索步骤、不重复问题、不列冗长的检索过程。\n'
          + `Perform a web search for the query: ${query}` }] }],
        tools: [{ type: 'web_search_20250305', name: 'web_search',
          ...(search.maxUses > 0 ? { max_uses: search.maxUses } : {}) }],
      };
      await saveEvidence(lock.directory, attemptId, 'request', { endpoint, body }, config.apiKey);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      let diagnostics: DiagnosticLog | undefined;
      let callId: string | undefined;
      let phase = 'request';
      let httpStatus: number | undefined;
      try {
        if (signal?.aborted) throw new WebSearchError('网页搜索已取消。');
        diagnostics = new DiagnosticLog(config.dataDir, [config.apiKey]);
        const context = diagnosticContext ?? { traceId: attemptId };
        // This captures bounded parsed JSON, not raw HTTP bytes or request headers.
        callId = diagnostics.startCall({ ...context, kind: 'search', captureLevel: 'http-json',
          provider: config.provider === 'bailian' ? 'bailian' : 'deepseek', model: search.model, phase }, { endpoint, body }, { maxResults: search.maxResults });
        diagnostics.event(context, phase, 'search_reserved', { attemptId }, callId);
        if (signal?.aborted) throw new WebSearchError('网页搜索已取消。');
        timer = setTimeout(() => controller.abort(), search.timeoutMs);
        let response: Response;
        try {
          response = await fetcher(endpoint, {
            method: 'POST', redirect: 'error',
            headers: {
              'Content-Type': 'application/json', 'x-api-key': config.apiKey,
              Authorization: `Bearer ${config.apiKey}`, 'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (error) {
          if (error instanceof DiagnosticPersistenceError) throw error;
          throw new WebSearchError(signal?.aborted ? '网页搜索已取消。' : 'DeepSeek 网页搜索请求失败或超时。');
        }
        if (controller.signal.aborted) {
          throw new WebSearchError(signal?.aborted ? '网页搜索已取消。' : 'DeepSeek 网页搜索请求超时。');
        }
        if (!response.ok) {
          phase = 'http'; httpStatus = response.status;
          try {
            const errorResponse = await readBoundedBody(response);
            diagnostics.saveResponse(callId, errorResponse);
          } catch (error) {
            // Non-JSON and oversized error bodies stay bounded; retain the original HTTP failure.
            if (error instanceof DiagnosticPersistenceError) throw error;
          }
          throw new WebSearchError(`DeepSeek 网页搜索请求失败（HTTP ${response.status}）。`);
        }
        phase = 'response';
        const rawResponse = await readBoundedBody(response);
        diagnostics.saveResponse(callId, rawResponse);
        await saveEvidence(lock.directory, attemptId, 'response', rawResponse, config.apiKey);
        const safeResponse: unknown = JSON.parse(JSON.stringify(rawResponse).split(config.apiKey).join('[redacted]'));
        phase = 'parse';
        const parsed = parseSearchResponse(safeResponse, search.maxResults);
        if (controller.signal.aborted) {
          throw new WebSearchError(signal?.aborted ? '网页搜索已取消。' : 'DeepSeek 网页搜索请求超时。');
        }
        const result: WebSearchResult = { ...parsed, attemptId, freshness: {
          searchedAt: clock.currentTime, timeZone: clock.timeZone, requestedDateRange,
          dateFilterApplied: false, verification: 'unverified',
        } };
        phase = 'ledger';
        await append({ type: 'completed', attemptId, timestamp: new Date().toISOString(), sources: result.sources,
          usage: result.usage, ...(result.summary ? { summary: result.summary } : {}) });
        diagnostics.finishCall(callId, 'completed', 'completed');
        return result;
      } catch (error) {
        if (error instanceof DiagnosticPersistenceError) throw error;
        if (callId) diagnostics!.finishCall(callId, phase === 'request' ? 'unknown' : 'failed', phase,
          { failure: phase === 'request' ? 'search_request_failed' : phase === 'http' ? 'search_http_failed'
            : phase === 'parse' ? 'search_parse_failed' : phase === 'response' ? 'search_response_failed' : 'search_persistence_failed',
          ...(httpStatus === undefined ? {} : { httpStatus }) });
        if (error instanceof WebSearchPersistenceError) throw error;
        const safeReason = error instanceof WebSearchError ? error.message.slice(0, 200) : '网页搜索处理失败。';
        await append({ type: 'failed', attemptId, timestamp: new Date().toISOString(), reason: safeReason });
        if (error instanceof WebSearchError) throw error;
        throw new WebSearchError('DeepSeek 网页搜索处理失败。');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    });
  } finally { await lock.release(); }
}

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PaConfig } from './config.js';
import type { ChannelRoute, DeliveryResult, OutboundMessage } from './channel-types.js';
import { ConversationStore } from './store.js';
import { openConversation, RequestError, type ConversationRuntime } from './runtime.js';
import { MemoryError } from './memory-types.js';
import { normalizeWebFetchUrl } from './web-fetch.js';
import type { ResearchToolContext, ResearchToolName, ResearchRuntimeEvent } from './research-tools.js';
import type { CreateResearchInput, ResearchListParams, ResearchReadParams, ResearchTask, ResearchFinishInput } from './research-types.js';

export type ResearchSender = (message: Pick<OutboundMessage, 'text' | 'file'>) => Promise<DeliveryResult>;
const routeKey = (route: ChannelRoute) => JSON.stringify([route.channel, route.accountId, route.roomType, route.roomId]);
const boundedText = (text: string, bytes: number) => Buffer.byteLength(text, 'utf8') <= bytes ? text
  : Buffer.from(text, 'utf8').subarray(0, bytes).toString('utf8').replace(/\ufffd$/u, '') + '\n[此材料片段已截断]';
const publicTask = (task: ResearchTask) => ({ id: task.id, title: task.title, status: task.status, attempt: task.attempt,
  reportVersion: task.reportVersion, createdAt: task.createdAt });

/** One worker per harness. Research state and paid-call markers outlive the Pi loop. */
export class ResearchService {
  private store: ConversationStore | undefined;
  private allowed: Set<string>;
  private closed = false;
  private active: Promise<void> | undefined;
  private runtime: ConversationRuntime | undefined;
  private fatal?: unknown;
  private activeTask: string | undefined;
  constructor(private readonly config: PaConfig, routes: readonly ChannelRoute[],
    private readonly send: (message: OutboundMessage) => Promise<DeliveryResult>, private readonly onError: () => void) {
    this.allowed = new Set(routes.map(routeKey));
  }

  start(): void {
    if (this.closed || this.store) return;
    this.store = new ConversationStore(join(this.config.dataDir, 'pa.sqlite'));
    this.store.research.recover();
    this.wake();
  }
  info() { return { running: this.activeTask, failed: Boolean(this.fatal) }; }
  context(conversationId: string, sourceMessageId: string, send?: ResearchSender): ResearchToolContext {
    return { execute: (name, params) => this.execute(conversationId, sourceMessageId, name, params, send) };
  }
  private async execute(conversationId: string, sourceMessageId: string, name: ResearchToolName, params: unknown,
    send?: ResearchSender): Promise<unknown> {
    if (this.closed || this.fatal || !this.store) throw new MemoryError('研究服务尚未就绪或已停止。');
    const store = this.store.research;
    switch (name) {
      case 'create_research': {
        const task = store.create(conversationId, sourceMessageId, params as CreateResearchInput);
        this.wake();
        return { ...publicTask(task), saved: true };
      }
      case 'list_research': return store.list(conversationId, sourceMessageId, params as ResearchListParams);
      case 'read_research': return store.read(conversationId, sourceMessageId, params as ResearchReadParams);
      case 'continue_research': {
        const task = store.retry(conversationId, sourceMessageId, params as { id: string; key: string });
        this.wake();
        return { ...publicTask(task), saved: true };
      }
      case 'send_research_report': {
        const input = params as { id: string; version?: number; format?: 'txt' | 'md' };
        const receipt = store.reserveDelivery(conversationId, sourceMessageId, { ...input, format: input.format ?? 'txt' });
        if (!receipt.shouldSend) return { id: receipt.reportId, version: receipt.version, status: receipt.status, repeated: true };
        let result: DeliveryResult;
        try {
          result = this.closed ? { status: 'rejected' } : await (send
            ? send({ text: receipt.text!, file: receipt.file! })
            : this.send({ route: receipt.route, deliveryMode: 'active', text: receipt.text!, file: receipt.file! }));
        } catch { result = { status: 'uncertain' }; }
        store.finishDelivery(receipt.deliveryId, result.status, result.status === 'sent' ? result.externalMessageId : undefined,
          result.status === 'sent' ? result.referenceIndex : undefined);
        return { id: receipt.reportId, version: receipt.version, status: result.status };
      }
    }
  }

  private wake(): void {
    if (this.closed || this.active || this.fatal || !this.store) return;
    this.active = Promise.resolve().then(async () => {
      while (!this.closed) {
        const notification = this.store!.research.pendingNotifications().find(task => this.allowed.has(routeKey(task.route)));
        if (notification) { await this.notify(notification); continue; }
        const next = this.store!.research.queued().find(task => this.allowed.has(routeKey(task.route)));
        if (!next) break;
        const budget = this.config.research!;
        const task = this.store!.research.claim(next.id, budget);
        if (task) await this.run(task);
      }
    }).catch(error => { this.fatal = error; this.onError(); }).finally(() => { this.active = undefined; this.activeTask = undefined; });
  }
  async wait(): Promise<void> { while (this.active) await this.active; }
  async abort(): Promise<void> {
    this.closed = true;
    await this.runtime?.abort();
    await this.wait();
  }
  async close(): Promise<void> {
    await this.abort();
    this.store?.close(); this.store = undefined;
  }

  private async run(task: ResearchTask): Promise<void> {
    this.activeTask = task.id;
    const store = this.store!.research;
    const budget = this.config.research!;
    let current = { modelCalls: 0, toolCalls: 0, searchCalls: 0 };
    let persistenceFailed = false;
    const record = (event: ResearchRuntimeEvent) => {
      current = { modelCalls: event.modelCalls, toolCalls: event.toolCalls, searchCalls: event.searchCalls };
      try { store.checkpoint(task.id, task.attempt, { ...current,
        ...(event.tool ? { evidence: { tool: event.tool, input: event.input, result: event.result,
          ...(event.error ? { error: event.error } : {}) } } : {}) }); }
      catch (error) { persistenceFailed = !(error instanceof MemoryError); throw error; }
    };
    // Resume only confirmed material, never replay a partially completed paid call.
    const prior = task.evidence.filter(e => e.result !== undefined && e.tool !== 'report_draft').slice(-24);
    const materialBytes = Math.max(1024, Math.min(60_000, Math.floor((this.config.contextWindow - this.config.maxOutputTokens - 16_000) / 3)));
    const previousMaterial = boundedText(JSON.stringify(prior), materialBytes);
    const input = JSON.stringify({ task: { id: task.id, title: task.title, goal: task.goal,
      originalRequest: task.originalText, urls: task.urls, requiresOriginal: task.requiresOriginal },
      researchedAt: new Date().toISOString(), previousMaterial, budget,
      ...(task.reportVersion ? { previousReport: boundedText(store.report(task.id, task.reportVersion).markdown, materialBytes) } : {}) });
    let finished: ResearchTask;
    try {
      this.runtime = await openConversation({ ...this.config,
        loop: { maxModelCalls: budget.maxModelCalls, maxToolCalls: budget.maxToolCalls } },
      `research:${task.id}:${task.attempt}`, { enableSearch: true, research: { maxSearchCalls: budget.maxSearchCalls, record } });
      if (this.closed) throw new RequestError('研究服务正在关闭。', 'cancelled');
      const output = await this.runtime.prompt(input, { runId: randomUUID(), taskId: task.id, conversationId: task.conversationId });
      // Keep the actual final output even when the model fails the report contract.
      try { store.checkpoint(task.id, task.attempt, { ...current,
        evidence: { tool: 'report_draft', input: { attempt: task.attempt }, result: boundedText(output, 90_000) } }); }
      catch (error) { persistenceFailed = !(error instanceof MemoryError); throw error; }
      const report = parseReport(output);
      const allEvidence = store.get(task.id)!.evidence;
      const pages = allEvidence.filter(e => e.tool === 'web_fetch' && e.result && typeof e.result === 'object'
        && 'url' in e.result && 'text' in e.result).map(e => e.result as { url: string; coverage?: Coverage });
      const hasSearchEvidence = allEvidence.some(e => e.tool === 'web_search' && e.result && typeof e.result === 'object'
        && (('summary' in e.result && typeof e.result.summary === 'string' && e.result.summary.trim())
          || ('sources' in e.result && Array.isArray(e.result.sources) && e.result.sources.length > 0)));
      if (task.requiresOriginal && (!task.urls.length || task.urls.some(url => !fullyRead(pages, normalizeWebFetchUrl(url))))) {
        report.status = 'blocked'; report.reason = '指定原始资料尚未完整读取；已保留研究材料，请补充正文或明确要求重试。';
      } else if (!pages.length && !hasSearchEvidence) {
        report.status = 'blocked'; report.reason = '尚未取得可用的联网资料；已保留研究进度，请检查联网配置、补充资料或明确要求重试。';
      } else if (report.status === 'completed' && !pages.length) {
        report.status = 'partial'; report.reason = '尚未读取可核验的原始网页，仅保留阶段性结论。';
      }
      if (report.status === 'blocked') { delete report.markdown; delete report.abstract; delete report.keywords; }
      try { finished = store.finish(task.id, task.attempt, report); }
      catch (error) { persistenceFailed = !(error instanceof MemoryError); throw error; }
    } catch (error) {
      if (persistenceFailed) throw error;
      // Provider errors, invalid final JSON and interruption preserve all confirmed evidence.
      finished = store.finish(task.id, task.attempt, { status: this.closed ? 'interrupted' : 'failed',
        reason: this.closed ? '服务停止，执行已中断；不会自动重复模型调用。'
          : error instanceof ReportFormatError || error instanceof MemoryError ? error.message : '研究调用未成功完成；已有资料和调用记录已保留，需明确要求继续。' });
    } finally {
      const runtime = this.runtime; this.runtime = undefined;
      await runtime?.close();
    }
    if (!this.closed) await this.notify(finished);
  }

  private async notify(task: ResearchTask): Promise<void> {
    const state = { completed: '已完成', partial: '已有阶段性报告', blocked: '暂时受阻', failed: '执行失败', interrupted: '执行中断', running: '执行中', queued: '排队中' }[task.status];
    const text = `研究 ${task.id}「${task.title}」${state}。${task.status === 'completed' || task.status === 'partial'
      ? `报告 v${task.reportVersion} 已保存，需要时可以让我发送文件。` : task.reason ?? '可查询清单或明确要求继续。'}`;
    const receipt = this.store!.research.reserveNotification(task.id, task.attempt, text);
    if (!receipt.shouldSend) return;
    let result: DeliveryResult;
    try { result = await this.send({ route: task.route, deliveryMode: 'active', text, plainText: true }); }
    catch { result = { status: 'uncertain' }; }
    this.store!.research.finishDelivery(receipt.deliveryId, result.status,
      result.status === 'sent' ? result.externalMessageId : undefined, result.status === 'sent' ? result.referenceIndex : undefined);
  }
}

interface Coverage { offset: number; end: number; totalChars: number; contentHash: string }
function fullyRead(pages: { url: string; coverage?: Coverage }[], url: string): boolean {
  const ranges = pages.filter(page => page.url === url && page.coverage).map(page => page.coverage!);
  // A source can change between attempts: only merge ranges from identical text.
  for (const hash of new Set(ranges.map(range => range.contentHash))) {
    const document = ranges.filter(range => range.contentHash === hash);
    const total = document[0]!.totalChars;
    let covered = 0;
    for (const range of document.sort((a, b) => a.offset - b.offset)) {
      if (range.offset > covered) break;
      covered = Math.max(covered, range.end);
    }
    if (total > 0 && covered >= total) return true;
  }
  return false;
}

class ReportFormatError extends Error {}
function parseReport(raw: string): ResearchFinishInput {
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1')); }
  catch { throw new ReportFormatError('模型未返回可归档的报告结构；草稿已保留，可明确要求继续。'); }
  if (!value || !['completed', 'partial', 'blocked'].includes(String(value.status))
    || typeof value.abstract !== 'string' || !value.abstract.trim() || [...value.abstract].length > 1200
    || typeof value.markdown !== 'string' || !value.markdown.trim() || Buffer.byteLength(value.markdown) > 500_000 || [...value.markdown].length > 200_000
    || typeof value.reason !== 'string' || value.reason.length > 2000
    || !Array.isArray(value.keywords) || value.keywords.length > 20
    || value.keywords.some(k => typeof k !== 'string' || !k.trim() || [...k].length > 60)) {
    throw new ReportFormatError('报告结构或容量不符合约定；草稿已保留，可明确要求继续。');
  }
  return { status: value.status as 'completed' | 'partial' | 'blocked', markdown: value.markdown,
    abstract: value.abstract, keywords: value.keywords as string[], ...(value.reason.trim() ? { reason: value.reason } : {}) };
}

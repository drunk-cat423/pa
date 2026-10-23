import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PaConfig } from './config.js';
import type { ChannelRoute, DeliveryResult, OutboundMessage } from './channel-types.js';
import { ConversationStore } from './store.js';
import { openConversation, RequestError, type ConversationRuntime } from './runtime.js';
import { MemoryError } from './memory-types.js';
import { normalizeWebFetchUrl } from './web-fetch.js';
import { WebFetchReader } from './web-fetch-reader.js';
import type { ResearchToolContext, ResearchToolName, ResearchRuntimeEvent } from './research-tools.js';
import type { ContinueResearchInput, CreateResearchInput, ResearchListParams, ResearchReadParams, ResearchTask } from './research-types.js';
import { toPlainText } from './plain-text.js';
import { assembleResearchReport, hasFetchedSource, isResearchSourceMaterial, lightweightResearchPlan, parseResearchPlan, parseResearchReview, parseResearchSection, researchSources, researchStagePrompt } from './research-workflow.js';
import type { ResearchPhase, ResearchSection } from './research-workflow-types.js';

export type ResearchSender = (message: Pick<OutboundMessage, 'text' | 'file'>) => Promise<DeliveryResult>;
const routeKey = (route: ChannelRoute) => JSON.stringify([route.channel, route.accountId, route.roomType, route.roomId]);
const boundedText = (text: string, bytes: number) => Buffer.byteLength(text, 'utf8') <= bytes ? text
  : Buffer.from(text, 'utf8').subarray(0, bytes).toString('utf8').replace(/\ufffd$/u, '') + '\n[此材料片段已截断]';
const publicTask = (task: ResearchTask) => ({ id: task.id, title: task.title, status: task.status, attempt: task.attempt,
  reportVersion: task.reportVersion, createdAt: task.createdAt });
const shortPlain = (value: string, limit: number) => {
  const points = [...toPlainText(value).replace(/\s+/gu,' ').trim()];
  return points.length <= limit ? points.join('') : points.slice(0,limit-1).join('') + '…';
};

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
  /** Local operator entry: claim exactly one pre-authorized queued attempt.
   * No queue pump, memory worker, notification or automatic network retry. */
  async runOnce(id: string, expectedAttempt: number): Promise<ResearchTask> {
    if (this.closed || this.store || this.active) throw new MemoryError('单任务研究必须使用独立且未启动的服务实例。');
    this.store = new ConversationStore(join(this.config.dataDir, 'pa.sqlite'));
    const task = this.store.research.get(id);
    if (!task || task.status !== 'queued' || task.attempt !== expectedAttempt || !this.allowed.has(routeKey(task.route))) {
      throw new MemoryError('单任务研究的编号、批次、状态或允许场景不匹配。');
    }
    const claimed = this.store.research.claim(id, this.config.research!, expectedAttempt);
    if (!claimed) throw new MemoryError('指定研究批次未能领取，不重试。');
    this.active = this.run(claimed, { notify: false, retryNetwork: false });
    try { await this.active; return this.store.research.get(id)!; }
    finally { this.active = undefined; this.activeTask = undefined; }
  }
  info() { return { running: this.activeTask, failed: Boolean(this.fatal) }; }
  context(conversationId: string, sourceMessageId: string, send?: ResearchSender): ResearchToolContext {
    return { ...(this.store ? { target: this.store.research.targetContext(conversationId, sourceMessageId) } : {}),
      execute: (name, params) => this.execute(conversationId, sourceMessageId, name, params, send) };
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
      case 'archive_research': {
        const { id } = params as { id: string };
        const result = store.archive(conversationId, sourceMessageId, { ids: [id], reason: '用户通过聊天要求从研究清单移除任务。' });
        return { ...result, archived: true, materialsRetained: true, reportsRetained: true };
      }
      case 'continue_research': {
        const task = store.retry(conversationId, sourceMessageId, params as ContinueResearchInput);
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

  private async run(task: ResearchTask, options = { notify: true, retryNetwork: true }): Promise<void> {
    this.activeTask = task.id;
    const store = this.store!.research;
    const budget = this.config.research!;
    let current = { modelCalls: 0, toolCalls: 0, searchCalls: 0 };
    let persistenceFailed = false;
    let activeCycle: number | undefined;
    const persist = <T>(operation: () => T): T => {
      try { return operation(); } catch (error) { persistenceFailed = !(error instanceof MemoryError); throw error; }
    };
    const blockedThisAttempt = new Set<string>();
    // One cache and total read budget per attempt, surviving individual Pi cycles.
    const fetchReader = this.config.fetch?.enabled ? new WebFetchReader(this.config.fetch, {
      maxResultBytes: 16_000, maxReads: budget.maxToolCalls, maxTotalBytes: 16_000 * budget.maxToolCalls,
      ...(options.retryNetwork ? { maxNetworkAttempts: 2 as const } : {}), onNetworkAttempt: (url, attempt) => persist(() => store.checkpoint(task.id, task.attempt,
        { ...current, evidence: { tool: 'web_fetch_network', input: { url, attempt } } })),
    }) : undefined;
    let finished: ResearchTask;
    try {
      // New tasks need no paid chapter-planning call. The persisted protocol is
      // fixed once; existing v1 plans and their reviews are never rewritten.
      if (!persist(() => store.workflow.load(task.id)).plan) {
        const cycle = persist(() => store.workflow.begin(task.id, task.attempt, { phase: 'plan',
          input: { origin: 'program', protocol: 2, goal: task.goal, originalRequest: task.originalText } }));
        activeCycle = cycle;
        persist(() => store.workflow.savePlan(task.id, task.attempt, cycle, lightweightResearchPlan()));
        activeCycle = undefined;
      }
      while (current.modelCalls < budget.maxModelCalls) {
        if (this.closed) throw new RequestError('研究服务正在关闭。', 'cancelled');
        const workflow = persist(() => store.workflow.load(task.id));
        const lightweight = workflow.plan?.version === 2;
        if (workflow.plan && workflow.sections.every(section => section.status === 'approved')) break;
        // Review a newly written chapter before spending on the next one. Blocked chapters
        // are revisited only by a new, explicitly requested attempt, never in a busy loop.
        const section = workflow.collected ? workflow.sections.find(item => item.status === 'written')
          ?? workflow.sections.find(item => item.status !== 'approved' && !blockedThisAttempt.has(item.id)) : undefined;
        if (workflow.plan && workflow.collected && !section) break;
        const phase: ResearchPhase = !workflow.plan ? 'plan' : !workflow.collected ? 'collect' : !lightweight && section!.status === 'written' ? 'review' : 'write';
        // Do not spend the last available call gathering material with no room
        // left to answer. A saved checkpoint remains available for continuation.
        if (lightweight && phase === 'collect' && budget.maxModelCalls - current.modelCalls < 2) break;
        const saved = persist(() => store.get(task.id)!);
        const material = saved.evidence.map((evidence, index) => ({ id: `e${index + 1}`, ...evidence }))
          .filter(evidence => ['web_fetch', 'web_search', ...(lightweight ? ['read_research_material'] : [])].includes(evidence.tool)
            && (!lightweight || evidence.result !== undefined || evidence.error !== undefined));
        const previousMaterial = lightweight ? lightweightMaterials(material) : boundedText(JSON.stringify(material.slice(-24).map(item => ({ ...item,
          result: item.result === undefined ? undefined : boundedText(JSON.stringify(item.result), phase === 'write' ? 24_000 : 4500) }))), phase === 'write' ? 120_000 : 45_000);
        const reviewCoverage = new Map<string, { total: number; ranges: [number, number][] }>();
        const reviewSources = new Set<string>();
        let reviewBytes = 60_000;
        const reviewMaterial = phase !== 'review' ? [] : material.filter(item => isResearchSourceMaterial(item, section!.sources)).map(item => {
          const evidence = saved.evidence[Number(item.id.slice(1)) - 1]!;
          for (const url of researchSources([evidence])) reviewSources.add(url);
          const encoded = JSON.stringify(evidence), points = [...encoded];
          const end = Buffer.byteLength(encoded) <= reviewBytes ? points.length : Math.min(points.length, Math.floor(reviewBytes / 4));
          const text = points.slice(0, end).join('');
          reviewBytes -= Buffer.byteLength(text);
          reviewCoverage.set(item.id, { total: points.length, ranges: end ? [[0, end]] : [] });
          return { id: item.id, text, totalChars: points.length, hasMore: end < points.length,
            ...(end < points.length ? { nextOffset: end } : {}) };
        });
        const input = { task: { id: task.id, title: task.title, goal: task.goal, originalRequest: task.originalText,
          followups: task.followups,
          urls: task.urls, requiresOriginal: task.requiresOriginal }, phase, researchedAt: new Date().toISOString(),
          remainingGaps: workflow.sections.flatMap(item=>item.gaps),
          previousMaterial: phase === 'review' ? undefined : previousMaterial,
          ...(lightweight ? { collectionNote: boundedText(String(saved.evidence.findLast(item => item.tool === 'collection_note')?.result ?? ''), 8000) } : {}),
          ...(phase === 'review' ? { reviewMaterial } : {}),
          materialIndex: material.slice(lightweight ? -24 : -64).map(item => ({ id: item.id, tool: item.tool,
            input: lightweight ? boundedText(JSON.stringify(item.input), 1000) : item.input, error: item.error })),
          plan: workflow.plan, progress: workflow.sections.map(({ id, title, status, summary }) => ({ id, title, status, summary })),
          ...(section ? { section: phase === 'review' ? section : sectionProjection(section),
            writeMode: section.status === 'draft' ? 'append' : 'replace' } : {}),
          budget: { modelCalls: budget.maxModelCalls - current.modelCalls, toolCalls: budget.maxToolCalls - current.toolCalls,
            searchCalls: budget.maxSearchCalls - current.searchCalls,
            suggestedSections: Math.max(1, Math.min(3, Math.floor((budget.maxModelCalls - 3) / 2))) },
          ...(!workflow.plan && task.reportVersion ? { previousReport: boundedText(store.report(task.id, task.reportVersion).markdown, 12_000) } : {}) };
        const cycle = persist(() => store.workflow.begin(task.id, task.attempt, { phase, input,
          ...(section ? { sectionId: section.id, expectedVersion: section.version } : {}) }));
        activeCycle = cycle;
        const base = { ...current };
        const record = (event: ResearchRuntimeEvent) => {
          current = { modelCalls: base.modelCalls + event.modelCalls, toolCalls: base.toolCalls + event.toolCalls,
            searchCalls: base.searchCalls + event.searchCalls };
          persist(() => store.checkpoint(task.id, task.attempt, { ...current,
            ...(event.tool ? { evidence: { tool: event.tool, input: event.input, result: event.result,
              ...(event.error ? { error: event.error } : {}) } } : {}) }));
        };
        let stopReason = 'unknown';
        const remaining = budget.maxModelCalls - current.modelCalls;
        // Collection stops after successful tool execution at its own boundary.
        // Writing starts a clean, tool-free session and never inherits that loop.
        const modelCalls = phase === 'collect' ? lightweight ? Math.min(6, remaining - 1)
          : Math.min(8, Math.max(1, remaining - workflow.sections.filter(item => item.status !== 'approved').length * 2))
          : phase === 'review' ? Math.min(4, remaining) : 1;
        try {
          this.runtime = await openConversation({ ...this.config, loop: { maxModelCalls: modelCalls, maxToolCalls: budget.maxToolCalls } },
            `research:${task.id}:${task.attempt}:cycle:${cycle}`, { enableSearch: true, research: {
              phase, systemPrompt: researchStagePrompt(phase, lightweight), maxToolCalls: phase === 'write' || phase === 'plan' ? 0 : budget.maxToolCalls - current.toolCalls,
              maxSearchCalls: budget.maxSearchCalls - current.searchCalls, record,
              ...(fetchReader ? { fetchReader } : {}),
              readMaterial: params => {
                if (!/^e[1-9][0-9]*$/u.test(params.id)) throw new MemoryError('材料编号无效。');
                const evidence = store.get(task.id)!.evidence[Number(params.id.slice(1)) - 1];
                if (!evidence || !['web_fetch', 'web_search'].includes(evidence.tool)) throw new MemoryError('该材料不属于当前任务的联网资料。');
                const text = JSON.stringify(evidence), points = [...text], offset = params.offset ?? 0;
                if (!Number.isSafeInteger(offset) || offset < 0 || offset > points.length) throw new MemoryError('材料读取位置无效。');
                const end = Math.min(points.length, offset + 2800);
                reviewCoverage.get(params.id)?.ranges.push([offset, end]);
                return { id: params.id, text: points.slice(offset, end).join(''), offset, totalChars: points.length,
                  ...(end < points.length ? { nextOffset: end } : {}) };
              }, onFinalResponse: response => { stopReason = response.stopReason; },
            } });
          if (this.closed) throw new RequestError('研究服务正在关闭。', 'cancelled');
          const output = await this.runtime.prompt(JSON.stringify(input), { runId: randomUUID(), taskId: task.id, conversationId: task.conversationId });
          persist(() => store.checkpoint(task.id, task.attempt, { ...current, evidence: { tool: phase === 'collect' ? 'collection_note' : 'report_draft',
            input: { attempt: task.attempt, cycle, phase, sectionId: section?.id, stopReason,
              truncated: stopReason === 'length', storedExcerpt: Buffer.byteLength(output) > 90_000 }, result: boundedText(output, 90_000) } }));
          if (phase === 'plan') persist(() => store.workflow.savePlan(task.id, task.attempt, cycle, parseResearchPlan(output, stopReason)));
          else if (phase === 'collect') persist(() => store.workflow.saveCollection(task.id, task.attempt, cycle,
            { reason: current.modelCalls - base.modelCalls >= modelCalls || current.toolCalls >= budget.maxToolCalls ? 'budget' : 'complete',
              note: [...output].slice(0, 4000).join('') }));
          else if (phase === 'write') {
            const proposal = parseResearchSection(output, stopReason, section!, store.get(task.id)!.evidence);
            persist(() => store.workflow.saveSection(task.id, task.attempt, cycle, proposal));
            if (proposal.status === 'blocked') blockedThisAttempt.add(section!.id);
            // One answer, not a review/rewrite loop. Only an actual incomplete
            // draft can continue automatically within the remaining budget.
            if (lightweight && proposal.status !== 'draft') { activeCycle = undefined; break; }
          } else {
            const review = parseResearchReview(output, stopReason, section!);
            const evidence = store.get(task.id)!.evidence;
            const originalPages = fetchedPages(evidence);
            if (review.verdict === 'pass' && (section!.sources.some(url => !reviewSources.has(url))
              || [...reviewCoverage.values()].some(value => !rangesCover(value.ranges, value.total)))) {
              review.verdict = 'blocked'; review.reason = '本章所引资料的后半部分尚未进入本次审查上下文，不能仅审查摘录开头即通过。';
            } else if (review.verdict === 'pass' && task.requiresOriginal
              && (!task.urls.length || task.urls.some(url => !fullyRead(originalPages, normalizeWebFetchUrl(url))))) {
              review.verdict = 'blocked'; review.reason = '指定原始资料尚未完整读取；保留章节，补充原文后才可继续核验。';
            } else if (review.verdict === 'pass' && !hasFetchedSource(section!, evidence)) {
              review.verdict = 'blocked'; review.reason = '本章尚无实际读取的网页来源，不能仅凭模型审查通过完成归档。';
            }
            persist(() => store.workflow.saveReview(task.id, task.attempt, cycle, review));
            if (review.verdict === 'blocked') blockedThisAttempt.add(section!.id);
          }
          activeCycle = undefined;
        } finally {
          const runtime = this.runtime; this.runtime = undefined;
          await runtime?.close();
        }
      }
      if (this.closed) throw new RequestError('研究服务正在关闭。', 'cancelled');
      const workflow = persist(() => store.workflow.load(task.id));
      const lightweight = workflow.plan?.version === 2;
      const allEvidence = store.get(task.id)!.evidence;
      const pages = fetchedPages(allEvidence);
      const hasSearchEvidence = allEvidence.some(e => e.tool === 'web_search' && e.result && typeof e.result === 'object'
        && (('summary' in e.result && typeof e.result.summary === 'string' && e.result.summary.trim())
          || ('sources' in e.result && Array.isArray(e.result.sources) && e.result.sources.length > 0)));
      const originalMissing = task.requiresOriginal && (!task.urls.length || task.urls.some(url => !fullyRead(pages, normalizeWebFetchUrl(url))));
      const done = Boolean(workflow.plan) && workflow.sections.every(section => lightweight
        ? section.status === 'written' && section.gaps.length === 0 && section.sources.length > 0
        : section.status === 'approved');
      const reason = originalMissing ? '指定原始资料尚未完整读取；章节、材料和检查点已保存，需补充资料或明确要求继续。'
        : !pages.length && !hasSearchEvidence ? '尚未取得可用的联网资料；已保留研究进度，需补充资料或明确要求继续。'
        : lightweight ? (current.modelCalls >= budget.maxModelCalls || budget.maxModelCalls - current.modelCalls < 2
          ? '本批预算不足以继续完成答复；材料和正文已保存，需明确要求继续。'
          : '答复尚有核心问题缺少依据或有效来源；已有内容已保存，需补充资料或明确要求继续。')
        : current.modelCalls >= budget.maxModelCalls ? '本批模型调用预算用完，尚有章节未完成或未通过审查；已保存检查点，需明确要求继续。'
        : '尚有章节因证据不足未通过审查；已保存检查点，需补充资料或明确要求继续。';
      const hasText = workflow.sections.some(section => section.markdown.trim());
      const report = !originalMissing && (pages.length || hasSearchEvidence) && hasText
        ? assembleResearchReport(task, workflow, done ? 'completed' : 'partial', done ? undefined : reason)
        : { status: 'blocked' as const, reason };
      finished = persist(() => store.finish(task.id, task.attempt, report));
    } catch (error) {
      if (persistenceFailed) throw error;
      if (activeCycle !== undefined) persist(() => store.workflow.failCycle(task.id, task.attempt, activeCycle!,
        error instanceof MemoryError ? error.message : '调用未确认成功；不自动重复，需检查原始诊断。', !(error instanceof MemoryError)));
      // Unknown provider outcomes and invalid contracts stop this attempt, not a paid retry.
      finished = store.finish(task.id, task.attempt, { status: this.closed ? 'interrupted' : 'failed',
        reason: this.closed ? '服务停止，执行已中断；不会自动重复模型调用。'
          : error instanceof MemoryError ? error.message : '研究调用未成功完成；已有资料和调用记录已保留，需明确要求继续。' });
    } finally {
      fetchReader?.dispose();
    }
    if (!this.closed && options.notify) await this.notify(finished);
  }

  private async notify(task: ResearchTask): Promise<void> {
    if (this.store!.research.notificationObsolete(task.id,task.attempt)) return;
    try { await this.notifyCurrent(task); }
    catch (error) {
      // Expiry or an explicit continuation can race the notification snapshot.
      // Only these known obsolete states may suppress a notification failure.
      if (error instanceof MemoryError && this.store!.research.notificationObsolete(task.id,task.attempt)) return;
      throw error;
    }
  }

  private async notifyCurrent(task: ResearchTask): Promise<void> {
    const state = { completed: '已完成', partial: '已有阶段性报告', blocked: '暂时受阻', failed: '执行失败', interrupted: '执行中断', running: '执行中', queued: '排队中' }[task.status];
    let text = `研究 ${task.id}「${shortPlain(task.title,60)}」${state}。`;
    if (task.status === 'completed' || task.status === 'partial') {
      // Summarize the persisted report, not a new independent research/chat call.
      const report = this.store!.research.report(task.id,task.reportVersion!);
      text += `\n报告 v${report.version} 摘要：${shortPlain(report.abstract,240)}`;
      if (task.status === 'partial') {
        const gaps = this.store!.research.workflow.load(task.id).sections.flatMap(section=>section.gaps).join('；');
        text += `\n待补充：${shortPlain(gaps || task.reason || '关键问题仍待核实。',90)}`;
      }
      text += '\n完整报告已保存，需要时可发送文件。';
    } else text += shortPlain(task.reason ?? '可查询清单或明确要求继续。',260);
    const receipt = this.store!.research.reserveNotification(task.id, task.attempt, text);
    if (!receipt.shouldSend) return;
    let result: DeliveryResult;
    try { result = await this.send({ route: receipt.route, deliveryMode: 'active', text, plainText: true }); }
    catch { result = { status: 'uncertain' }; }
    this.store!.research.finishDelivery(receipt.deliveryId, result.status,
      result.status === 'sent' ? result.externalMessageId : undefined, result.status === 'sent' ? result.referenceIndex : undefined);
  }
}

function sectionProjection(section: ResearchSection): ResearchSection & { markdownIsTail: boolean } {
  const tail = section.status === 'draft' && [...section.markdown].length > 8000;
  return { ...section, markdown: tail ? [...section.markdown].slice(-8000).join('') : section.markdown, markdownIsTail: tail };
}

/** Small, explicitly partial projections; originals and read cursors stay in evidence. */
function lightweightMaterials(material: (ResearchTask['evidence'][number] & { id: string })[]) {
  const entries: { id: string; tool: string; sources: string[]; excerpt: string; truncated: boolean }[] = [];
  let bytes = 0;
  for (const item of material.slice(-16).reverse()) {
    const original = JSON.stringify(item);
    const excerpt = boundedText(original, 6000);
    const entry = { id: item.id, tool: item.tool, sources: [...researchSources([item])].slice(0, 5), excerpt, truncated: excerpt !== original };
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (bytes + size > 40_000) continue;
    bytes += size; entries.unshift(entry);
  }
  return { entries, omittedRecords: material.length - entries.length,
    notice: '这里只是有界材料片段，截断或省略不表示相关内容已被核验。需要补读时在采集阶段按材料编号读取。' };
}

interface Coverage { offset: number; end: number; totalChars: number; contentHash: string }
function rangesCover(ranges: [number, number][], total: number): boolean {
  let end = 0;
  for (const range of [...ranges].sort((a, b) => a[0] - b[0])) { if (range[0] > end) return false; end = Math.max(end, range[1]); }
  return end >= total;
}
function fetchedPages(evidence: ResearchTask['evidence']): { url: string; coverage?: Coverage }[] {
  return evidence.filter(e => e.tool === 'web_fetch' && !e.error && e.result && typeof e.result === 'object'
    && 'url' in e.result && typeof e.result.url === 'string' && 'text' in e.result
    && typeof e.result.text === 'string' && e.result.text.trim()).map(e => e.result as { url: string; coverage?: Coverage });
}
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

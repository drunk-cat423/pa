import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PaConfig } from '../config.js';
import type { ChannelRoute, DeliveryResult, InboundMessage, OutboundMessage } from '../channel-types.js';
import type { CodexToolContext, CodexToolName } from '../codex-tools.js';
import { codexOwnerKey } from '../codex-service.js';
import type { HarnessPolicy } from '../harness-policy.js';
import { MemoryError } from '../memory-types.js';
import { TaskDeliveryStore } from './delivery-store.js';
import { TaskDeliveryWorker, type ChannelDeliveryPart } from './delivery.js';
import { createTaskExecutionHost, TASK_TEXT_CAPABILITY, TASK_TEXT_RESULT_FORMAT, type TaskTextGenerator } from './execution-host.js';
import { TaskCoordinatorError, TaskCoordinatorStore, type TaskReceipt } from './store.js';

type Binding = HarnessPolicy['ownerBindings'][number];
type LegacyStatus = (id?: string) => Promise<string>;
type QueueOutput = (operation: () => Promise<boolean>) => Promise<boolean>;

const databaseName = 'task-coordinator.sqlite';
const taskCommand = /^\/task(?:\s+([\s\S]*))?$/u;
const taskIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sourceKeyPattern = /^qq-task:[a-f0-9]{64}$/;
const explicitDispatch = /后台|委派|派给|交给|开(?:个|一项|\s*个)?任务|建(?:个|一项|\s*个)?任务/u;
const state = {
  queued: '排队中', waiting_input: '等待补充材料', waiting_dependency: '等待前置任务',
  running: '正在处理', reconciling: '正在核对执行结果', closed: '已结案',
  succeeded: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消',
  timed_out: '已超期', dependency_failed: '前置任务未完成', outcome_unknown: '结果未确认',
  pending: '待发送', sending: '发送中', sent: '已送达', rejected: '发送失败', unknown: '送达未确认',
};

function label(value: string): string { return state[value as keyof typeof state] ?? value; }
const usage = [
  '/task 新建 <要求>',
  '/task 查询 <任务号> [版本]',
  '/task 续办 <任务号> <版本> <新要求>',
  '/task 取消 <任务号> <版本>',
  '/task 重领 <任务号> <版本>',
  '/task 历史 [旧任务号]',
].join('\n');

function formatReceipt(receipt: TaskReceipt): string {
  return '任务 ' + receipt.taskId + '（第 ' + receipt.revision + ' 版）';
}

function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !taskIdPattern.test(value)) throw new MemoryError('请填写完整的任务号。');
  return value.toLowerCase();
}

function requiredVersion(value: unknown): number {
  const revision = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new MemoryError('请填写有效的版本号。');
  }
  return revision;
}

function requiredGoal(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000) {
    throw new MemoryError('请说明要后台完成的文字工作，最多 4000 字符。');
  }
  return value.trim();
}

function businessError(error: unknown): MemoryError {
  if (error instanceof MemoryError) return error;
  if (!(error instanceof TaskCoordinatorError)) throw error;
  const explanations = {
    invalid_request: '任务参数不符合要求，请核对任务号、版本和内容。',
    not_found: '这条私聊下没有找到该任务或结果。',
    conflict: '任务版本或请求内容已变化。请先查最新状态，再决定是否操作。',
    invalid_state: '目前无法执行该操作。请先查任务状态。',
  };
  return new MemoryError(explanations[error.code]);
}

function safeText(text: string): string { return text.replace(/<(?=\/?(?:qqbot-|@))/gi, '〈'); }

export function hasQQCoordinatorCutover(dataDir: string): boolean {
  return existsSync(join(dataDir, databaseName));
}

export class QQTaskRouter {
  private readonly owner: string;
  private readonly route: ChannelRoute;
  private readonly roomKey: string;
  private readonly senderId: string;
  private readonly databasePath: string;
  private readonly configured: boolean;
  private readonly awaitingReply = new Set<string>();
  private store?: TaskCoordinatorStore;
  private deliveryStore?: TaskDeliveryStore;
  private evidence?: DatabaseSync;
  private host?: ReturnType<typeof createTaskExecutionHost>;
  private delivery?: TaskDeliveryWorker;
  private timer?: NodeJS.Timeout;
  private sending: Promise<boolean> | undefined;
  private closed = false;
  private failed = false;
  private executionFaults = 0;

  constructor(
    private readonly config: PaConfig,
    binding: Binding,
    private readonly available: () => boolean,
    private readonly send: (message: OutboundMessage, signal: AbortSignal) => Promise<DeliveryResult>,
    private readonly serializeOutput: QueueOutput,
    private readonly deliveryAvailable: () => boolean,
    private readonly generate?: TaskTextGenerator,
    private readonly history?: LegacyStatus,
  ) {
    this.owner = codexOwnerKey(binding);
    this.route = { ...binding.route };
    this.roomKey = JSON.stringify([this.route.channel, this.route.accountId, this.route.roomType, this.route.roomId]);
    this.senderId = binding.senderId;
    this.databasePath = join(config.dataDir, databaseName);
    this.configured = config.taskCoordinator?.enabled === true;
  }

  get enabled(): boolean { return this.configured; }
  info() { return { enabled: this.configured, failed: this.failed, executionFaults: this.executionFaults }; }

  matches(route: ChannelRoute): boolean {
    return JSON.stringify([route.channel, route.accountId, route.roomType, route.roomId]) === this.roomKey;
  }

  start(): void {
    if (this.store || this.closed || !this.available()) return;
    try {
      if (!this.configured) {
        this.store = new TaskCoordinatorStore(this.databasePath, { readOnly: true });
        this.deliveryStore = new TaskDeliveryStore(this.databasePath, { readOnly: true });
        return;
      }
      mkdirSync(this.config.dataDir, { recursive: true });
      this.store = new TaskCoordinatorStore(this.databasePath);
      this.deliveryStore = new TaskDeliveryStore(this.databasePath);
      this.evidence = new DatabaseSync(this.databasePath);
      this.evidence.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
      this.evidence.exec('CREATE TABLE IF NOT EXISTS qq_task_sources (source_key TEXT PRIMARY KEY, owner TEXT NOT NULL, recorded_at INTEGER NOT NULL) STRICT;');
      this.host = createTaskExecutionHost({
        store: this.store, config: this.config, deliveryStore: this.deliveryStore, owner: this.owner,
        ...(this.generate ? { generate: this.generate } : {}),
        onError: () => { this.executionFaults++; },
      });
      this.delivery = new TaskDeliveryWorker(this.deliveryStore, {
        resolveRoute: source => {
          if (this.closed || !this.available() || !this.deliveryAvailable() || this.awaitingReply.has(source.sourceKey)) {
            throw new Error('QQ temporarily unavailable');
          }
          return this.hasSource(source.owner, source.sourceKey) ? { roomKey: this.roomKey, recipientKey: this.senderId } : undefined;
        },
        sendPart: (part, signal) => this.sendPart(part, signal),
      });
      this.timer = setInterval(() => this.tick(), 100);
      this.timer.unref();
    } catch (error) {
      void this.close().catch(() => undefined);
      throw error;
    }
  }

  private tick(): void {
    if (this.closed || this.failed || !this.available()) return;
    try {
      const round = this.host!.scheduler.tick();
      for (const active of [...round.dispatches, ...round.recoveries]) void active.catch(() => this.fail());
      if (this.sending || !this.deliveryAvailable()) return;
      const sending = this.serializeOutput(() => this.closed || !this.available() || !this.deliveryAvailable()
        ? Promise.resolve(false) : this.delivery!.tick());
      this.sending = sending;
      void sending.catch(() => this.fail()).finally(() => { this.sending = undefined; });
    } catch { this.fail(); }
  }

  private fail(): void {
    if (this.failed || this.closed) return;
    this.failed = true;
    clearInterval(this.timer);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    const results = await Promise.allSettled([this.host?.close(), this.delivery?.close(), this.sending]);
    this.evidence?.close();
    this.deliveryStore?.close();
    this.store?.close();
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }

  private canUse(route: ChannelRoute, senderId: string): boolean {
    return !this.closed && this.available() && this.matches(route) && senderId === this.senderId;
  }

  private hasSource(owner: string, sourceKey: string): boolean {
    return owner === this.owner && sourceKeyPattern.test(sourceKey)
      && !!this.evidence?.prepare('SELECT 1 FROM qq_task_sources WHERE source_key=? AND owner=?').get(sourceKey, owner);
  }

  private sourceKey(sourceId: string): string {
    return 'qq-task:' + createHash('sha256').update(JSON.stringify([this.owner, sourceId])).digest('hex');
  }

  finishReply(sourceId: string): void {
    if (this.awaitingReply.size) this.awaitingReply.delete(this.sourceKey(sourceId));
  }

  private source(sourceId: string): { key: string; deadlineAt: number } {
    if (!this.configured || !this.store || !this.deliveryStore || !this.evidence || this.failed || !sourceId) {
      throw new MemoryError('后台任务服务暂不可用。');
    }
    const key = this.sourceKey(sourceId);
    this.evidence.prepare('INSERT OR IGNORE INTO qq_task_sources VALUES(?,?,?)').run(key, this.owner, Date.now());
    const recordedAt = Number(this.evidence.prepare('SELECT recorded_at FROM qq_task_sources WHERE source_key=? AND owner=?')
      .get(key, this.owner)?.recorded_at);
    if (!Number.isSafeInteger(recordedAt)) throw new Error('QQ task source was not saved');
    // Let this request's QQ reply finish before releasing its delivery. Other
    // results, including recovered results after a restart, can still be sent.
    this.awaitingReply.add(key);
    return { key, deadlineAt: recordedAt + Math.max(600_000, this.config.timeoutMs) };
  }

  private queue(sourceId: string, goal: string, delivery: 'text' | 'markdown'): string {
    const { key, deadlineAt } = this.source(sourceId);
    const formats = delivery === 'markdown' ? [TASK_TEXT_RESULT_FORMAT] : [];
    const receipt = this.store!.submit(this.owner, key, {
      goal, capability: TASK_TEXT_CAPABILITY, materials: [], deadlineAt, budget: 1,
      outputFormats: formats, ...(formats.length ? { requiredArtifactFormats: formats } : {}),
    });
    return '已接下后台' + formatReceipt(receipt) + '。完成后会发到这条私聊。用 /task 查询 ' + receipt.taskId + ' 可查进度。';
  }

  private status(taskId: string, revision?: number): string {
    if (!this.store || !this.deliveryStore || this.failed) throw new MemoryError('后台任务服务暂不可用。');
    const status = this.store.status(this.owner, taskId, revision);
    if (!status) throw new MemoryError('这条私聊下没有找到该任务。');
    const result = status.phase === 'closed' ? this.deliveryStore.result(this.owner, status) : undefined;
    const deliveries = result?.deliveries ?? [];
    const report = deliveries.find(entry => entry.purpose === 'automatic');
    const files = result?.artifacts.map(item => item.reference + (item.available ? '' : '（暂不可领取）')).join('、');
    return [
      formatReceipt(status) + ' · ' + label(status.conclusion?.status ?? status.phase),
      ...(!this.configured && status.phase !== 'closed' ? ['后台执行当前已暂停。'] : []),
      ...(status.cancelRequestedAt !== undefined && status.phase !== 'closed' ? ['已请求取消，等待确认。'] : []),
      ...(status.conclusion ? [[...safeText(status.conclusion.summary)].slice(0, 650).join('')] : []),
      ...(report ? ['自动通知' + label(report.status) + '。'] : []),
      ...(files ? ['文件：' + files] : []),
    ].join('\n');
  }

  private revise(sourceId: string, taskId: string, revision: number, goal: string): string {
    const { key, deadlineAt } = this.source(sourceId);
    const receipt = this.store!.revise(this.owner, key, taskId, revision, goal, { deadlineAt });
    return '已接下' + formatReceipt(receipt) + '的续办。完成后会发到这条私聊。';
  }

  private reclaim(sourceId: string, taskId: string, revision: number): string {
    const { key } = this.source(sourceId);
    this.deliveryStore!.reclaim(this.owner, key, { taskId, revision });
    return '已登记重领' + formatReceipt({ taskId, revision }) + '。会发送保存的结果。';
  }

  private async sendPart(part: ChannelDeliveryPart, signal: AbortSignal) {
    if (signal.aborted || this.closed || !this.available() || !this.deliveryAvailable() || !this.hasSource(part.owner, part.sourceKey)
      || part.route.roomKey !== this.roomKey || part.route.recipientKey !== this.senderId) return { status: 'rejected' as const };
    const body = part.body;
    const text = body.kind === 'text'
      ? safeText(body.text.replace(/^(任务 \S+（第 \d+ 版） · )([a-z_]+)(?=\n)/, (_, heading: string, status: string) => heading + label(status)))
      : '';
    if (body.kind === 'artifact' && (body.artifact.format !== TASK_TEXT_RESULT_FORMAT || body.artifact.byteCount > 1024 * 1024
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,170}\.md$/i.test(body.artifact.reference))) return { status: 'rejected' as const };
    const sent = await this.send({ route: this.route, deliveryMode: 'active', text,
      ...(body.kind === 'text' ? { markdown: true } : {
        file: { name: body.artifact.reference, data: Buffer.from(body.artifact.bytes) },
        plainText: true,
      }),
    }, signal);
    return sent.status === 'sent' && sent.externalMessageId
      ? { status: 'sent' as const, receipt: sent.externalMessageId }
      : { status: sent.status === 'rejected' ? 'rejected' as const : 'unknown' as const };
  }

  async command(message: InboundMessage, sourceId: string): Promise<string | undefined> {
    const command = taskCommand.exec(message.text.trim());
    if (!command) return undefined;
    if (!this.canUse(message.route, message.senderId)) return '此入口仅对已配置的本人 QQ 私聊开放。';
    const [, action = '', args = ''] = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(command[1]?.trim() ?? '') ?? [];
    const [, id, version, goal] = /^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/u.exec(args) ?? [];
    try {
      if (action === '历史') {
        if (version) throw new MemoryError('请输入 /task 历史 [旧任务号]。');
        return this.history ? await this.history(id) : '暂未配置旧任务查询。原有任务记录继续保留。';
      }
      if (action === '查询') {
        if (goal) return usage;
        return this.status(requiredId(id), version === undefined ? undefined : requiredVersion(version));
      }
      if (!this.configured) return '后台任务当前只开放查询。用 /task 查询 查看任务，用 /task 历史 查看已配置的旧任务。';
      if (message.images?.length || message.imageSources?.length) return '目前的后台文字任务只处理文字要求，请把所需信息写在消息里。';
      switch (action) {
        case '新建':
        case '发起': return this.queue(sourceId, requiredGoal(args), 'markdown');
        case '续办': return this.revise(sourceId, requiredId(id), requiredVersion(version), requiredGoal(goal));
        case '取消': {
          if (goal) return usage;
          if (!this.store || this.failed) throw new MemoryError('后台任务服务暂不可用。');
          const result = this.store.cancel(this.owner, requiredId(id), requiredVersion(version));
          if (result.disposition === 'already_closed') return '这版任务已经结案。';
          return result.disposition === 'cancelled' ? '这版任务已取消。' : '已请求取消，执行方是否停止还在核对。';
        }
        case '重领':
          if (goal) return usage;
          return this.reclaim(sourceId, requiredId(id), requiredVersion(version));
        default: return usage;
      }
    } catch (error) { return businessError(error).message; }
  }

  context(route: ChannelRoute, senderId: string, sourceId: string, currentText: string,
    hasImages: boolean): CodexToolContext | undefined {
    if (!this.configured || !this.canUse(route, senderId)) return undefined;
    return { execute: async (name, params) => {
      try {
        if (!this.canUse(route, senderId) || this.failed) throw new MemoryError('后台任务服务暂不可用。');
        return this.execute(name, params, sourceId, currentText, hasImages);
      } catch (error) { throw businessError(error); }
    } };
  }

  private execute(name: CodexToolName, params: unknown, sourceId: string, currentText: string, hasImages: boolean) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new MemoryError('任务参数无效。');
    const input = params as Record<string, unknown>;
    const fields = { delegate_task: ['prompt', 'delivery'], continue_coding_task: ['id', 'revision', 'prompt'],
      coding_status: ['id', 'revision'], send_coding_result: ['id', 'revision'] }[name];
    if (!fields || Object.keys(input).some(key => !fields.includes(key))) throw new MemoryError('任务参数包含未允许字段。');
    if (name === 'coding_status') return { status: this.status(requiredId(input.id),
      input.revision === undefined ? undefined : requiredVersion(input.revision)) };
    if (hasImages) throw new MemoryError('后台文字任务只处理文字要求。');
    if (name === 'delegate_task') {
      if (!explicitDispatch.test(currentText)) throw new MemoryError('需由本人当前私聊明确交给后台处理。也可用 /task 新建。');
      if (input.delivery !== undefined && input.delivery !== 'markdown' && input.delivery !== 'text') {
        throw new MemoryError('交付格式需为 markdown 或 text。');
      }
      return { saved: true, confirmation: this.queue(sourceId, requiredGoal(input.prompt), input.delivery === 'text' ? 'text' : 'markdown') };
    }
    const id = requiredId(input.id);
    const version = requiredVersion(input.revision);
    if (name === 'continue_coding_task') {
      if (!/续办|继续|再做|再写|再改|修改/u.test(currentText)) throw new MemoryError('需由本人当前私聊明确续办。');
      return { saved: true, confirmation: this.revise(sourceId, id, version, requiredGoal(input.prompt)) };
    }
    if (!/重领|领取|发我|发给我|再发|补发/u.test(currentText)) throw new MemoryError('需由本人当前私聊明确重领。');
    return { saved: true, confirmation: this.reclaim(sourceId, id, version) };
  }
}

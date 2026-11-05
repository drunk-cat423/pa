import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PaConfig } from './config.js';
import type { ChannelRoute, DeliveryResult, OutboundMessage } from './channel-types.js';
import type { HarnessPolicy } from './harness-policy.js';
import type { CodexToolContext, CodexToolName } from './codex-tools.js';
import { MemoryError } from './memory-types.js';
import { CodexPublication, type PublicationConfirmation } from './codex-publication.js';
import type { InboundMessage } from './channel-types.js';

export interface CodexTask {
  id: string; revision: number; status: string; requestId?: string;
  summary?: string; evidence?: string; diff?: string;
  mode?: 'read' | 'fix';
}
type Binding = HarnessPolicy['ownerBindings'][number];
class CodexResponseError extends MemoryError {
  constructor(message: string, readonly statusCode: number) { super(message); }
}
const routeKey = (route: ChannelRoute) => JSON.stringify([route.channel, route.accountId, route.roomType, route.roomId]);
export const codexOwnerKey = (binding: Binding) => createHash('sha256').update(JSON.stringify([
  binding.route.channel, binding.route.accountId, binding.route.roomType, binding.route.roomId, binding.senderId,
])).digest('hex');
export function codexPrivateOwner(policy: HarnessPolicy, routes: readonly ChannelRoute[]): Binding {
  const allowed = new Set(routes.map(routeKey));
  const candidates = policy.ownerBindings.filter(binding => binding.route.channel === 'qq'
    && binding.route.roomType === 'private' && binding.senderId === binding.route.roomId && allowed.has(routeKey(binding.route)));
  if (candidates.length !== 1) throw new Error('Codex需要唯一已授权且已接入的本人QQ私聊绑定。');
  return candidates[0]!;
}
const terminal = (task: CodexTask) => ['completed', 'failed', 'interrupted', 'blocked', 'partial'].includes(task.status);
function validTask(value: unknown): CodexTask {
  if (!value || typeof value !== 'object') throw new MemoryError('Codex任务响应无效。');
  const t = value as CodexTask;
  if (typeof t.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(t.id) || !Number.isSafeInteger(t.revision) || t.revision < 1
    || typeof t.status !== 'string' || !['queued', 'running', 'completed', 'failed', 'interrupted', 'blocked', 'partial'].includes(t.status)
    || ['summary', 'evidence', 'diff', 'requestId'].some(key => t[key as keyof CodexTask] !== undefined && typeof t[key as keyof CodexTask] !== 'string')) {
    throw new MemoryError('Codex任务响应字段无效。');
  }
  return t;
}
const safeText = (text: string) => text.replace(/<(?=\/?(?:qqbot-|@))/gi, '〈');
const textLimit = (text: string, limit: number) => [...safeText(text)].slice(0, limit).join('');
function resultText(task: CodexTask): string {
  // Older workers included fenced command output and patches in their final answer.
  const prose = (task.summary ?? '').replace(/^`{3,}[^\n]*\n[\s\S]*?(?:^`{3,}[^\n]*(?:\n|$)|(?![\s\S]))/gm, '')
    .split(/^(?:diff --git |--- (?:a\/|\/dev\/null)|@@ -)/m, 1)[0]!.trim();
  const state: Record<string, string> = { completed: '已完成', failed: '未完成', partial: '部分完成', blocked: '遇到阻塞', interrupted: '执行中断' };
  return [`任务 ${task.id} · 第 ${task.revision} 次 · ${state[task.status] ?? task.status}`,
    textLimit(prose || '这次没有可用的文字结论。', 650),
    ...(task.diff?.startsWith('diff --git ') ? ['改动保存在任务副本中，尚未部署。'] : []),
  ].join('\n');
}

/** The worker owns execution; this service owns trusted QQ identity and durable delivery. */
export class CodexService {
  private readonly owner: string;
  private db: DatabaseSync | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling: Promise<void> | undefined;
  private closed = false;
  private lastError: string | undefined;
  private readonly publication?: CodexPublication;
  constructor(private readonly config: Pick<PaConfig, 'dataDir' | 'codex'>, private readonly binding: Binding,
    private readonly available: () => boolean,
    private readonly send: (message: OutboundMessage) => Promise<DeliveryResult>) {
    this.owner = codexOwnerKey(binding);
    if (config.codex?.publishSocketPath) this.publication = new CodexPublication(config.dataDir, config.codex.publishSocketPath,
      this.owner, binding.route, binding.senderId, available, id => this.task(id), send);
  }

  confirmPublication(message: InboundMessage): Promise<PublicationConfirmation | undefined> {
    return this.publication?.confirm(message) ?? Promise.resolve(undefined);
  }

  private storage(): DatabaseSync {
    if (this.closed) throw new MemoryError('Codex委派服务已关闭。');
    if (!this.db) {
      mkdirSync(this.config.dataDir, { recursive: true });
      this.db = new DatabaseSync(join(this.config.dataDir, 'codex-delivery.sqlite'));
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS requests(request_id TEXT PRIMARY KEY, task_id TEXT, revision INTEGER, done INTEGER NOT NULL DEFAULT 0,
          owner TEXT NOT NULL DEFAULT '', checked_at INTEGER NOT NULL DEFAULT 0, misses INTEGER NOT NULL DEFAULT 0, resolution TEXT);
        CREATE TABLE IF NOT EXISTS notifications(task_id TEXT NOT NULL, revision INTEGER NOT NULL, purpose TEXT NOT NULL,
          status TEXT NOT NULL, PRIMARY KEY(task_id,revision,purpose));
        UPDATE notifications SET status='uncertain' WHERE status='sending';`);
      const columns = new Set(this.db.prepare('PRAGMA table_info(requests)').all().map(row => String(row.name)));
      for (const [name, definition] of Object.entries({ owner: "TEXT NOT NULL DEFAULT ''", checked_at: 'INTEGER NOT NULL DEFAULT 0',
        misses: 'INTEGER NOT NULL DEFAULT 0', resolution: 'TEXT' })) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${definition}`);
      }
      // Old feature previews lacked a trusted owner. Keep their audit rows, but never
      // infer a new recipient after a policy change or send their unknown results.
      this.db.prepare("UPDATE requests SET done=1,resolution='owner_unverified' WHERE owner='' AND done=0").run();
    }
    return this.db;
  }
  start(): void { this.storage(); this.timer ??= setInterval(() => this.wake(), 2000); this.timer.unref(); this.wake(); }
  prepare(): void { this.storage(); }
  info() { return { enabled: true, failed: Boolean(this.lastError), ...(this.lastError ? { error: this.lastError } : {}) }; }
  matches(route: ChannelRoute): boolean { return routeKey(route) === routeKey(this.binding.route); }
  context(route: ChannelRoute, senderId: string, sourceMessageId: string): CodexToolContext | undefined {
    if (!this.matches(route) || senderId !== this.binding.senderId || !this.available()) return undefined;
    return { execute: (name, params) => this.execute(route, senderId, sourceMessageId, name, params) };
  }
  private async call(path: string, body?: unknown): Promise<unknown> {
    const socketPath = this.config.codex?.socketPath;
    if (!socketPath) throw new MemoryError('Codex执行器未配置。');
    return new Promise((resolve, reject) => {
      const req = request({ socketPath, path, method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' } }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2_000_000) req.destroy(new Error('response too large')); else chunks.push(chunk); });
        response.on('end', () => {
          try {
            let value: unknown;
            try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { value = undefined; }
            if ((response.statusCode ?? 500) >= 400) {
              const message = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' ? value.error : 'Codex执行器拒绝本次操作。';
              reject(new CodexResponseError(textLimit(message, 500), response.statusCode ?? 500)); return;
            }
            if (value === undefined) throw new Error('invalid JSON');
            resolve(value);
          } catch { reject(new MemoryError('Codex执行器返回无效结果。')); }
        });
        response.on('error', () => reject(new MemoryError('Codex执行器响应中断，任务状态待查询。')));
      });
      req.setTimeout(5000, () => req.destroy(new Error('timeout')));
      req.on('error', () => reject(new MemoryError('Codex执行器暂不可用或状态未确认，请查询任务；不要重复创建。')));
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  private async tasks(requestId?: string): Promise<CodexTask[]> {
    const value = await this.call(`/tasks?owner=${encodeURIComponent(this.owner)}${requestId ? `&requestId=${encodeURIComponent(requestId)}` : ''}`);
    if (!value || typeof value !== 'object' || !('tasks' in value) || !Array.isArray(value.tasks) || value.tasks.length > 1000) throw new MemoryError('Codex任务列表无效。');
    return value.tasks.map(validTask);
  }
  private async task(id: string): Promise<CodexTask> {
    return validTask(await this.call(`/tasks/${encodeURIComponent(id)}?owner=${encodeURIComponent(this.owner)}`));
  }
  private remember(requestId: string, task: CodexTask): void {
    this.storage().prepare("UPDATE requests SET task_id=?,revision=?,done=0,misses=0,resolution='accepted' WHERE request_id=? AND owner=?")
      .run(task.id, task.revision, requestId, this.owner);
  }
  private async execute(route: ChannelRoute, senderId: string, sourceId: string, name: CodexToolName, params: unknown): Promise<unknown> {
    if (!this.matches(route) || senderId !== this.binding.senderId || !this.available()) throw new MemoryError('此操作仅开放给已配置的本人QQ私聊。');
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new MemoryError('Codex参数必须是对象。');
    const p = params as Record<string, unknown>;
    const allowed = { delegate_task: ['prompt', 'mode'], continue_coding_task: ['prompt', 'mode', 'id'], coding_status: ['id'], send_coding_result: ['id'] }[name];
    if (!allowed || Object.keys(p).some(key => !allowed.includes(key))) throw new MemoryError('Codex参数包含未允许字段。');
    if (p.id !== undefined && (typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(p.id))) throw new MemoryError('Codex任务编号无效。');
    if (name === 'coding_status') {
      if (typeof p.id === 'string') {
        const { id, revision, status, summary } = await this.task(p.id);
        return { id, revision, status, summary: textLimit(summary ?? '', 1200) };
      }
      const tasks = await this.tasks();
      return { tasks: tasks.slice(0, 20).map(({ id, revision, status, summary }) => ({ id, revision, status, summary })), more: tasks.length > 20 };
    }
    if (name === 'send_coding_result') {
      if (typeof p.id !== 'string') throw new MemoryError('请指定要领取的Codex任务编号。');
      const task = await this.task(p.id);
      if (!terminal(task)) throw new MemoryError('任务尚未结束，请先查看进度。');
      return { id: task.id, revision: task.revision, deliveryStatus: await this.deliver(task, `request:${sourceId}`) };
    }
    if (typeof p.prompt !== 'string' || !p.prompt.trim() || p.prompt.length > 6000 || !['read', 'fix'].includes(String(p.mode))) throw new MemoryError('Codex任务需要明确的目标及read或fix模式。');
    let taskId: string | undefined;
    if (name === 'continue_coding_task') {
      taskId = typeof p.id === 'string' ? p.id : undefined;
      if (!taskId) {
        const tasks = await this.tasks();
        if (tasks.length !== 1) throw new MemoryError('存在多个或没有Codex任务，请查询后指定要续办的编号。');
        taskId = tasks[0]!.id;
      }
    }
    const requestId = createHash('sha256').update(`${this.owner}:${sourceId}:codex`).digest('hex');
    const db = this.storage();
    db.prepare('INSERT OR IGNORE INTO requests(request_id,owner) VALUES (?,?)').run(requestId, this.owner);
    let task: CodexTask;
    try {
      task = validTask(await this.call('/tasks', { requestId, owner: this.owner, mode: p.mode, prompt: p.prompt.trim(), ...(taskId ? { taskId } : {}) }));
    } catch (error) {
      if (error instanceof CodexResponseError && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 408) {
        db.prepare("UPDATE requests SET done=1,resolution='rejected' WHERE request_id=? AND owner=?").run(requestId, this.owner);
      }
      throw error;
    }
    this.remember(requestId, task); this.wake();
    return { id: task.id, revision: task.revision, status: task.status, saved: true,
      confirmation: `已交给 Codex，任务 ${task.id}（第 ${task.revision} 次）。完成后我会在这里告诉你结果。` };
  }
  private wake(): void {
    if (this.closed || this.polling || !this.available()) return;
    this.polling = this.poll().then(() => { this.lastError = undefined; }, error => {
      this.lastError = error instanceof Error ? textLimit(error.message, 300) : 'Codex通知暂不可用。';
    }).finally(() => { this.polling = undefined; });
  }
  private async poll(): Promise<void> {
    await this.publication?.poll();
    const db = this.storage();
    const requests = db.prepare('SELECT request_id,task_id,revision,misses FROM requests WHERE owner=? AND done=0 ORDER BY checked_at,rowid LIMIT 20').all(this.owner);
    if (!requests.length) return;
    const deadline = Date.now() + 8000;
    let failure: unknown;
    for (const source of requests) {
      db.prepare('UPDATE requests SET checked_at=? WHERE request_id=? AND owner=?').run(Date.now(), String(source.request_id), this.owner);
      try {
        const tasks = await this.tasks(String(source.request_id));
        const task = tasks.find(task => task.requestId === source.request_id);
        if (!task) {
          const misses = Number(source.misses) + 1;
          db.prepare("UPDATE requests SET misses=?,done=?,resolution='acceptance_unconfirmed' WHERE request_id=? AND owner=?")
            .run(misses, misses >= 3 ? 1 : 0, String(source.request_id), this.owner);
        } else {
          if (!source.task_id) this.remember(String(source.request_id), task);
          if (terminal(task)) {
            await this.deliver(task, 'automatic');
            db.prepare("UPDATE requests SET done=1,resolution='finished' WHERE request_id=? AND owner=?").run(String(source.request_id), this.owner);
          }
        }
      } catch (error) {
        // A per-request lookup failure must not hide another completed task.
        failure = error;
      }
      if (this.closed || Date.now() >= deadline) break;
    }
    if (failure) throw failure;
  }
  private async deliver(task: CodexTask, purpose: string): Promise<string> {
    const db = this.storage();
    purpose = `${this.owner}:${purpose}`;
    const reservation = db.prepare("INSERT OR IGNORE INTO notifications(task_id,revision,purpose,status) VALUES (?,?,?,'sending')").run(task.id, task.revision, purpose);
    if (!reservation.changes) {
      const status = String(db.prepare('SELECT status FROM notifications WHERE task_id=? AND revision=? AND purpose=?').get(task.id, task.revision, purpose)?.status);
      if (status === 'sent') this.publication?.recordReport(task);
      return status;
    }
    let outcome: DeliveryResult;
    try {
      outcome = this.closed || !this.available() ? { status: 'rejected' } : await this.send({ route: this.binding.route, deliveryMode: 'active', plainText: true,
        text: resultText(task) });
    } catch { outcome = { status: 'uncertain' }; }
    db.prepare('UPDATE notifications SET status=? WHERE task_id=? AND revision=? AND purpose=?').run(outcome.status, task.id, task.revision, purpose);
    if (outcome.status === 'sent') this.publication?.recordReport(task);
    return outcome.status;
  }
  async wait(): Promise<void> { this.wake(); await this.polling; }
  async close(): Promise<void> { this.closed = true; clearInterval(this.timer); await this.polling; this.publication?.close(); this.db?.close(); this.db = undefined; }
}

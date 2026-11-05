import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CodexTask } from './codex-service.js';
import type { ChannelRoute, DeliveryResult, InboundMessage, OutboundMessage } from './channel-types.js';
import { MemoryError } from './memory-types.js';

interface Release { id: string; requestId: string; taskId: string; revision: number; status: string; summary?: string }
export interface PublicationConfirmation { text: string; acknowledge(sent: boolean): Promise<void> }
const confirmation = /^(?:可以[，,\s]*)?(?:把这版上线|把任务\s+([A-Za-z0-9_-]{1,100})\s+第\s*([1-9]\d{0,5})\s*版上线)[。！!]?$/u;
const terminal = new Set(['succeeded', 'rolled_back', 'failed']);
function validRelease(value: unknown): Release {
  if (!value || typeof value !== 'object') throw new MemoryError('发布任务响应无效。');
  const r = value as Release;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(r.id) || !/^[a-f0-9]{64}$/.test(r.requestId)
    || !/^[A-Za-z0-9_-]{1,100}$/.test(r.taskId) || !Number.isSafeInteger(r.revision) || r.revision < 1
    || !['prepared', 'queued', 'running', ...terminal].includes(r.status)
    || (r.summary !== undefined && typeof r.summary !== 'string')) throw new MemoryError('发布任务字段无效。');
  return r;
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** Only authenticated original whole-message confirmation reaches this service. */
export class CodexPublication {
  private db: DatabaseSync | undefined;
  constructor(private readonly directory: string, private readonly socket: string, private readonly owner: string,
    private readonly route: ChannelRoute, private readonly senderId: string, private readonly available: () => boolean,
    private readonly task: (id: string) => Promise<CodexTask>, private readonly send: (message: OutboundMessage) => Promise<DeliveryResult>) {}
  private storage(): DatabaseSync {
    if (!this.db) {
      mkdirSync(this.directory, { recursive: true });
      this.db = new DatabaseSync(join(this.directory, 'codex-publication.sqlite'));
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS reports(owner TEXT NOT NULL,task_id TEXT NOT NULL,revision INTEGER NOT NULL,
          status TEXT NOT NULL,mode TEXT,patch_hash TEXT,PRIMARY KEY(owner,task_id,revision));
        CREATE TABLE IF NOT EXISTS intents(request_id TEXT PRIMARY KEY,owner TEXT NOT NULL,task_id TEXT NOT NULL,revision INTEGER NOT NULL,
          release_id TEXT,ack TEXT NOT NULL DEFAULT 'pending',started INTEGER NOT NULL DEFAULT 0,
          notified TEXT NOT NULL DEFAULT 'pending',done INTEGER NOT NULL DEFAULT 0,checked_at INTEGER NOT NULL DEFAULT 0);
        UPDATE intents SET notified='uncertain',done=1 WHERE notified='sending';`);
    }
    return this.db;
  }
  recordReport(task: CodexTask): void {
    // Re-sending an older result does not move it ahead of newer revisions.
    this.storage().prepare('INSERT OR IGNORE INTO reports VALUES (?,?,?,?,?,?)')
      .run(this.owner, task.id, task.revision, task.status, task.mode ?? null, task.diff ? digest(task.diff) : null);
  }
  private async call(path: string, data?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.socket, path, method: data ? 'POST' : 'GET', headers: { 'content-type': 'application/json' } }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 200_000) req.destroy(new Error('response too large')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: unknown };
            if ((res.statusCode ?? 500) >= 400) throw new MemoryError(typeof value.error === 'string' ? value.error.slice(0, 350) : '发布程序拒绝了本次请求。');
            resolve(value);
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error('发布程序暂不可用，状态待确认。')));
      req.on('error', reject);
      req.end(data ? JSON.stringify(data) : undefined);
    });
  }
  async confirm(message: InboundMessage): Promise<PublicationConfirmation | undefined> {
    if (message.route.channel !== this.route.channel || message.route.accountId !== this.route.accountId
      || message.route.roomType !== this.route.roomType || message.route.roomId !== this.route.roomId
      || message.senderId !== this.senderId || !this.available()) return;
    if (message.text.trim() === '查看发布结果') {
      try {
        const row = this.storage().prepare('SELECT * FROM intents WHERE owner=? ORDER BY rowid DESC LIMIT 1').get(this.owner);
        if (!row) return { text: '目前没有你的发布记录。', acknowledge: async () => {} };
        const release = await this.lookup(String(row.request_id));
        if (!release) return { text: '发布接单状态尚未确认，请稍后再查询。', acknowledge: async () => {} };
        return { text: this.releaseText(release), acknowledge: async () => {} };
      } catch { return { text: '发布程序暂不可用，已保存的发布记录会保留，请稍后再查询。', acknowledge: async () => {} }; }
    }
    const match = confirmation.exec(message.text.trim());
    if (!match) return;
    if (message.quote || message.images?.length || message.imageSources?.length) return { text: '请直接发送上线确认，并指定任务和版本；引用内容不能授权发布。', acknowledge: async () => {} };
    try {
      const db = this.storage();
      const report = match[1] ? db.prepare('SELECT * FROM reports WHERE owner=? AND task_id=? AND revision=?')
        .get(this.owner, match[1], Number(match[2]))
        : db.prepare('SELECT * FROM reports WHERE owner=? ORDER BY rowid DESC LIMIT 1').get(this.owner);
      if (!report || report.status !== 'completed' || report.mode !== 'fix' || !report.patch_hash) {
        throw new MemoryError('请先让我汇报一个已完成的代码修复，再确认上线；也可以明确任务编号和版本。');
      }
      const current = await this.task(String(report.task_id));
      if (current.revision !== report.revision || current.status !== 'completed' || current.mode !== 'fix'
        || digest(current.diff ?? '') !== report.patch_hash) throw new MemoryError('该任务已有新版本或状态发生变化，请先查看最新结果后再确认。');
      // An earlier prepared release may have an unknown initial QQ acknowledgement.
      // A fresh authenticated confirmation reuses that frozen request, then re-acks it.
      const previous = db.prepare('SELECT request_id FROM intents WHERE owner=? AND task_id=? AND revision=? ORDER BY rowid DESC LIMIT 1')
        .get(this.owner, current.id, current.revision);
      const requestId = previous ? String(previous.request_id) : digest(`${this.owner}:${message.eventId}:publish`);
      db.prepare('INSERT OR IGNORE INTO intents(request_id,owner,task_id,revision) VALUES (?,?,?,?)')
        .run(requestId, this.owner, current.id, current.revision);
      const release = validRelease(await this.call('/releases', { owner: this.owner, requestId, taskId: current.id,
        revision: current.revision, patchSha256: String(report.patch_hash) }));
      if (release.taskId !== current.id || release.revision !== current.revision || release.requestId !== requestId) throw new MemoryError('发布程序返回了不同的任务版本。');
      db.prepare('UPDATE intents SET release_id=? WHERE request_id=? AND owner=?').run(release.id, requestId, this.owner);
      if (release.status !== 'prepared') return { text: `该任务第 ${current.revision} 版已有发布记录，当前状态为 ${release.status}。`, acknowledge: async () => {} };
      return { text: `收到，准备上线任务 ${current.id} 第 ${current.revision} 版。切换时我会短暂离线，重新连接后告诉你结果。`,
        acknowledge: async sent => {
          db.prepare('UPDATE intents SET ack=? WHERE request_id=? AND owner=?').run(sent ? 'sent' : 'uncertain', requestId, this.owner);
          if (sent) { try { await this.start(requestId, release.id); } catch { /* Durable sent acknowledgement is retried by polling. */ } }
        } };
    } catch (error) {
      return { text: error instanceof Error ? error.message.slice(0, 350) : '未能确认发布任务，请稍后查询。', acknowledge: async () => {} };
    }
  }
  private async start(requestId: string, releaseId: string): Promise<void> {
    const row = this.storage().prepare('SELECT ack FROM intents WHERE request_id=? AND owner=?').get(requestId, this.owner);
    if (row?.ack !== 'sent') return;
    const release = validRelease(await this.call(`/releases/${releaseId}/start`, { owner: this.owner, requestId }));
    if (release.id !== releaseId || release.requestId !== requestId) throw new MemoryError('发布启动响应与确认任务不一致。');
    this.storage().prepare('UPDATE intents SET started=1 WHERE request_id=? AND owner=?').run(requestId, this.owner);
  }
  private async lookup(requestId: string): Promise<Release | undefined> {
    const value = await this.call(`/releases?owner=${this.owner}&requestId=${requestId}`);
    if (!value || typeof value !== 'object' || !('releases' in value) || !Array.isArray(value.releases)) throw new MemoryError('发布任务列表无效。');
    return value.releases.map(validRelease).find(item => item.requestId === requestId);
  }
  private releaseText(release: Release): string {
    const statuses: Record<string, string> = { prepared: '等待确认送达', queued: '已排队', running: '正在发布',
      succeeded: '已上线', rolled_back: '上线失败，已恢复旧版', failed: '发布未完成' };
    return `任务 ${release.taskId} 第 ${release.revision} 版 · ${statuses[release.status]}\n${(release.summary ?? '').replace(/<(?=\/?(?:qqbot-|@))/gi, '〈').slice(0, 700)}`;
  }
  async poll(): Promise<void> {
    if (!this.available()) return;
    const db = this.storage();
    const rows = db.prepare('SELECT * FROM intents WHERE owner=? AND done=0 ORDER BY checked_at,rowid LIMIT 8').all(this.owner);
    const deadline = Date.now() + 8000;
    for (const row of rows) {
      db.prepare('UPDATE intents SET checked_at=? WHERE request_id=?').run(Date.now(), String(row.request_id));
      try {
        const release = await this.lookup(String(row.request_id));
        if (!release) continue;
        if (release.taskId !== row.task_id || release.revision !== row.revision) throw new MemoryError('发布结果与原确认版本不一致。');
        if (!row.release_id) db.prepare('UPDATE intents SET release_id=? WHERE request_id=?').run(release.id, String(row.request_id));
        if (release.status === 'prepared' && row.ack === 'sent') { await this.start(String(row.request_id), release.id); continue; }
        if (!terminal.has(release.status)) continue;
        if (row.notified !== 'pending') continue;
        db.prepare("UPDATE intents SET notified='sending' WHERE request_id=?").run(String(row.request_id));
        let result: DeliveryResult;
        try { result = await this.send({ route: this.route, deliveryMode: 'active', plainText: true,
          text: this.releaseText(release) }); }
        catch { result = { status: 'uncertain' }; }
        db.prepare('UPDATE intents SET notified=?,done=1 WHERE request_id=?').run(result.status, String(row.request_id));
      } catch { /* The independent publisher keeps the result; later polls query without recreating it. */ }
      if (!this.available() || Date.now() >= deadline) break;
    }
  }
  close(): void { this.db?.close(); this.db = undefined; }
}

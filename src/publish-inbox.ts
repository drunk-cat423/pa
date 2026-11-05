import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChannelRoute, InboundMessage } from './channel-types.js';

const routeKey = (r: ChannelRoute) => JSON.stringify([r.channel, r.accountId, r.roomType, r.roomId]);
export function readPublicationGate(path?: string): 'hold' | 'activate' | 'opening' | undefined {
  if (!path) return;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 40) throw new Error('发布门禁文件无效。');
    const value = readFileSync(path, 'utf8').trim();
    if (!['hold', 'activate', 'opening'].includes(value)) throw new Error('发布门禁状态无效。');
    return value as 'hold' | 'activate' | 'opening';
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** Lives outside the application data snapshot so rollback cannot erase captured QQ input. */
export class PublishInbox {
  private readonly db: DatabaseSync;
  private readonly allowed: Set<string>;
  constructor(directory: string, routes: readonly ChannelRoute[]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
      throw new Error('发布收件箱需要独立的私有目录。');
    }
    const path = join(directory, 'inbox.sqlite');
    try { if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('发布收件箱文件无效。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.allowed = new Set(routes.map(routeKey));
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS inbox(sequence INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
        route_key TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS blocked_rooms(route_key TEXT PRIMARY KEY,retry_at INTEGER NOT NULL,reason TEXT NOT NULL);`);
    if (!this.db.prepare('PRAGMA table_info(inbox)').all().some(column => column.name === 'route_key')) {
      this.db.exec("ALTER TABLE inbox ADD COLUMN route_key TEXT NOT NULL DEFAULT ''");
    }
    for (const row of this.db.prepare("SELECT sequence,payload FROM inbox WHERE route_key=''").all()) {
      const message = JSON.parse(String(row.payload)) as InboundMessage;
      this.db.prepare('UPDATE inbox SET route_key=? WHERE sequence=?').run(routeKey(message.route), Number(row.sequence));
    }
    if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('发布收件箱完整性检查失败。');
  }
  capture(message: InboundMessage): boolean {
    if (!this.allowed.has(routeKey(message.route))) return false;
    if (!message.eventId || !message.senderId || message.text.length > 4000 || !Number.isFinite(Date.parse(message.sentAt))
      || (message.route.roomType === 'private' && message.senderId !== message.route.roomId)) throw new Error('无法核实发布期间的 QQ 原始消息。');
    const payload = JSON.stringify(message);
    if (Buffer.byteLength(payload) > 1_000_000) throw new Error('发布期间的 QQ 原始消息超过收件箱上限。');
    const key = createHash('sha256').update(routeKey(message.route) + ':' + message.eventId).digest('hex');
    this.db.prepare('INSERT OR IGNORE INTO inbox(event_key,payload,route_key) VALUES (?,?,?)').run(key, payload, routeKey(message.route));
    return true;
  }
  next(now = Date.now()): { sequence: number; message: InboundMessage } | undefined {
    const routes = [...this.allowed];
    if (!routes.length) return;
    const row = this.db.prepare(`SELECT i.sequence,i.payload FROM inbox i
      LEFT JOIN blocked_rooms b ON b.route_key=i.route_key AND b.retry_at>?
      WHERE b.route_key IS NULL AND i.route_key IN (${routes.map(() => '?').join(',')}) ORDER BY i.sequence LIMIT 1`).get(now, ...routes);
    if (!row) return;
    const message = JSON.parse(String(row.payload)) as InboundMessage;
    if (!this.allowed.has(routeKey(message.route))) throw new Error('发布收件箱中存在已撤销路由的消息，等待本机处理。');
    return { sequence: Number(row.sequence), message };
  }
  acknowledge(sequence: number): void { this.db.prepare('DELETE FROM inbox WHERE sequence=?').run(sequence); }
  deferRoom(route: ChannelRoute, now = Date.now()): void {
    this.db.prepare(`INSERT INTO blocked_rooms VALUES (?,?,'room_admission_failed')
      ON CONFLICT(route_key) DO UPDATE SET retry_at=excluded.retry_at,reason=excluded.reason`).run(routeKey(route), now + 30_000);
  }
  size(): number { return Number(this.db.prepare('SELECT count(*) AS n FROM inbox').get()!.n); }
  close(): void { this.db.close(); }
}

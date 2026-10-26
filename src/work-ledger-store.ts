import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MemoryError } from './memory-types.js';
import type { ChannelRoute } from './channel-types.js';
import type { NotificationOutcome, ReminderInput, ReminderLease, WorkItem, WorkNotification } from './work-ledger-types.js';

type Tx = <T>(operation: () => T) => T;
const MAX_GOAL = 2000;
const LEASE_MS = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const routeKey = (route: ChannelRoute) => JSON.stringify([route.channel,route.accountId,route.roomType,route.roomId]);

export function migrateWorkLedger(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY, owner_person_id TEXT NOT NULL REFERENCES persons(id), kind TEXT NOT NULL CHECK(kind='reminder'),
      idempotency_key TEXT NOT NULL, goal TEXT NOT NULL, origin_message_id TEXT NOT NULL REFERENCES messages(id),
      source_conversation_id TEXT NOT NULL REFERENCES conversations(id), source_route_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('scheduled','running','waiting_user','cancel_requested','cancelled','completed')),
      version INTEGER NOT NULL CHECK(version >= 1), remind_at INTEGER NOT NULL, timezone TEXT NOT NULL CHECK(timezone='Asia/Shanghai'),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(origin_message_id,idempotency_key)
    );
    CREATE INDEX work_reminders_due ON work_items(remind_at,id) WHERE kind='reminder' AND status='scheduled';
    CREATE INDEX work_by_owner ON work_items(owner_person_id,updated_at DESC,id);
    CREATE TABLE work_authorizations (
      work_id TEXT PRIMARY KEY REFERENCES work_items(id), owner_person_id TEXT NOT NULL REFERENCES persons(id),
      source_route_json TEXT NOT NULL, source_actor_id TEXT NOT NULL REFERENCES actors(id), created_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE TABLE work_attempts (
      work_id TEXT NOT NULL REFERENCES work_items(id), attempt INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','interrupted')),
      lease_token TEXT NOT NULL, lease_until INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
      PRIMARY KEY(work_id,attempt), UNIQUE(work_id,lease_token)
    );
    CREATE UNIQUE INDEX work_one_active_attempt ON work_attempts(work_id) WHERE status='running';
    CREATE TABLE work_events (
      work_id TEXT NOT NULL REFERENCES work_items(id), seq INTEGER NOT NULL, event_type TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      reason TEXT, source_message_id TEXT REFERENCES messages(id), PRIMARY KEY(work_id,seq)
    );
    CREATE TABLE work_notifications (
      id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES work_items(id), event_seq INTEGER NOT NULL,
      route_json TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','sending','sent','rejected','uncertain')),
      lease_until INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(work_id,event_seq,route_json),
      FOREIGN KEY(work_id,event_seq) REFERENCES work_events(work_id,seq)
    );
    CREATE INDEX work_notifications_queued ON work_notifications(status,created_at,id) WHERE status='queued';
  `);
  db.prepare(`INSERT INTO maintenance_contracts(domain,version) VALUES('work-ledger',1)`).run();
}

export class WorkLedgerStore {
  constructor(private readonly db: DatabaseSync, private readonly transaction: Tx) {}

  createReminder(conversationId: string, sourceMessageId: string, input: ReminderInput): WorkItem {
    return this.transaction(() => {
      this.validateInput(input);
      const source = this.source(conversationId, sourceMessageId);
      if (!this.isStrictIsoDate(input.remindAt)) throw new MemoryError('提醒时间必须是有效且包含明确时区的 ISO 时间。');
      const remindAt = Date.parse(input.remindAt);
      if (!Number.isSafeInteger(remindAt) || !Number.isFinite(new Date(remindAt).getTime()) || remindAt < 0) throw new MemoryError('提醒时间无效。');
      const key = input.key.trim();
      const existing = this.db.prepare(`SELECT * FROM work_items WHERE origin_message_id=? AND idempotency_key=?`)
        .get(sourceMessageId, key);
      if (existing) {
        if (existing.owner_person_id !== source.personId || existing.goal !== input.goal.trim() || Number(existing.remind_at) !== remindAt || existing.timezone !== input.timezone || existing.source_route_json !== JSON.stringify(source.route))
          throw new MemoryError('相同幂等键已用于不同提醒内容。');
        return this.mapWork(existing);
      }
      if (remindAt <= Date.now()) throw new MemoryError('提醒时间必须晚于当前时间。');
      const id = randomUUID(), now = Date.now(), goal = input.goal.trim(), routeJson = JSON.stringify(source.route);
      this.db.prepare(`INSERT INTO work_items VALUES(?,?, 'reminder', ?,?,?,?,?,'scheduled',1,?,?,?,?)`)
        .run(id, source.personId, key, goal, sourceMessageId, conversationId, routeJson, remindAt, input.timezone, now, now);
      this.db.prepare('INSERT INTO work_authorizations VALUES(?,?,?,?,?,NULL)')
        .run(id, source.personId, routeJson, source.actorId, now);
      this.event(id, 'created', now, null, sourceMessageId);
      return this.getWork(id);
    });
  }

  listReminders(conversationId: string, sourceMessageId: string): WorkItem[] {
    const source = this.source(conversationId, sourceMessageId);
    const route=source.route;
    const rows=route.roomType==='private'
      ? this.db.prepare(`SELECT * FROM work_items WHERE owner_person_id=? AND kind='reminder' AND json_extract(source_route_json,'$.roomType')='private' ORDER BY created_at DESC,id LIMIT 100`).all(source.personId)
      : this.db.prepare(`SELECT * FROM work_items WHERE owner_person_id=? AND kind='reminder'
          AND json_extract(source_route_json,'$.channel')=? AND json_extract(source_route_json,'$.accountId')=?
          AND json_extract(source_route_json,'$.roomType')=? AND json_extract(source_route_json,'$.roomId')=?
          ORDER BY created_at DESC,id LIMIT 100`).all(source.personId,route.channel,route.accountId,route.roomType,route.roomId);
    return rows.map(row => this.mapWork(row));
  }

  getReminder(conversationId: string, sourceMessageId: string, workId: string): WorkItem {
    const source = this.source(conversationId, sourceMessageId);
    const row = this.db.prepare(`SELECT * FROM work_items WHERE id=? AND owner_person_id=? AND kind='reminder'`).get(workId, source.personId);
    if (!row || !this.visibleInSource(source.route, JSON.parse(String(row.source_route_json)) as ChannelRoute)) throw new MemoryError('提醒不存在。');
    return this.mapWork(row);
  }

  cancelReminder(conversationId: string, sourceMessageId: string, workId: string, expectedVersion: number): WorkItem {
    return this.transaction(() => {
      const source = this.source(conversationId, sourceMessageId);
      const row = this.db.prepare(`SELECT * FROM work_items WHERE id=? AND owner_person_id=? AND kind='reminder'`).get(workId, source.personId);
      if (!row || !this.visibleInSource(source.route, JSON.parse(String(row.source_route_json)) as ChannelRoute)) throw new MemoryError('提醒不存在。');
      if (!Number.isSafeInteger(expectedVersion) || Number(row.version) !== expectedVersion) throw new MemoryError('提醒版本已变化，请重新查询后重试。');
      if (row.status === 'cancelled') return this.mapWork(row);
      if (row.status === 'completed') {
        const now=Date.now();
        const notification=this.db.prepare('SELECT status FROM work_notifications WHERE work_id=?').get(workId);
        if (notification && notification.status !== 'queued') {
          this.event(workId,'cancel_after_notification_dispatch',now,'通知已开始发送或已结束，保留实际投递状态',sourceMessageId);
          return this.getWork(workId);
        }
        this.db.prepare(`UPDATE work_items SET status='cancelled',version=version+1,updated_at=? WHERE id=? AND version=?`).run(now,workId,expectedVersion);
        this.db.prepare(`UPDATE work_notifications SET status='rejected',updated_at=? WHERE work_id=? AND status='queued'`).run(now,workId);
        this.event(workId,'cancelled',now,'本人取消尚未发送的提醒通知',sourceMessageId);
        return this.getWork(workId);
      }
      const status = row.status === 'running' ? 'cancel_requested' : 'cancelled';
      const now = Date.now();
      this.db.prepare('UPDATE work_items SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(status, now, workId, expectedVersion);
      this.event(workId, status, now, '本人取消提醒', sourceMessageId);
      if (status === 'cancelled') this.db.prepare(`UPDATE work_attempts SET status='cancelled',finished_at=? WHERE work_id=? AND status='running'`).run(now, workId);
      return this.getWork(workId);
    });
  }

  claimDue(now: string | number, allowedRoutes: readonly ChannelRoute[]): ReminderLease | null {
    return this.transaction(() => {
      const at = this.toMs(now);
      const rows = this.db.prepare(`SELECT w.* FROM work_items w WHERE w.kind='reminder' AND w.status='scheduled' AND w.remind_at<=? ORDER BY w.remind_at,w.id LIMIT 20`).all(at);
      for (const row of rows) {
        const routeJson = String(row.source_route_json);
        const auth = this.db.prepare('SELECT * FROM work_authorizations WHERE work_id=?').get(String(row.id));
        let source: ReturnType<WorkLedgerStore['source']> | null = null;
        try { source = this.source(String(row.source_conversation_id), String(row.origin_message_id)); }
        catch (error) { if (!(error instanceof MemoryError)) throw error; }
        if (!source || !auth || auth.revoked_at != null || auth.owner_person_id !== source.personId || auth.source_actor_id !== source.actorId
          || auth.source_route_json !== routeJson || !allowedRoutes.some(route => routeKey(route) === routeKey(source.route))) {
          const time = Date.now();
          this.db.prepare(`UPDATE work_items SET status='waiting_user',version=version+1,updated_at=? WHERE id=? AND status='scheduled'`).run(time,String(row.id));
          this.event(String(row.id),'authorization_changed',time,'提醒来源身份或路由授权已变化',String(row.origin_message_id));
          continue;
        }
        const workId = String(row.id), attempt = Number(this.db.prepare('SELECT COALESCE(MAX(attempt),0)+1 AS n FROM work_attempts WHERE work_id=?').get(workId)?.n);
        const token = randomUUID(), leaseUntil = at + LEASE_MS;
        this.db.prepare(`INSERT INTO work_attempts VALUES(?,?,'running',?,?,?,NULL)`).run(workId,attempt,token,leaseUntil,at);
        this.db.prepare(`UPDATE work_items SET status='running',updated_at=? WHERE id=? AND status='scheduled' AND version=?`).run(at,workId,Number(row.version));
        this.event(workId,'claimed',at,null,null);
        return {workId,version:Number(row.version),attempt,token,goal:String(row.goal),route:JSON.parse(routeJson) as ChannelRoute,ownerPersonId:String(row.owner_person_id)};
      }
      return null;
    });
  }

  completeReminder(lease: ReminderLease, now: string | number, allowedRoutes: readonly ChannelRoute[]): WorkNotification {
    return this.transaction(() => {
      const at = this.toMs(now), row = this.assertLease(lease, at, allowedRoutes);
      this.db.prepare(`UPDATE work_items SET status='completed',updated_at=? WHERE id=? AND version=? AND status='running'`).run(at,lease.workId,lease.version);
      this.db.prepare(`UPDATE work_attempts SET status='completed',finished_at=? WHERE work_id=? AND attempt=? AND lease_token=?`).run(at,lease.workId,lease.attempt,lease.token);
      const event = this.event(lease.workId,'completed',at,null,null), id = randomUUID();
      const text = `提醒：${String(row.goal)}`;
      const route=JSON.parse(String(row.source_route_json)) as ChannelRoute;
      this.db.prepare(`INSERT INTO work_notifications VALUES(?,?,?,?,?,'queued',NULL,?,?)`).run(id,lease.workId,event,JSON.stringify(route),text,at,at);
      return this.getNotification(id);
    });
  }

  beginNotification(id: string, now: string | number, allowedRoutes: readonly ChannelRoute[]): WorkNotification {
    return this.transaction(() => {
      const at=this.toMs(now), row=this.db.prepare('SELECT * FROM work_notifications WHERE id=?').get(id);
      if (!row) throw new MemoryError('通知不存在。');
      if (row.status !== 'queued') throw new MemoryError('通知不处于可发送状态。');
      const work=this.db.prepare('SELECT * FROM work_items WHERE id=?').get(String(row.work_id));
      if(!work||work.status!=='completed') throw new MemoryError('提醒已取消或状态不可通知。');
      const auth=this.db.prepare('SELECT * FROM work_authorizations WHERE work_id=?').get(String(row.work_id));
      const routeJson=String(row.route_json);
      let source: ReturnType<WorkLedgerStore['source']> | null = null;
      try { source=this.source(String(work.source_conversation_id),String(work.origin_message_id)); }
      catch(error) { if(!(error instanceof MemoryError)) throw error; }
      if(!source||!auth||auth.revoked_at!=null||auth.owner_person_id!==source.personId||auth.source_actor_id!==source.actorId
        ||auth.source_route_json!==routeJson||!allowedRoutes.some(route=>routeKey(route)===routeKey(JSON.parse(routeJson) as ChannelRoute))) {
        this.db.prepare(`UPDATE work_notifications SET status='rejected',updated_at=? WHERE id=? AND status='queued'`).run(at,id);
        this.event(String(row.work_id),'authorization_changed',at,'通知发送前身份或路由授权已变化',String(work.origin_message_id));
        return this.getNotification(id);
      }
      this.db.prepare(`UPDATE work_notifications SET status='sending',lease_until=?,updated_at=? WHERE id=? AND status='queued'`).run(at+LEASE_MS,at,id);
      return this.getNotification(id);
    });
  }

  listPendingNotifications(limit = 20): WorkNotification[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MemoryError('待发送通知读取数量无效。');
    return this.db.prepare(`SELECT id FROM work_notifications WHERE status='queued' ORDER BY created_at,id LIMIT ?`).all(limit)
      .map(row => this.getNotification(String(row.id)));
  }

  ackNotification(id: string, outcome: NotificationOutcome, now: string | number): WorkNotification {
    return this.transaction(() => {
      if (!['sent','rejected','uncertain'].includes(outcome)) throw new MemoryError('通知回执状态无效。');
      const at=this.toMs(now), row=this.db.prepare('SELECT status FROM work_notifications WHERE id=?').get(id);
      if (!row) throw new MemoryError('通知不存在。');
      if (row.status !== 'sending') throw new MemoryError('通知尚未预约发送。');
      this.db.prepare('UPDATE work_notifications SET status=?,updated_at=? WHERE id=? AND status=\'sending\'').run(outcome,at,id);
      return this.getNotification(id);
    });
  }

  recoverAfterRestart(now: string | number): void {
    this.transaction(() => {
      const at=this.toMs(now);
      this.db.prepare(`UPDATE work_notifications SET status='uncertain',updated_at=? WHERE status='sending' AND lease_until<=?`).run(at,at);
      const attempts=this.db.prepare(`SELECT a.*,w.status AS work_status FROM work_attempts a JOIN work_items w ON w.id=a.work_id WHERE a.status='running' AND a.lease_until<=?`).all(at);
      for(const a of attempts){
        const next=a.work_status==='cancel_requested'?'cancelled':'scheduled';
        this.db.prepare(`UPDATE work_attempts SET status='interrupted',finished_at=? WHERE work_id=? AND attempt=?`).run(at,String(a.work_id),Number(a.attempt));
        this.db.prepare('UPDATE work_items SET status=?,version=version+1,updated_at=? WHERE id=?').run(next,at,String(a.work_id));
        this.event(String(a.work_id),'interrupted',at,'重启时工作租约未完成',null);
      }
    });
  }

  private validateInput(input: ReminderInput): void {
    if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'goal,key,remindAt,timezone') throw new MemoryError('提醒参数无效。');
    if (typeof input.key!=='string'||!input.key.trim()||input.key.length>128 || typeof input.goal!=='string'||!input.goal.trim()||input.goal.trim().length>MAX_GOAL
      || typeof input.remindAt!=='string'||input.remindAt.length>64||input.timezone!=='Asia/Shanghai') throw new MemoryError('提醒参数无效或超出长度限制。');
  }
  private source(conversationId: string, messageId: string): {personId:string;actorId:string;route:ChannelRoute} {
    const row=this.db.prepare(`SELECT m.actor_id,a.kind,ap.person_id,r.channel,r.account,r.external_chat_id,r.room_type
      FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN rooms r ON r.id=c.room_id
      JOIN actors a ON a.id=m.actor_id AND a.room_id=c.room_id LEFT JOIN actor_person_bindings ap ON ap.actor_id=a.id
      WHERE m.id=? AND m.conversation_id=? AND m.role='user'`).get(messageId,conversationId);
    if(!row||row.kind!=='external-user'||!row.person_id) throw new MemoryError('操作来源必须是当前绑定人物的真实用户消息。');
    return {personId:String(row.person_id),actorId:String(row.actor_id),route:{channel:String(row.channel),accountId:String(row.account),roomId:String(row.external_chat_id),roomType:row.room_type as ChannelRoute['roomType']}};
  }
  private event(workId:string,type:string,at:number,reason:string|null,sourceMessageId:string|null):number {
    const seq=Number(this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM work_events WHERE work_id=?').get(workId)?.n);
    this.db.prepare('INSERT INTO work_events VALUES(?,?,?,?,?,?)').run(workId,seq,type,at,reason,sourceMessageId); return seq;
  }
  private assertLease(lease:ReminderLease,at:number,allowedRoutes:readonly ChannelRoute[]):Record<string,unknown>{
    const row=this.db.prepare('SELECT * FROM work_items WHERE id=?').get(lease.workId);
    const attempt=this.db.prepare('SELECT * FROM work_attempts WHERE work_id=? AND attempt=?').get(lease.workId,lease.attempt);
    if(!row||!attempt||Number(row.version)!==lease.version||row.status!=='running'||attempt.status!=='running'||attempt.lease_token!==lease.token||Number(attempt.lease_until)<at) throw new MemoryError('提醒租约已失效。');
    const source=this.source(String(row.source_conversation_id),String(row.origin_message_id));
    const auth=this.db.prepare('SELECT * FROM work_authorizations WHERE work_id=?').get(lease.workId);
    const routeJson=String(row.source_route_json);
    if(source.personId!==lease.ownerPersonId||source.personId!==row.owner_person_id||!auth||auth.revoked_at!=null||source.actorId!==auth.source_actor_id
      ||auth.owner_person_id!==source.personId||auth.source_route_json!==routeJson||!allowedRoutes.some(route=>routeKey(route)===routeKey(source.route))) throw new MemoryError('提醒授权已变化。');
    return row;
  }
  private toMs(value:string|number):number { const ms=typeof value==='number'?value:Date.parse(value); if(!Number.isSafeInteger(ms)||!Number.isFinite(new Date(ms).getTime())||ms<0) throw new MemoryError('时间参数无效。'); return ms; }
  private isStrictIsoDate(value: string): boolean {
    const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if(!match) return false;
    const [,yearText,monthText,dayText,hourText,minuteText,secondText]=match;
    const year=Number(yearText),month=Number(monthText),day=Number(dayText),hour=Number(hourText),minute=Number(minuteText),second=Number(secondText);
    if(month<1||month>12||day<1||hour>23||minute>59||second>59) return false;
    const calendar=new Date(0); calendar.setUTCFullYear(year,month-1,day); calendar.setUTCHours(hour,minute,second,0);
    return calendar.getUTCFullYear()===year&&calendar.getUTCMonth()===month-1&&calendar.getUTCDate()===day
      &&Number.isFinite(Date.parse(value));
  }
  private visibleInSource(queryRoute:ChannelRoute,workRoute:ChannelRoute):boolean {
    return queryRoute.roomType==='private'&&workRoute.roomType==='private' || routeKey(queryRoute)===routeKey(workRoute);
  }
  private getWork(id:string):WorkItem { const row=this.db.prepare('SELECT * FROM work_items WHERE id=?').get(id); if(!row) throw new MemoryError('提醒不存在。'); return this.mapWork(row); }
  private getNotification(id:string):WorkNotification { const r=this.db.prepare('SELECT * FROM work_notifications WHERE id=?').get(id); if(!r) throw new MemoryError('通知不存在。'); return {id:String(r.id),workId:String(r.work_id),eventSeq:Number(r.event_seq),route:JSON.parse(String(r.route_json)) as ChannelRoute,text:String(r.text),status:r.status as WorkNotification['status']}; }
  private mapWork(r:Record<string,unknown>):WorkItem { return {id:String(r.id),ownerPersonId:String(r.owner_person_id),kind:'reminder',goal:String(r.goal),originMessageId:String(r.origin_message_id),sourceConversationId:String(r.source_conversation_id),sourceRoute:JSON.parse(String(r.source_route_json)) as ChannelRoute,status:r.status as WorkItem['status'],version:Number(r.version),remindAt:iso(Number(r.remind_at)),timezone:'Asia/Shanghai',createdAt:iso(Number(r.created_at)),updatedAt:iso(Number(r.updated_at))}; }
}

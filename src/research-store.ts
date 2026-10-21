import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { memoryWords } from './memory-text.js';
import { MemoryError } from './memory-types.js';
import type { ResearchBudget, ResearchDelivery, ResearchDeliveryStatus, ResearchEvidence, ResearchFinishInput,
  ResearchList, ResearchListParams, ResearchProgress, ResearchReadParams, ResearchReadResult, ResearchReport,
  ResearchStatus, ResearchTask, CreateResearchInput } from './research-types.js';
export type * from './research-types.js';

export function migrateResearch(db: DatabaseSync): void {
  db.exec(`CREATE TABLE research_tasks (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
    source_message_id TEXT NOT NULL REFERENCES messages(id), actor_id TEXT NOT NULL REFERENCES actors(id),
    person_id TEXT NOT NULL, item_key TEXT NOT NULL, input_json TEXT NOT NULL,
    title TEXT NOT NULL, goal TEXT NOT NULL, urls_json TEXT NOT NULL, requires_original INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','completed','partial','blocked','failed','interrupted')),
    attempt INTEGER NOT NULL CHECK(attempt>0), latest_version INTEGER, reason TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source_message_id,item_key));
  CREATE INDEX research_tasks_queue ON research_tasks(status,created_at);
  CREATE INDEX research_tasks_owner ON research_tasks(conversation_id,person_id,created_at);
  CREATE TABLE research_attempts (
    task_id TEXT NOT NULL REFERENCES research_tasks(id), attempt INTEGER NOT NULL CHECK(attempt>0),
    source_message_id TEXT NOT NULL REFERENCES messages(id), action_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','completed','partial','blocked','failed','interrupted')),
    budget_json TEXT, usage_json TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(task_id,attempt), UNIQUE(task_id,source_message_id,action_key));
  CREATE TABLE research_evidence (
    task_id TEXT NOT NULL, attempt INTEGER NOT NULL, ordinal INTEGER NOT NULL, evidence_json TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY(task_id,attempt,ordinal),
    FOREIGN KEY(task_id,attempt) REFERENCES research_attempts(task_id,attempt));
  CREATE TABLE research_reports (
    task_id TEXT NOT NULL REFERENCES research_tasks(id), version INTEGER NOT NULL CHECK(version>0),
    attempt INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('completed','partial')),
    abstract TEXT NOT NULL, keywords_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(task_id,version), FOREIGN KEY(task_id,attempt) REFERENCES research_attempts(task_id,attempt));
  CREATE VIRTUAL TABLE research_report_fts USING fts5(task_id UNINDEXED,title,abstract,keywords,tokenize='unicode61');
  CREATE TABLE research_deliveries (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES research_tasks(id), version INTEGER NOT NULL,
    source_message_id TEXT NOT NULL REFERENCES messages(id), kind TEXT NOT NULL CHECK(kind IN ('file','notice')),
    format TEXT NOT NULL, attempt INTEGER NOT NULL, text TEXT,
    status TEXT NOT NULL CHECK(status IN ('sending','sent','uncertain','rejected')),
    external_message_id TEXT, reference_index TEXT, message_id TEXT UNIQUE REFERENCES messages(id),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(task_id,source_message_id,kind,version,format,attempt));
  CREATE UNIQUE INDEX research_file_once ON research_deliveries(task_id,source_message_id,version) WHERE kind='file';`);
}

const timestamp = () => new Date().toISOString();
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const zeroUsage = () => ({ modelCalls: 0, toolCalls: 0, searchCalls: 0 });
function text(value: unknown, name: string, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || [...value].length > max) throw new MemoryError(`${name}无效或过长。`);
  return value.trim();
}
function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new MemoryError(`${name}无效。`);
  return value;
}
function validId(id: string): void {
  if (typeof id !== 'string' || !/^R[0-9a-f]{32}$/.test(id)) throw new MemoryError('研究编号无效。');
}
function validDay(day: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`))
    || new Date(`${day}T00:00:00Z`).toISOString().slice(0,10) !== day) throw new MemoryError('研究日期须为北京时间 YYYY-MM-DD。');
}

/** Research artifacts have their own ledger; none are written to chat, Topic or profiles here. */
export class ResearchStore {
  private readonly root: string;
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(operation: () => T) => T, dataDir: string) {
    this.root = join(resolve(dataDir), 'research');
  }

  private identity(conversationId: string, sourceMessageId: string): { actorId: string; personId: string } {
    const row = this.db.prepare(`SELECT m.actor_id,p.person_id FROM messages m
      JOIN conversations c ON c.id=m.conversation_id JOIN actors a ON a.id=m.actor_id AND a.room_id=c.room_id
      LEFT JOIN actor_person_bindings p ON p.actor_id=a.id
      WHERE m.id=? AND m.conversation_id=? AND m.role='user'`).get(sourceMessageId,conversationId);
    if (!row) throw new MemoryError('研究操作缺少当前房间的真人来源。');
    return { actorId: String(row.actor_id), personId: String(row.person_id ?? `actor:${row.actor_id}`) };
  }

  private authorized(conversationId: string, sourceMessageId: string, id: string): ResearchTask {
    validId(id);
    const person = this.identity(conversationId,sourceMessageId);
    const task = this.get(id);
    if (!task || this.identity(task.conversationId,task.sourceMessageId).personId !== person.personId) throw new MemoryError('没有属于你的该研究任务。');
    return task;
  }

  create(conversationId: string, sourceMessageId: string, input: CreateResearchInput): ResearchTask {
    const identity = this.identity(conversationId,sourceMessageId);
    const key = text(input.key,'研究条目标识',80), title = text(input.title,'研究标题',160), goal = text(input.goal,'研究目标',6000);
    if (input.requiresOriginal !== undefined && typeof input.requiresOriginal !== 'boolean') throw new MemoryError('原文要求无效。');
    if (input.urls !== undefined && (!Array.isArray(input.urls) || input.urls.length > 10)) throw new MemoryError('研究链接最多10个。');
    const urls = (input.urls ?? []).map(value => {
      const source = text(value,'研究链接',2048); let parsed: URL;
      try { parsed = new URL(source); } catch { throw new MemoryError('研究链接无效。'); }
      if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new MemoryError('研究链接仅支持无凭据的 HTTP/HTTPS。');
      return source;
    });
    const requiresOriginal = input.requiresOriginal ?? false;
    const serialized = JSON.stringify({ title, goal, urls, requiresOriginal });
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id,input_json FROM research_tasks WHERE source_message_id=? AND item_key=?').get(sourceMessageId,key);
      if (existing) {
        if (existing.input_json !== serialized) throw new MemoryError('同一来源的研究条目标识已用于不同内容。');
        return this.get(String(existing.id))!;
      }
      const id = `R${randomUUID().replaceAll('-','')}`, createdAt = timestamp();
      this.db.prepare(`INSERT INTO research_tasks(id,conversation_id,source_message_id,actor_id,person_id,item_key,input_json,
        title,goal,urls_json,requires_original,status,attempt,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',1,?,?)`)
        .run(id,conversationId,sourceMessageId,identity.actorId,identity.personId,key,serialized,title,goal,JSON.stringify(urls),requiresOriginal?1:0,createdAt,createdAt);
      this.db.prepare(`INSERT INTO research_attempts(task_id,attempt,source_message_id,action_key,status,usage_json,created_at,updated_at)
        VALUES(?,1,?,?,'queued',?,?,?)`).run(id,sourceMessageId,key,JSON.stringify(zeroUsage()),createdAt,createdAt);
      this.updateIndex(id);
      return this.get(id)!;
    });
  }

  list(conversationId: string, sourceMessageId: string, params: ResearchListParams = {}): ResearchList {
    const owner = this.identity(conversationId,sourceMessageId);
    const limit = integer(params.limit ?? 10,'清单数量',1,30), offset = integer(params.offset ?? 0,'清单位置',0,1_000_000);
    const bindings: (string | number)[] = [owner.personId];
    // Resolve trusted current identity bindings, including tasks created before a
    // person's group/private identities were explicitly linked. The stored person
    // remains the original ownership snapshot for audit, not an authorization cache.
    let where = "coalesce(owner.person_id,'actor:' || t.actor_id)=?";
    if (params.date !== undefined) { validDay(params.date); where += ` AND date(t.created_at,'+8 hours')=?`; bindings.push(params.date); }
    let from = 'research_tasks t LEFT JOIN actor_person_bindings owner ON owner.actor_id=t.actor_id', order = 't.created_at DESC,t.id DESC';
    if (params.query !== undefined && params.query.trim()) {
      const words = [...new Set(memoryWords(text(params.query,'研究查询',300)))];
      if (!words.length) return { total: 0, offset, items: [] };
      from += ' JOIN research_report_fts ON research_report_fts.task_id=t.id';
      where += ' AND research_report_fts MATCH ?'; bindings.push(words.map(word => `"${word.replaceAll('"','""')}"`).join(' OR '));
      order = 'bm25(research_report_fts),t.created_at DESC,t.id DESC';
    }
    const total = Number(this.db.prepare(`SELECT count(*) AS count FROM ${from} WHERE ${where}`).get(...bindings)?.count ?? 0);
    const rows = this.db.prepare(`SELECT t.id,t.title,t.status,t.created_at,t.latest_version,t.reason,
      (SELECT abstract FROM research_reports r WHERE r.task_id=t.id AND r.version=t.latest_version) AS abstract
      FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...bindings,limit,offset);
    return { total, offset, ...(offset+rows.length < total ? { nextOffset: offset+rows.length } : {}), items: rows.map(row => ({
      id:String(row.id),title:String(row.title),status:row.status as ResearchStatus,createdAt:String(row.created_at),
      ...(row.latest_version == null ? {} : {reportVersion:Number(row.latest_version)}),
      ...(row.abstract == null ? {} : {abstract:String(row.abstract)}), ...(row.reason == null ? {} : {reason:String(row.reason)}),
    })) };
  }

  get(id: string): ResearchTask | undefined {
    validId(id);
    const row = this.db.prepare(`SELECT t.*,a.budget_json,a.usage_json,r.channel,r.account,r.room_type,r.external_chat_id,
      m.text AS original_text,x.external_user_id FROM research_tasks t
      JOIN research_attempts a ON a.task_id=t.id AND a.attempt=t.attempt
      JOIN conversations c ON c.id=t.conversation_id JOIN rooms r ON r.id=c.room_id
      JOIN messages m ON m.id=t.source_message_id JOIN actors x ON x.id=t.actor_id WHERE t.id=?`).get(id);
    if (!row) return undefined;
    const evidence = this.db.prepare('SELECT evidence_json FROM research_evidence WHERE task_id=? ORDER BY attempt,ordinal').all(id)
      .map(item => JSON.parse(String(item.evidence_json)) as ResearchEvidence);
    return { id, conversationId:String(row.conversation_id), sourceMessageId:String(row.source_message_id),
      actorId:String(row.actor_id),personId:String(row.person_id),
      route:{channel:String(row.channel),accountId:String(row.account),roomId:String(row.external_chat_id),roomType:row.room_type as 'group'|'private'},
      senderId:String(row.external_user_id),originalText:String(row.original_text),title:String(row.title),goal:String(row.goal),
      urls:JSON.parse(String(row.urls_json)) as string[],requiresOriginal:Boolean(row.requires_original),status:row.status as ResearchStatus,
      attempt:Number(row.attempt),createdAt:String(row.created_at),updatedAt:String(row.updated_at),
      ...(row.latest_version == null ? {} : {reportVersion:Number(row.latest_version)}),
      ...(row.reason == null ? {} : {reason:String(row.reason)}),
      ...(row.budget_json == null ? {} : {budget:JSON.parse(String(row.budget_json)) as ResearchBudget}),
      usage:JSON.parse(String(row.usage_json)),evidence };
  }

  queued(conversationIds?: readonly string[]): ResearchTask[] {
    const ids = this.db.prepare("SELECT id,conversation_id FROM research_tasks WHERE status='queued' ORDER BY created_at,id").all()
      .filter(row => !conversationIds || conversationIds.includes(String(row.conversation_id))).map(row => String(row.id));
    return ids.map(id => this.get(id)!);
  }

  pendingNotifications(conversationIds?: readonly string[]): ResearchTask[] {
    const rows = this.db.prepare(`SELECT t.id,t.conversation_id FROM research_tasks t
      WHERE t.status NOT IN ('queued','running') AND NOT EXISTS (
        SELECT 1 FROM research_deliveries d WHERE d.task_id=t.id AND d.attempt=t.attempt AND d.kind='notice')
      ORDER BY t.updated_at,t.id`).all();
    return rows.filter(row => !conversationIds || conversationIds.includes(String(row.conversation_id))).map(row => this.get(String(row.id))!);
  }

  claim(id: string, budget: ResearchBudget): ResearchTask | undefined {
    validId(id);
    integer(budget.maxModelCalls,'研究模型次数',1,100); integer(budget.maxToolCalls,'研究工具次数',1,200); integer(budget.maxSearchCalls,'研究搜索次数',0,100);
    return this.transaction(() => {
      const task = this.get(id);
      if (!task || task.status !== 'queued') return undefined;
      const at = timestamp();
      this.db.prepare("UPDATE research_attempts SET status='running',budget_json=?,updated_at=? WHERE task_id=? AND attempt=? AND status='queued'")
        .run(JSON.stringify(budget),at,id,task.attempt);
      this.db.prepare("UPDATE research_tasks SET status='running',updated_at=? WHERE id=? AND status='queued'").run(at,id);
      return this.get(id)!;
    });
  }

  checkpoint(id: string, attempt: number, progress: ResearchProgress): void {
    this.transaction(() => {
      const task = this.running(id,attempt);
      if (!task.budget) throw new MemoryError('研究预算未保存。');
      for (const [key,max] of [['modelCalls',task.budget.maxModelCalls],['toolCalls',task.budget.maxToolCalls],['searchCalls',task.budget.maxSearchCalls]] as const) {
        integer(progress[key],key,task.usage[key],max);
      }
      const at = timestamp(), error = progress.error === undefined ? null : text(progress.error,'研究错误',2000);
      if (progress.evidence !== undefined) {
        const evidence = JSON.stringify(progress.evidence);
        if (Buffer.byteLength(evidence,'utf8') > 128_000) throw new MemoryError('单份研究证据过长。');
        const total = Number(this.db.prepare('SELECT coalesce(sum(length(CAST(evidence_json AS BLOB))),0) AS bytes FROM research_evidence WHERE task_id=?').get(id)?.bytes ?? 0);
        if (total + Buffer.byteLength(evidence,'utf8') > 4_000_000) throw new MemoryError('研究资料存储已达单任务上限。');
        const ordinal = Number(this.db.prepare('SELECT coalesce(max(ordinal),0)+1 AS ordinal FROM research_evidence WHERE task_id=? AND attempt=?').get(id,attempt)?.ordinal);
        this.db.prepare('INSERT INTO research_evidence VALUES(?,?,?,?,?)').run(id,attempt,ordinal,evidence,at);
      }
      this.db.prepare('UPDATE research_attempts SET usage_json=?,reason=coalesce(?,reason),updated_at=? WHERE task_id=? AND attempt=?')
        .run(JSON.stringify({modelCalls:progress.modelCalls,toolCalls:progress.toolCalls,searchCalls:progress.searchCalls}),error,at,id,attempt);
      this.db.prepare('UPDATE research_tasks SET updated_at=? WHERE id=?').run(at,id);
    });
  }

  finish(id: string, attempt: number, input: ResearchFinishInput): ResearchTask {
    const task = this.running(id,attempt);
    if (!['completed','partial','blocked','failed','interrupted'].includes(input.status)) throw new MemoryError('研究结束状态无效。');
    const reason = input.reason === undefined ? null : text(input.reason,'研究说明',2000);
    let report: { version:number; abstract:string; keywords:string[]; hash:string; at:string } | undefined;
    if (input.markdown !== undefined) {
      if (input.status !== 'completed' && input.status !== 'partial') throw new MemoryError('只有完整或阶段性报告可归档。');
      const markdown = text(input.markdown,'研究报告',200_000), abstract = text(input.abstract,'报告摘要',1200);
      const keywords = input.keywords ?? [];
      if (!Array.isArray(keywords) || keywords.length > 20) throw new MemoryError('报告关键词过多。');
      const normalizedKeywords = keywords.map(item => text(item,'报告关键词',60));
      // A crash can leave an immutable file without a committed report row. Keep
      // that evidence and allocate above it instead of overwriting or getting stuck.
      this.artifactPath(id,1,'md');
      const directory = join(this.root,id);
      const orphanVersions = existsSync(directory) ? readdirSync(directory).flatMap(name => {
        const match = /^(\d+)\.(?:md|txt)$/.exec(name);
        return match ? [Number(match[1])] : [];
      }) : [];
      const version = Math.max(Number(this.db.prepare('SELECT coalesce(max(version),0) AS version FROM research_reports WHERE task_id=?').get(id)?.version), ...orphanVersions) + 1;
      this.saveFile(id,version,'md',Buffer.from(markdown,'utf8'));
      this.saveFile(id,version,'txt',Buffer.from(markdown,'utf8'));
      report = {version,abstract,keywords:normalizedKeywords,hash:digest(markdown),at:timestamp()};
    } else if (input.status === 'completed' || input.status === 'partial') throw new MemoryError('完成状态必须先保存报告正文。');
    return this.transaction(() => {
      this.running(id,attempt);
      const at = timestamp();
      if (report) this.db.prepare('INSERT INTO research_reports VALUES(?,?,?,?,?,?,?,?)')
        .run(id,report.version,attempt,input.status,report.abstract,JSON.stringify(report.keywords),report.hash,report.at);
      this.db.prepare('UPDATE research_attempts SET status=?,reason=?,updated_at=? WHERE task_id=? AND attempt=?')
        .run(input.status,reason,at,id,attempt);
      this.db.prepare('UPDATE research_tasks SET status=?,reason=?,latest_version=coalesce(?,latest_version),updated_at=? WHERE id=?')
        .run(input.status,reason,report?.version ?? null,at,id);
      this.updateIndex(id);
      return this.get(id)!;
    });
  }

  retry(conversationId: string, sourceMessageId: string, input: { id:string; key:string }): ResearchTask {
    const key = text(input.key,'研究续作标识',80);
    return this.transaction(() => {
      const task = this.authorized(conversationId,sourceMessageId,input.id);
      const existing = this.db.prepare('SELECT attempt FROM research_attempts WHERE task_id=? AND source_message_id=? AND action_key=?').get(task.id,sourceMessageId,key);
      if (existing) return task;
      if (task.status === 'queued' || task.status === 'running') throw new MemoryError('该研究正在排队或进行中，无需重复创建。');
      const attempt = task.attempt+1, at = timestamp();
      this.db.prepare('INSERT INTO research_attempts(task_id,attempt,source_message_id,action_key,status,usage_json,created_at,updated_at) VALUES(?,?,?,?,\'queued\',?,?,?)')
        .run(task.id,attempt,sourceMessageId,key,JSON.stringify(zeroUsage()),at,at);
      this.db.prepare("UPDATE research_tasks SET attempt=?,status='queued',reason=NULL,updated_at=? WHERE id=?").run(attempt,at,task.id);
      return this.get(task.id)!;
    });
  }

  recover(conversationIds?: readonly string[]): void {
    this.transaction(() => {
      const tasks = this.db.prepare("SELECT id,conversation_id,attempt FROM research_tasks WHERE status='running'").all();
      const at = timestamp(), reason = '服务中断；已保存资料与调用计数，需明确要求继续，不自动重发未知模型请求。';
      for (const row of tasks) {
        if (conversationIds && !conversationIds.includes(String(row.conversation_id))) continue;
        this.db.prepare("UPDATE research_tasks SET status='interrupted',reason=?,updated_at=? WHERE id=?").run(reason,at,String(row.id));
        this.db.prepare("UPDATE research_attempts SET status='interrupted',reason=?,updated_at=? WHERE task_id=? AND attempt=?").run(reason,at,String(row.id),Number(row.attempt));
      }
      if (conversationIds) {
        for (const id of conversationIds) this.db.prepare("UPDATE research_deliveries SET status='uncertain',updated_at=? WHERE status='sending' AND task_id IN(SELECT id FROM research_tasks WHERE conversation_id=?)").run(at,id);
      } else this.db.prepare("UPDATE research_deliveries SET status='uncertain',updated_at=? WHERE status='sending'").run(at);
    });
  }

  read(conversationId: string, sourceMessageId: string, params: ResearchReadParams): ResearchReadResult {
    const task = this.authorized(conversationId,sourceMessageId,params.id);
    const offset = integer(params.offset ?? 0,'报告读取位置',0,200_000), limit = integer(params.limit ?? 4000,'报告读取长度',1,6000);
    const version = params.version ?? task.reportVersion;
    if (version === undefined) return { id:task.id,title:task.title,status:task.status,createdAt:task.createdAt,text:'报告尚未生成。',offset:0,totalChars:0,...(task.reason ? {reason:task.reason} : {}) };
    const report = this.report(task.id,version);
    const points = [...report.markdown], end = Math.min(points.length,offset+limit);
    return { id:task.id,version,title:task.title,status:task.status,abstract:report.abstract,createdAt:report.createdAt,
      text:points.slice(offset,end).join(''),offset,totalChars:points.length,
      ...(end < points.length ? {nextOffset:end} : {}),...(task.reason ? {reason:task.reason} : {}) };
  }

  report(id: string, version: number): ResearchReport {
    validId(id); integer(version,'报告版本',1,1_000_000);
    const row = this.db.prepare('SELECT r.*,t.title FROM research_reports r JOIN research_tasks t ON t.id=r.task_id WHERE r.task_id=? AND r.version=?').get(id,version);
    if (!row) throw new MemoryError('该版本的研究报告不存在。');
    const data = this.readFile(id,version,'md');
    if (digest(data) !== row.content_hash) throw new Error('研究报告校验失败，保留文件供检查。');
    return {id,version,title:String(row.title),abstract:String(row.abstract),keywords:JSON.parse(String(row.keywords_json)),createdAt:String(row.created_at),status:row.status as 'completed'|'partial',markdown:data.toString('utf8')};
  }

  reserveDelivery(conversationId: string, sourceMessageId: string, input: { id:string; version?:number; format:'txt'|'md' }): ResearchDelivery {
    const task = this.authorized(conversationId,sourceMessageId,input.id);
    if (!['txt','md'].includes(input.format)) throw new MemoryError('报告文件格式须为 txt 或 md。');
    const version = input.version ?? task.reportVersion;
    if (version === undefined) throw new MemoryError('该任务尚无可发送的报告。');
    const report = this.report(task.id,version);
    const data = this.readFile(task.id,version,input.format);
    if (digest(data) !== digest(report.markdown)) throw new Error('报告导出文件校验失败。');
    const body = `研究报告《${task.title}》（${task.id}，版本 ${version}）。`;
    const reservation = this.reserve(task,sourceMessageId,'file',version,input.format,0,body);
    return {...reservation, ...(reservation.shouldSend ? {text:body,file:{name:`${task.id}-v${version}.${input.format}`,data}} : {})};
  }

  reserveNotification(id: string, attempt: number, notificationText: string): ResearchDelivery {
    const task = this.get(id);
    if (!task || task.attempt !== attempt || task.status === 'queued' || task.status === 'running') throw new MemoryError('研究通知的任务状态无效。');
    const body = text(notificationText,'研究通知',2000);
    const reservation = this.reserve(task,task.sourceMessageId,'notice',task.reportVersion ?? 0,'text',attempt,body);
    return {...reservation,...(reservation.shouldSend ? {text:body} : {})};
  }

  private reserve(task: ResearchTask, sourceMessageId: string, kind:'file'|'notice',version:number,format:string,attempt:number,body?:string): ResearchDelivery {
    return this.transaction(() => {
      const destination = this.db.prepare(`SELECT r.channel,r.account,r.room_type,r.external_chat_id FROM messages m
        JOIN conversations c ON c.id=m.conversation_id JOIN rooms r ON r.id=c.room_id
        WHERE m.id=? AND m.role='user'`).get(sourceMessageId);
      if (!destination) throw new MemoryError('研究投递缺少真实请求来源。');
      const route = { channel:String(destination.channel),accountId:String(destination.account),
        roomType:destination.room_type as 'group'|'private',roomId:String(destination.external_chat_id) };
      const row = kind === 'file'
        ? this.db.prepare("SELECT id,status,text FROM research_deliveries WHERE task_id=? AND source_message_id=? AND kind='file' AND version=?").get(task.id,sourceMessageId,version)
        : this.db.prepare(`SELECT id,status,text FROM research_deliveries WHERE task_id=? AND source_message_id=? AND kind=? AND version=? AND format=? AND attempt=?`)
          .get(task.id,sourceMessageId,kind,version,format,attempt);
      if (row) return {deliveryId:String(row.id),status:row.status as ResearchDeliveryStatus,shouldSend:false,reportId:task.id,version,route};
      const deliveryId = randomUUID(), at = timestamp();
      this.db.prepare('INSERT INTO research_deliveries(id,task_id,version,source_message_id,kind,format,attempt,text,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,\'sending\',?,?)')
        .run(deliveryId,task.id,version,sourceMessageId,kind,format,attempt,body ?? null,at,at);
      return {deliveryId,status:'sending',shouldSend:true,reportId:task.id,version,route};
    });
  }

  finishDelivery(deliveryId: string, status:'sent'|'uncertain'|'rejected', externalMessageId?: string, referenceIndex?: string): void {
    if (!['sent','uncertain','rejected'].includes(status)) throw new MemoryError('报告投递状态无效。');
    if (status === 'sent') text(externalMessageId,'平台消息编号',1000);
    if (referenceIndex !== undefined) text(referenceIndex,'平台引用编号',1000);
    this.transaction(() => {
      const row = this.db.prepare(`SELECT d.*,source.conversation_id,t.title FROM research_deliveries d
        JOIN research_tasks t ON t.id=d.task_id JOIN messages source ON source.id=d.source_message_id WHERE d.id=?`).get(deliveryId);
      if (!row || row.status !== 'sending') throw new MemoryError('报告投递已确认或不存在，拒绝覆盖。');
      const at = timestamp(); let messageId: string | null = null;
      if (status === 'sent') {
        const body = row.kind === 'notice' ? String(row.text)
          : `已发送研究报告《${row.title}》（${row.task_id}，版本 ${row.version}，${row.format} 文件）。`;
        messageId = randomUUID();
        this.db.prepare(`INSERT INTO messages(id,conversation_id,role,text,created_at,message_kind)
          VALUES(?,?,'assistant',?,?,'chat')`).run(messageId,String(row.conversation_id),body,at);
        // Only the successfully delivered short receipt joins rolling chat context.
        this.db.prepare('INSERT INTO conversation_context_messages(message_id,conversation_id) VALUES(?,?)')
          .run(messageId,String(row.conversation_id));
      }
      this.db.prepare("UPDATE research_deliveries SET status=?,external_message_id=?,reference_index=?,message_id=?,updated_at=? WHERE id=? AND status='sending'")
        .run(status,externalMessageId ?? null,referenceIndex ?? null,messageId,at,deliveryId);
    });
  }

  private running(id: string, attempt: number): ResearchTask {
    const task = this.get(id);
    if (!task || task.status !== 'running' || task.attempt !== attempt) throw new MemoryError('研究任务状态或执行批次已改变，拒绝迟到写入。');
    return task;
  }

  private updateIndex(id: string): void {
    const row = this.db.prepare(`SELECT t.title,r.abstract,r.keywords_json FROM research_tasks t
      LEFT JOIN research_reports r ON r.task_id=t.id AND r.version=t.latest_version WHERE t.id=?`).get(id)!;
    this.db.prepare('DELETE FROM research_report_fts WHERE task_id=?').run(id);
    const tokens = (value: unknown) => memoryWords(String(value ?? '')).join(' ');
    this.db.prepare('INSERT INTO research_report_fts(task_id,title,abstract,keywords) VALUES(?,?,?,?)')
      .run(id,tokens(row.title),tokens(row.abstract),tokens(row.keywords_json));
  }

  private artifactPath(id:string,version:number,format:'md'|'txt'): string {
    validId(id); integer(version,'报告版本',1,1_000_000);
    if (!['md','txt'].includes(format)) throw new MemoryError('报告格式无效。');
    for (const directory of [this.root,join(this.root,id)]) {
      if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) throw new Error('研究档案目录不能是符号链接或文件。');
    }
    return join(this.root,id,`${version}.${format}`);
  }

  private saveFile(id:string,version:number,format:'md'|'txt',data:Buffer): void {
    const filename = this.artifactPath(id,version,format);
    mkdirSync(dirname(filename),{recursive:true,mode:0o700});
    if (existsSync(filename)) {
      if (digest(this.readFile(id,version,format)) !== digest(data)) throw new Error('报告版本文件已存在且内容不同，拒绝覆盖。');
      return;
    }
    const handle = openSync(filename,'wx',0o600);
    try { writeFileSync(handle,data); fsyncSync(handle); } finally { closeSync(handle); }
    // Directory syncing is supported on POSIX; Windows refuses directory handles.
    if (process.platform !== 'win32') {
      for (const path of [dirname(filename),this.root,dirname(this.root)]) {
        const directory = openSync(path,'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    }
  }

  private readFile(id:string,version:number,format:'md'|'txt'): Buffer {
    const filename = this.artifactPath(id,version,format), stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) throw new Error('研究档案文件无效或过大。');
    return readFileSync(filename);
  }
}

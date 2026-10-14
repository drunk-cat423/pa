import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MemoryError, type PrimaryPerson } from './memory-types.js';
import type { AutoMemoryJob, AutoMemoryMessage, AutoMemoryReason, AutoMemoryTaskInput, PersonProfile, ProfileFact, TopicEmbedding, TopicRecord, TopicSearch, ValidatedExtract } from './auto-memory-types.js';
import { SelfProfileStore } from './self-profile-store.js';

const timestamp = () => new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
export const sameFact = (a:ProfileFact,b:ProfileFact) => a.content===b.content && a.field===b.field && a.sourceType===b.sourceType
  && (a.occurredAt??null)===(b.occurredAt??null) && (a.expiresAt??null)===(b.expiresAt??null)
  && JSON.stringify([...a.messageIds].sort())===JSON.stringify([...b.messageIds].sort());

/** Called inside the conversation store's migration transaction. */
export function migrateAutoMemory(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE messages ADD COLUMN ingest_seq INTEGER;
    ALTER TABLE messages ADD COLUMN sent_at TEXT;
    CREATE TABLE message_ingest_order (seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE REFERENCES messages(id));
    INSERT INTO message_ingest_order (seq,message_id) SELECT rowid,id FROM messages ORDER BY rowid;
    UPDATE messages SET ingest_seq = (SELECT seq FROM message_ingest_order WHERE message_id = messages.id);
    CREATE UNIQUE INDEX message_ingest_sequence ON messages(ingest_seq);
    CREATE TRIGGER assign_message_sequence AFTER INSERT ON messages BEGIN
      INSERT INTO message_ingest_order(message_id) VALUES (NEW.id);
      UPDATE messages SET ingest_seq = last_insert_rowid() WHERE id = NEW.id;
    END;
    CREATE TABLE persons (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE person_bindings (
      channel TEXT NOT NULL, account TEXT NOT NULL, room_type TEXT NOT NULL, room_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      person_id TEXT NOT NULL REFERENCES persons(id), PRIMARY KEY(channel,account,room_type,room_id,sender_id));
    CREATE TABLE actor_person_bindings (actor_id TEXT PRIMARY KEY REFERENCES actors(id), person_id TEXT NOT NULL REFERENCES persons(id));
    CREATE TABLE person_profile_revisions (
      person_id TEXT NOT NULL REFERENCES persons(id), revision INTEGER NOT NULL, facts_json TEXT NOT NULL,
      job_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY(person_id,revision));
    CREATE TABLE auto_memory_checkpoints (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), initial_seq INTEGER NOT NULL, completed_seq INTEGER NOT NULL,
      summary TEXT, summary_job_id TEXT);
    INSERT INTO auto_memory_checkpoints SELECT c.id, COALESCE(MAX(m.ingest_seq),0), COALESCE(MAX(m.ingest_seq),0),NULL,NULL
      FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id GROUP BY c.id;
    CREATE TABLE auto_memory_jobs (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), reason TEXT NOT NULL CHECK(reason IN ('count','capacity')),
      status TEXT NOT NULL CHECK(status IN ('queued','running','failed','done')), start_seq INTEGER NOT NULL,end_seq INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_owner TEXT, lease_until INTEGER, error TEXT,input_json TEXT,progress_json TEXT,
      created_at TEXT NOT NULL, completed_at TEXT);
    CREATE INDEX auto_memory_jobs_order ON auto_memory_jobs(conversation_id,start_seq);
    CREATE TABLE auto_memory_job_messages (
      job_id TEXT NOT NULL REFERENCES auto_memory_jobs(id),message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
      ordinal INTEGER NOT NULL,PRIMARY KEY(job_id,message_id));
    CREATE TABLE memory_topics (
      id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),job_id TEXT NOT NULL REFERENCES auto_memory_jobs(id),
      summary TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,content_hash TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE memory_topic_messages (topic_id TEXT NOT NULL REFERENCES memory_topics(id),message_id TEXT NOT NULL REFERENCES messages(id),PRIMARY KEY(topic_id,message_id));
    CREATE TABLE person_fragments (
      id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES persons(id),job_id TEXT NOT NULL REFERENCES auto_memory_jobs(id),
      topic_id TEXT REFERENCES memory_topics(id),content TEXT NOT NULL,source_type TEXT NOT NULL CHECK(source_type IN ('self','third_party','inference')),created_at TEXT NOT NULL);
    CREATE TABLE person_fragment_messages (fragment_id TEXT NOT NULL REFERENCES person_fragments(id),message_id TEXT NOT NULL REFERENCES messages(id),PRIMARY KEY(fragment_id,message_id));
    CREATE TABLE topic_embeddings (
      topic_id TEXT PRIMARY KEY REFERENCES memory_topics(id),model TEXT NOT NULL,dimensions INTEGER NOT NULL,input_version INTEGER NOT NULL,
      topic_version INTEGER NOT NULL,content_hash TEXT NOT NULL,vector_json TEXT NOT NULL,updated_at TEXT NOT NULL);
  `);
  const store = new AutoMemoryStore(db);
  const primary = db.prepare('SELECT DISTINCT person_id FROM primary_person_bindings').all();
  for (const row of primary) store.ensurePerson(String(row.person_id));
  db.exec('INSERT INTO person_bindings SELECT * FROM primary_person_bindings');
  for (const row of db.prepare('SELECT id FROM actors').all()) store.ensureActorPerson(String(row.id));
  db.exec(`UPDATE memories SET person_id=(SELECT person_id FROM actor_person_bindings WHERE actor_id=memories.subject_actor_id)
    WHERE person_id IS NULL AND scope_type='actor';`);
  for (const row of db.prepare(`SELECT DISTINCT person_id FROM memories WHERE person_id IS NOT NULL`).all()) store.ensurePerson(String(row.person_id));
  store.syncExplicitProfiles();
}

export class AutoMemoryStore {
  readonly selfProfile: SelfProfileStore;
  constructor(private readonly db: DatabaseSync, private readonly transaction?: <T>(operation: () => T) => T) {
    this.selfProfile = new SelfProfileStore(db, operation => this.atomic(operation));
  }
  private atomic<T>(operation: () => T): T {
    if (this.transaction) return this.transaction(operation);
    this.db.exec('SAVEPOINT auto_memory_operation');
    try { const result = operation(); this.db.exec('RELEASE SAVEPOINT auto_memory_operation'); return result; }
    catch (error) { this.db.exec('ROLLBACK TO SAVEPOINT auto_memory_operation; RELEASE SAVEPOINT auto_memory_operation'); throw error; }
  }
  ensurePerson(id: string): void {
    this.db.prepare('INSERT OR IGNORE INTO persons(id,created_at) VALUES (?,?)').run(id,timestamp());
  }
  ensureActorPerson(actorId: string): string {
    const existing = this.personForActor(actorId);
    if (existing) return existing;
    const actor = this.db.prepare(`SELECT b.person_id FROM actors a LEFT JOIN rooms r ON r.id=a.room_id
      LEFT JOIN person_bindings b ON b.channel=r.channel AND b.account=r.account AND b.room_type=r.room_type
      AND b.room_id=r.external_chat_id AND b.sender_id=a.external_user_id WHERE a.id=?`).get(actorId);
    if (!actor) throw new Error('人物身份不存在。');
    const personId = actor.person_id == null ? `actor:${actorId}` : String(actor.person_id);
    this.ensurePerson(personId);
    this.db.prepare('INSERT INTO actor_person_bindings VALUES (?,?)').run(actorId,personId);
    return personId;
  }
  personForActor(actorId: string): string | undefined {
    const row = this.db.prepare('SELECT person_id FROM actor_person_bindings WHERE actor_id=?').get(actorId);
    return row ? String(row.person_id) : undefined;
  }
  configurePersons(persons: readonly PrimaryPerson[]): void {
    const keys = new Set<string>();
    for (const person of persons) {
      if (!person || typeof person.id !== 'string' || !person.id.trim() || person.id.length>512 || !Array.isArray(person.bindings)) throw new Error('人物配置无效。');
      for (const binding of person.bindings) {
        const r = binding?.route;
        if (!r || ![r.channel,r.accountId,r.roomId,binding.senderId].every(v=>typeof v==='string' && v.length>0 && v.length<=512) || !['group','private'].includes(r.roomType)) throw new Error('人物绑定无效。');
        const key=JSON.stringify([r.channel,r.accountId,r.roomType,r.roomId,binding.senderId]);
        if(keys.has(key)) throw new Error('人物绑定不能重复。'); keys.add(key);
      }
    }
    this.atomic(()=>{
      this.db.exec('DROP INDEX active_person_profile');
      this.db.exec('DELETE FROM person_bindings');
      for (const person of persons) {
        this.ensurePerson(person.id);
        for(const b of person.bindings) this.db.prepare('INSERT INTO person_bindings VALUES (?,?,?,?,?,?)').run(b.route.channel,b.route.accountId,b.route.roomType,b.route.roomId,b.senderId,person.id);
      }
      for(const a of this.db.prepare(`SELECT a.id,b.person_id FROM actors a LEFT JOIN rooms r ON r.id=a.room_id LEFT JOIN person_bindings b
        ON b.channel=r.channel AND b.account=r.account AND b.room_type=r.room_type AND b.room_id=r.external_chat_id AND b.sender_id=a.external_user_id`).all()) {
        const id=String(a.id); const previous=this.personForActor(id); const next=a.person_id==null?`actor:${id}`:String(a.person_id);
        this.ensurePerson(next);
        this.db.prepare('INSERT INTO actor_person_bindings VALUES (?,?) ON CONFLICT(actor_id) DO UPDATE SET person_id=excluded.person_id').run(id,next);
        if(previous===`actor:${id}` && next!==previous) {
          this.db.prepare('UPDATE memories SET person_id=? WHERE subject_actor_id=? AND person_id=?').run(next,id,previous);
          const old=this.profile(previous); const target=this.profile(next);
          const transferable=old.facts.filter(f=>!target.facts.some(current=>sameFact(current,f)||(f.field!==undefined&&current.field===f.field)));
          if(transferable.length) this.writeProfile({...target,facts:[...target.facts,...transferable]},null);
        }
      }
      const seen=new Set<string>();
      for(const row of this.db.prepare(`SELECT id,person_id,profile_field FROM memories WHERE person_id IS NOT NULL AND status='active'
        AND is_current=1 AND profile_field IS NOT NULL AND writer_actor_id=subject_actor_id ORDER BY updated_at DESC,rowid DESC`).all()) {
        const key=JSON.stringify([row.person_id,row.profile_field]);
        if(seen.has(key)) {
          this.db.prepare('UPDATE memories SET is_current=0 WHERE id=?').run(String(row.id));
          this.db.prepare("UPDATE memory_revisions SET status='superseded' WHERE memory_id=? AND status='active'").run(String(row.id));
        } else seen.add(key);
      }
      this.db.exec(`CREATE UNIQUE INDEX active_person_profile ON memories(person_id, profile_field)
        WHERE status='active' AND is_current=1 AND person_id IS NOT NULL AND profile_field IS NOT NULL AND writer_actor_id=subject_actor_id`);
      this.syncExplicitProfiles();
    });
  }
  syncExplicitProfiles(): void {
    for(const r of this.db.prepare(`SELECT * FROM memories WHERE person_id IS NOT NULL AND profile_field IS NOT NULL
      AND writer_actor_id=subject_actor_id AND profile_source_self=1 AND source_message_id IS NOT NULL AND status='active' AND is_current=1
      ORDER BY updated_at,rowid`).all()) {
      const fact:ProfileFact={content:String(r.content),field:String(r.profile_field),sourceType:'self',messageIds:[String(r.source_message_id)],
        occurredAt:r.occurred_at==null?null:String(r.occurred_at),expiresAt:r.expires_at==null?null:String(r.expires_at)};
      const profile=this.profile(String(r.person_id));
      const current=profile.facts.find(f=>f.field===fact.field);
      if(!profile.facts.some(f=>sameFact(f,fact)) && (!current||this.evidenceSequence(fact.messageIds)>=this.evidenceSequence(current.messageIds))) {
        this.updateExplicitProfile(String(r.person_id),fact);
      }
    }
  }
  private checkpoint(conversationId: string): Record<string,unknown> {
    if(!this.db.prepare('SELECT id FROM conversations WHERE id=?').get(conversationId)) throw new Error('会话不存在。');
    this.db.prepare('INSERT OR IGNORE INTO auto_memory_checkpoints VALUES (?,0,0,NULL,NULL)').run(conversationId);
    return this.db.prepare('SELECT * FROM auto_memory_checkpoints WHERE conversation_id=?').get(conversationId)!;
  }
  private roomType(conversationId: string): 'group'|'private' {
    const row=this.db.prepare('SELECT r.room_type FROM conversations c JOIN rooms r ON r.id=c.room_id WHERE c.id=?').get(conversationId);
    if(!row) throw new Error('会话不存在。'); return row.room_type as 'group'|'private';
  }
  private job(row: Record<string,unknown>): AutoMemoryJob {
    return {id:String(row.id),conversationId:String(row.conversation_id),reason:row.reason as AutoMemoryReason,status:row.status as AutoMemoryJob['status'],
      startSeq:Number(row.start_seq),endSeq:Number(row.end_seq),attempts:Number(row.attempts),
      messageIds:this.db.prepare('SELECT message_id FROM auto_memory_job_messages WHERE job_id=? ORDER BY ordinal').all(String(row.id)).map(m=>String(m.message_id)),
      ...(row.lease_token==null?{}:{leaseToken:String(row.lease_token),leaseOwner:String(row.lease_owner),leaseUntil:Number(row.lease_until)}),
      ...(row.error==null?{}:{error:String(row.error)})};
  }
  reserveBatch(conversationId: string, reason: AutoMemoryReason, batchSize=50, excludeMessageId?: string): AutoMemoryJob | undefined {
    if(!['count','capacity'].includes(reason)||!Number.isSafeInteger(batchSize)||batchSize<1) throw new Error('整理批次参数无效。');
    return this.atomic(()=>{
      const checkpoint=this.checkpoint(conversationId); const roomType=this.roomType(conversationId);
      const before=excludeMessageId===undefined?undefined:this.db.prepare('SELECT ingest_seq FROM messages WHERE id=? AND conversation_id=?').get(excludeMessageId,conversationId);
      if(excludeMessageId!==undefined&&!before) throw new Error('整理边界消息必须属于当前会话。');
      const users=this.db.prepare(`SELECT m.id,m.ingest_seq,r.id AS run_id,r.status,r.response_message_id,d.status AS delivery_status,response.ingest_seq AS response_seq
        FROM messages m LEFT JOIN agent_runs r ON r.input_message_id=m.id LEFT JOIN messages response ON response.id=r.response_message_id
        LEFT JOIN deliveries d ON d.run_id=r.id WHERE m.conversation_id=? AND m.role='user' AND m.message_kind='chat' AND m.ingest_seq>?
        AND (? IS NULL OR m.ingest_seq<?) AND NOT EXISTS(SELECT 1 FROM auto_memory_job_messages assigned WHERE assigned.message_id=m.id)
        ORDER BY m.ingest_seq`).all(conversationId,reason==='capacity'?0:Number(checkpoint.initial_seq),before?.ingest_seq??null,before?.ingest_seq??null);
      const eligible=roomType==='group'?users:users.filter(r=>r.status==='completed'&&r.delivery_status==='sent');
      if(reason==='count'&&eligible.length<batchSize) return undefined;
      const selected=eligible.slice(0,batchSize);
      // Capacity also owns terminal unsuccessful inputs; running or uncertain runs remain raw context.
      if(reason==='capacity'&&roomType==='private') {
        const end=selected.length?Number(selected[selected.length-1]!.ingest_seq):Infinity;
        selected.push(...users.filter(r=>Number(r.ingest_seq)<=end&&(r.run_id==null||r.status==='failed'||r.status==='interrupted')));
      }
      if(!selected.length) return undefined;
      const members=new Map<string,number>();
      for(const row of selected) {
        members.set(String(row.id),Number(row.ingest_seq));
        if(row.status==='completed'&&row.delivery_status==='sent') members.set(String(row.response_message_id),Number(row.response_seq));
      }
      const ordered=[...members].sort((a,b)=>a[1]-b[1]); const id=randomUUID();
      this.db.prepare(`INSERT INTO auto_memory_jobs(id,conversation_id,reason,status,start_seq,end_seq,created_at) VALUES (?,?,?,'queued',?,?,?)`)
        .run(id,conversationId,reason,ordered[0]![1],ordered[ordered.length-1]![1],timestamp());
      ordered.forEach(([messageId],index)=>this.db.prepare('INSERT INTO auto_memory_job_messages VALUES (?,?,?)').run(id,messageId,index));
      return this.job(this.db.prepare('SELECT * FROM auto_memory_jobs WHERE id=?').get(id)!);
    });
  }
  claimNext(conversationId: string, options: {owner:string;leaseMs:number;now?:number}): AutoMemoryJob | undefined {
    if(!options.owner||!Number.isSafeInteger(options.leaseMs)||options.leaseMs<1) throw new Error('整理租约无效。');
    return this.atomic(()=>{
      const current=options.now??Date.now();
      const row=this.db.prepare("SELECT * FROM auto_memory_jobs WHERE conversation_id=? AND status<>'done' ORDER BY rowid LIMIT 1").get(conversationId);
      if(!row||row.status==='failed'||(row.status==='running'&&Number(row.lease_until)>current)) return undefined;
      this.db.prepare(`UPDATE auto_memory_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_owner=?,lease_until=?,error=NULL WHERE id=?`)
        .run(randomUUID(),options.owner,current+options.leaseMs,String(row.id));
      const job=this.job(this.db.prepare('SELECT * FROM auto_memory_jobs WHERE id=?').get(String(row.id))!);
      this.taskInput(job); return job;
    });
  }
  private active(jobId:string,leaseToken:string): Record<string,unknown> {
    const row=this.db.prepare("SELECT * FROM auto_memory_jobs WHERE id=? AND status='running' AND lease_token=? AND lease_until>?").get(jobId,leaseToken,Date.now());
    if(!row) throw new Error('整理租约已失效。'); return row;
  }
  private messages(ids: readonly string[]): AutoMemoryMessage[] {
    return ids.map(id=>{
      const r=this.db.prepare(`SELECT m.*,p.person_id,r.status AS run_status,d.status AS delivery_status,input.ingest_seq AS turn_input_seq FROM messages m
        LEFT JOIN actor_person_bindings p ON p.actor_id=m.actor_id LEFT JOIN agent_runs r ON r.input_message_id=m.id OR r.response_message_id=m.id
        LEFT JOIN messages input ON input.id=r.input_message_id LEFT JOIN deliveries d ON d.message_id=m.id WHERE m.id=?`).get(id)!;
      return {id:String(r.id),conversationId:String(r.conversation_id),role:r.role as 'user'|'assistant',text:String(r.text),ingestSeq:Number(r.ingest_seq),createdAt:String(r.created_at),
        ...(r.turn_input_seq==null?{}:{turnInputSeq:Number(r.turn_input_seq)}),
        ...(r.actor_id==null?{}:{actorId:String(r.actor_id)}),...(r.person_id==null?{}:{personId:String(r.person_id)}),...(r.sent_at==null?{}:{sentAt:String(r.sent_at)}),
        ...(r.run_status==null?{}:{runStatus:String(r.run_status)}),...(r.delivery_status==null?{}:{deliveryStatus:String(r.delivery_status)})};
    });
  }
  profile(personId:string): PersonProfile {
    const person=this.db.prepare('SELECT revision FROM persons WHERE id=?').get(personId);
    if(!person) throw new Error('人物不存在。');
    const baseVersion=Number(person.revision); const row=this.db.prepare('SELECT facts_json FROM person_profile_revisions WHERE person_id=? AND revision=?').get(personId,baseVersion);
    const facts=row?parse<ProfileFact[]>(row.facts_json):[];
    const at=timestamp();
    return {personId,baseVersion,facts:facts.filter(f=>!f.expiresAt||f.expiresAt>at)};
  }
  profileForActors(currentActorId:string,mentionedActorIds:readonly string[]=[]): PersonProfile[] {
    const people=new Set([currentActorId,...mentionedActorIds].map(id=>this.personForActor(id)).filter((id):id is string=>id!==undefined));
    return [...people].map(id=>this.profile(id));
  }
  taskInput(job:AutoMemoryJob): AutoMemoryTaskInput {
    if(!job.leaseToken) throw new Error('整理任务尚未领取。');
    const row=this.active(job.id,job.leaseToken);
    if(row.input_json!==null) return {...parse<AutoMemoryTaskInput>(row.input_json),job:this.job(row)};
    const canonical=this.job(row); const messages=this.messages(canonical.messageIds); const cp=this.checkpoint(canonical.conversationId);
    const people=new Set(messages.flatMap(m=>m.personId?[m.personId]:[]));
    const input:AutoMemoryTaskInput={job:canonical,roomType:this.roomType(canonical.conversationId),messages,profiles:[...people].map(p=>this.profile(p)),selfProfile:this.selfProfile.snapshot(),...(cp.summary==null?{}:{previousSummary:String(cp.summary)})};
    this.db.prepare('UPDATE auto_memory_jobs SET input_json=? WHERE id=? AND lease_token=?').run(JSON.stringify(input),job.id,job.leaseToken);
    return input;
  }
  updateExplicitProfile(personId:string,fact:ProfileFact,previousMessageId?:string): void {
    const profile=this.profile(personId);
    const existing=profile.facts.find(f=>fact.field!==undefined&&f.field===fact.field);
    if(existing&&this.evidenceSequence(fact.messageIds)<this.evidenceSequence(existing.messageIds)) throw new MemoryError('较旧来源不能覆盖较新的明确画像字段。');
    const facts=profile.facts.filter(f=>fact.field===undefined
      ? previousMessageId===undefined || f.field!==undefined || !f.messageIds.includes(previousMessageId)
      : f.field!==fact.field); facts.push(fact);
    this.writeProfile({...profile,facts},null);
  }
  removeExplicitProfile(personId:string,field:string):void {
    const profile=this.profile(personId);
    this.writeProfile({...profile,facts:profile.facts.filter(f=>f.field!==field)},null);
  }
  private writeProfile(profile:PersonProfile,jobId:string|null): void {
    const revision=profile.baseVersion+1;
    if(this.db.prepare('UPDATE persons SET revision=? WHERE id=? AND revision=?').run(revision,profile.personId,profile.baseVersion).changes!==1) throw new Error('人物画像版本冲突，请重读后重试。');
    this.db.prepare('INSERT INTO person_profile_revisions VALUES (?,?,?,?,?)').run(profile.personId,revision,JSON.stringify(profile.facts),jobId,timestamp());
  }
  private evidenceSequence(ids:readonly string[]):number {
    return ids.reduce((highest,id)=>Math.max(highest,Number(this.db.prepare('SELECT ingest_seq FROM messages WHERE id=?').get(id)?.ingest_seq??0)),0);
  }
  commit(jobId:string,leaseToken:string,extract:ValidatedExtract,selfBudget?:number): void {
    this.atomic(()=>{
      const row=this.active(jobId,leaseToken); const job=this.job(row); const input=this.taskInput(job); const owned=new Set(job.messageIds);
      if(input.messages.some(m=>m.actorId!==undefined&&this.personForActor(m.actorId)!==m.personId)) throw new Error('人物绑定版本冲突，请重读后重试。');
      const first=this.db.prepare("SELECT id FROM auto_memory_jobs WHERE conversation_id=? AND status<>'done' ORDER BY rowid LIMIT 1").get(job.conversationId);
      if(first?.id!==jobId) throw new Error('同房间整理必须按批次顺序提交。');
      if(!Array.isArray(extract.topics)||!Array.isArray(extract.fragments)||!Array.isArray(extract.profiles)) throw new Error('整理产物结构无效。');
      const evidence=(ids:string[],sourceType?:string,personId?:string)=>{
        if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!owned.has(id))) throw new Error('整理证据必须属于固定批次。');
        if(sourceType!==undefined&&!['self','third_party','inference'].includes(sourceType)) throw new Error('证据类型无效。');
        if(sourceType!==undefined&&!ids.some(id=>input.messages.some(m=>m.id===id&&m.role==='user'))) throw new Error('Bot回复不能作为人物事实的独立证据。');
        if(sourceType==='self'&&ids.some(id=>input.messages.some(m=>m.id===id&&m.role==='user'&&m.personId!==personId))) throw new Error('自述证据身份不匹配。');
      };
      const content=(s:string)=>{if(typeof s!=='string'||!s.trim()||s.length>32000) throw new Error('整理正文无效。');};
      if(!Array.isArray(extract.ignoredMessageIds)||new Set(extract.ignoredMessageIds).size!==extract.ignoredMessageIds.length
        ||extract.ignoredMessageIds.some(id=>!input.messages.some(m=>m.id===id&&m.role==='user'))) throw new Error('无价值消息归属无效。');
      const covered=new Set([...extract.ignoredMessageIds,...extract.topics.flatMap(t=>t.messageIds),...extract.fragments.flatMap(f=>f.messageIds)]);
      if(input.messages.some(m=>m.role==='user'&&!covered.has(m.id))) throw new Error('整理结果未覆盖所有真人消息。');
      if(input.roomType==='private') content(extract.continuationSummary!);
      else if(extract.continuationSummary!==undefined) throw new Error('群聊不能提交私聊续聊摘要。');
      const topicIds=extract.topics.map(topic=>{
        content(topic.summary);evidence(topic.messageIds);const id=randomUUID();
        this.db.prepare('INSERT INTO memory_topics(id,conversation_id,job_id,summary,content_hash,created_at) VALUES (?,?,?,?,?,?)').run(id,job.conversationId,jobId,topic.summary,hash(topic.summary),timestamp());
        topic.messageIds.forEach(messageId=>this.db.prepare('INSERT INTO memory_topic_messages VALUES (?,?)').run(id,messageId)); return id;
      });
      for(const fragment of extract.fragments) {
        if(!['self','third_party','inference'].includes(fragment.sourceType)) throw new Error('证据类型无效。');
        content(fragment.content);evidence(fragment.messageIds,fragment.sourceType,fragment.personId);
        if(!input.profiles.some(p=>p.personId===fragment.personId)) throw new Error('人物片段目标不属于本批次人物。');
        if(fragment.topicIndex!==undefined&&(!Number.isSafeInteger(fragment.topicIndex)||!topicIds[fragment.topicIndex])) throw new Error('人物片段Topic关联无效。');
        const id=randomUUID();this.db.prepare('INSERT INTO person_fragments VALUES (?,?,?,?,?,?,?)').run(id,fragment.personId,jobId,fragment.topicIndex===undefined?null:topicIds[fragment.topicIndex]!,fragment.content,fragment.sourceType,timestamp());
        fragment.messageIds.forEach(messageId=>this.db.prepare('INSERT INTO person_fragment_messages VALUES (?,?)').run(id,messageId));
      }
      const updated=new Set<string>();
      for(const profile of extract.profiles) {
        if(updated.has(profile.personId)||!Array.isArray(profile.facts)) throw new Error('人物画像产物无效。'); updated.add(profile.personId);
        const baseline=input.profiles.find(p=>p.personId===profile.personId);
        if(!baseline||baseline.baseVersion!==profile.baseVersion) throw new Error('人物画像输入版本不匹配。');
        for(const current of baseline.facts) {
          if(current.field===undefined||profile.facts.some(f=>sameFact(current,f))) continue;
          const existingSeq=this.evidenceSequence(current.messageIds);
          const replacements=profile.facts.filter(f=>f.field===current.field);
          const newSeq=replacements.length?Math.max(...replacements.map(f=>this.evidenceSequence(f.messageIds)))
            :Math.max(0,...input.messages.filter(m=>m.role==='user'&&m.personId===profile.personId).map(m=>m.ingestSeq));
          if(newSeq<existingSeq) throw new Error('较旧批次不能覆盖较新的明确画像字段。');
        }
        for(const fact of profile.facts) {
          content(fact.content);
          if(!['self','third_party','inference'].includes(fact.sourceType)||!Array.isArray(fact.messageIds)) throw new Error('画像事实证据无效。');
          if(!baseline.facts.some(old=>sameFact(old,fact))) evidence(fact.messageIds,fact.sourceType,profile.personId);
        }
        this.writeProfile(profile,jobId);
      }
      if (extract.selfProfile !== undefined) {
        if (input.selfProfile === undefined) throw new Error('自我档案产物缺少已捕获的输入快照。');
        this.selfProfile.commit(input.selfProfile, extract.selfProfile, input.messages, selfBudget);
      }
      // Check again after all writes; the transaction rolls everything back if the lease expired.
      this.active(jobId,leaseToken);
      this.db.prepare("UPDATE auto_memory_jobs SET status='done',completed_at=?,lease_token=NULL,lease_owner=NULL,lease_until=NULL WHERE id=?").run(timestamp(),jobId);
      const checkpoint=this.checkpoint(job.conversationId);
      const pending=this.db.prepare(`SELECT MIN(m.ingest_seq) AS seq FROM messages m WHERE m.conversation_id=? AND m.role='user'
        AND m.message_kind='chat' AND m.ingest_seq>? AND NOT EXISTS(SELECT 1 FROM auto_memory_job_messages jm
          JOIN auto_memory_jobs j ON j.id=jm.job_id WHERE jm.message_id=m.id AND j.status='done')`).get(job.conversationId,Number(checkpoint.initial_seq));
      const highestDone=Number(this.db.prepare("SELECT MAX(end_seq) AS seq FROM auto_memory_jobs WHERE conversation_id=? AND status='done'").get(job.conversationId)?.seq??checkpoint.initial_seq);
      const completedSeq=Number(this.db.prepare(`SELECT COALESCE(MAX(ingest_seq),?) AS seq FROM messages WHERE conversation_id=?
        AND ingest_seq<=? AND (? IS NULL OR ingest_seq<?)`)
        .get(Number(checkpoint.initial_seq),job.conversationId,highestDone,pending?.seq??null,pending?.seq??null)?.seq);
      this.db.prepare(`UPDATE auto_memory_checkpoints SET completed_seq=MAX(completed_seq,?),summary=COALESCE(?,summary),
        summary_job_id=CASE WHEN ? IS NULL THEN summary_job_id ELSE ? END WHERE conversation_id=?`)
        .run(completedSeq,extract.continuationSummary??null,extract.continuationSummary??null,jobId,job.conversationId);
    });
  }
  fail(jobId:string,leaseToken:string,error:string): void {
    this.atomic(()=>{this.active(jobId,leaseToken);this.db.prepare("UPDATE auto_memory_jobs SET status='failed',error=?,lease_token=NULL,lease_owner=NULL,lease_until=NULL WHERE id=?").run(error,jobId);});
  }
  retry(jobId:string): void {
    if(this.db.prepare("UPDATE auto_memory_jobs SET status='queued',error=NULL WHERE id=? AND status='failed'").run(jobId).changes!==1) throw new Error('任务不处于失败状态。');
  }
  renewLease(jobId:string,leaseToken:string,leaseMs:number):void {
    if(!Number.isSafeInteger(leaseMs)||leaseMs<1) throw new Error('整理租约时长无效。');
    this.atomic(()=>{this.active(jobId,leaseToken);this.db.prepare('UPDATE auto_memory_jobs SET lease_until=? WHERE id=?').run(Date.now()+leaseMs,jobId);});
  }
  saveProgress(jobId:string,leaseToken:string,progress:unknown):void {
    const serialized=JSON.stringify(progress);
    if(serialized===undefined) throw new Error('整理进度必须可序列化。');
    this.atomic(()=>{this.active(jobId,leaseToken);this.db.prepare('UPDATE auto_memory_jobs SET progress_json=? WHERE id=?').run(serialized,jobId);});
  }
  loadProgress(jobId:string,leaseToken:string):unknown {
    const row=this.active(jobId,leaseToken);return row.progress_json==null?undefined:parse<unknown>(row.progress_json);
  }
  clearProgress(jobId:string,leaseToken:string):void {
    this.atomic(()=>{this.active(jobId,leaseToken);this.db.prepare('UPDATE auto_memory_jobs SET progress_json=NULL,input_json=NULL WHERE id=?').run(jobId);});
  }
  pendingConversations(): string[] {
    return this.db.prepare("SELECT DISTINCT conversation_id FROM auto_memory_jobs WHERE status IN ('queued','running')").all().map(r=>String(r.conversation_id));
  }
  listJobs(limit=100): {id:string;conversationId:string;status:string;reason:string;attempts:number;error:string|null}[] {
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000) throw new Error('任务查询数量无效。');
    return this.db.prepare(`SELECT id,conversation_id,status,reason,attempts,error
      FROM auto_memory_jobs ORDER BY rowid DESC LIMIT ?`).all(limit)
      .map(r=>({id:String(r.id),conversationId:String(r.conversation_id),
        status:String(r.status),reason:String(r.reason),attempts:Number(r.attempts),error:r.error==null?null:String(r.error)}));
  }
  status(conversationId:string): {queued:number;running:number;failed:number;completed:number;checkpoint:number;summary?:string} {
    const cp=this.checkpoint(conversationId);const result={queued:0,running:0,failed:0,completed:0,checkpoint:Number(cp.completed_seq),...(cp.summary==null?{}:{summary:String(cp.summary)})};
    for(const r of this.db.prepare('SELECT status,COUNT(*) AS count FROM auto_memory_jobs WHERE conversation_id=? GROUP BY status').all(conversationId)) {
      const key=r.status==='done'?'completed':r.status as 'queued'|'running'|'failed';result[key]=Number(r.count);
    } return result;
  }
  contextAfterCheckpoint(conversationId:string,excludeMessageId?:string): AutoMemoryMessage[] {
    this.checkpoint(conversationId);
    const ids=this.db.prepare(`SELECT m.id FROM messages m LEFT JOIN agent_runs r ON r.input_message_id=m.id OR r.response_message_id=m.id
      LEFT JOIN deliveries d ON d.message_id=m.id WHERE m.conversation_id=? AND m.message_kind='chat' AND (? IS NULL OR m.id<>?)
      AND NOT EXISTS(SELECT 1 FROM auto_memory_job_messages jm JOIN auto_memory_jobs j ON j.id=jm.job_id WHERE (jm.message_id=m.id OR (m.role='assistant' AND jm.message_id=r.input_message_id)) AND j.status='done')
      AND (m.role='user' OR (r.status='completed' AND d.status='sent')) ORDER BY m.ingest_seq`).all(conversationId,excludeMessageId??null,excludeMessageId??null).map(r=>String(r.id));
    return this.messages(ids);
  }
  private topic(row:Record<string,unknown>):TopicRecord {
    return {id:String(row.id),conversationId:String(row.conversation_id),jobId:String(row.job_id),summary:String(row.summary),version:Number(row.version),contentHash:String(row.content_hash),
      messageIds:this.db.prepare('SELECT message_id FROM memory_topic_messages WHERE topic_id=?').all(String(row.id)).map(r=>String(r.message_id))};
  }
  pendingTopics(limit=100): TopicRecord[] {
    return this.db.prepare(`SELECT t.* FROM memory_topics t LEFT JOIN topic_embeddings e ON e.topic_id=t.id
      WHERE e.topic_id IS NULL OR e.content_hash<>t.content_hash OR e.topic_version<>t.version ORDER BY t.rowid LIMIT ?`).all(limit).map(r=>this.topic(r));
  }
  pendingTopicsForConversation(conversationId:string,meta:{model:string;dimensions:number;inputVersion:number},limit=100):TopicRecord[] {
    if(!meta.model||!Number.isSafeInteger(meta.dimensions)||meta.dimensions<1||!Number.isSafeInteger(meta.inputVersion)||meta.inputVersion<1
      ||!Number.isSafeInteger(limit)||limit<1) throw new Error('Topic向量配置无效。');
    return this.db.prepare(`SELECT t.* FROM memory_topics t LEFT JOIN topic_embeddings e ON e.topic_id=t.id WHERE t.conversation_id=?
      AND (e.topic_id IS NULL OR e.content_hash<>t.content_hash OR e.topic_version<>t.version OR e.model<>? OR e.dimensions<>? OR e.input_version<>?)
      ORDER BY t.rowid LIMIT ?`).all(conversationId,meta.model,meta.dimensions,meta.inputVersion,limit).map(r=>this.topic(r));
  }
  private vector(vector:number[],dimensions:number):void {
    if(!Number.isSafeInteger(dimensions)||dimensions<1||!Array.isArray(vector)||vector.length!==dimensions||vector.some(v=>!Number.isFinite(v))||!vector.some(v=>v!==0)) throw new Error('Topic向量维度或数值无效。');
  }
  saveEmbedding(topicId:string,embedding:TopicEmbedding):void {
    this.vector(embedding.vector,embedding.dimensions);
    if(!embedding.model||!Number.isSafeInteger(embedding.inputVersion)||embedding.inputVersion<1) throw new Error('Topic向量元数据无效。');
    this.atomic(()=>{
      const topic=this.db.prepare('SELECT * FROM memory_topics WHERE id=?').get(topicId);
      if(!topic||topic.content_hash!==embedding.contentHash||topic.version!==embedding.topicVersion) throw new Error('Topic版本已变化。');
      this.db.prepare(`INSERT INTO topic_embeddings VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(topic_id) DO UPDATE SET model=excluded.model,dimensions=excluded.dimensions,
        input_version=excluded.input_version,topic_version=excluded.topic_version,content_hash=excluded.content_hash,vector_json=excluded.vector_json,updated_at=excluded.updated_at`)
        .run(topicId,embedding.model,embedding.dimensions,embedding.inputVersion,embedding.topicVersion,embedding.contentHash,JSON.stringify(embedding.vector),timestamp());
    });
  }
  searchTopics(conversationId:string,query:TopicSearch): {status:'ready'|'unavailable';topics:(TopicRecord&{score:number})[]} {
    this.vector(query.vector,query.dimensions);const limit=query.limit??5;
    if(!Number.isSafeInteger(limit)||limit<1||limit>100) throw new Error('Topic查询limit无效。');
    const rows=this.db.prepare(`SELECT t.*,e.vector_json FROM memory_topics t JOIN topic_embeddings e ON e.topic_id=t.id
      WHERE t.conversation_id=? AND e.model=? AND e.dimensions=? AND e.input_version=? AND e.topic_version=t.version AND e.content_hash=t.content_hash`)
      .all(conversationId,query.model,query.dimensions,query.inputVersion);
    const norm=Math.hypot(...query.vector);
    const topics=rows.map(r=>{const vector=parse<number[]>(r.vector_json);this.vector(vector,query.dimensions);
      return {...this.topic(r),score:vector.reduce((sum,value,i)=>sum+value*query.vector[i]!,0)/(Math.hypot(...vector)*norm)};}).sort((a,b)=>b.score-a.score).slice(0,limit);
    return {status:rows.length?'ready':'unavailable',topics};
  }
}

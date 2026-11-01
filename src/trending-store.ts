import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {ChannelRoute} from './channel-types.js';
import type {TrendingSnapshot,TrendingDigest} from './trending-content.js';

export type TrendingCode = 'collect_failed'|'collect_exhausted'|'generation_unknown'|'digest_invalid'|'delivery_uncertain'|'delivery_rejected'|'route_unavailable'|'expired'|'persistence_failed'|'internal_error';
export interface TrendingEdition {
  id:string; date:string; manual:boolean; preview?:boolean; state:'pending'|'collecting'|'collect_failed'|'generating'|'ready'|'delivered'|'failed'|'uncertain'|'expired';
  routes:ChannelRoute[]; attempts:number; nextAttemptAt:number; createdAt:number; updatedAt:number;
  code?:TrendingCode; snapshot?:TrendingSnapshot; digest?:TrendingDigest; parts?:string[];
  recovery?:{requestedAt:number;previousState:TrendingEdition['state'];previousCode:TrendingCode;status:'requested'|'ready'|'completed'};
}
export interface TrendingPart {index:number; status:'pending'|'sending'|'sent'|'uncertain'|'rejected'; externalMessageId?:string}
export class TrendingPersistenceError extends Error {
  constructor(cause:unknown){super('Trending 本地持久化失败。',{cause});this.name='TrendingPersistenceError';}
}

/** Independent feature ledger. Report text never enters the conversation database. */
export class TrendingStore {
  private readonly db:DatabaseSync;
  constructor(path:string){
    let db:DatabaseSync|undefined;
    try {
      mkdirSync(dirname(path),{recursive:true});db=new DatabaseSync(path);
      db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS editions(id TEXT PRIMARY KEY,date TEXT NOT NULL,manual INTEGER NOT NULL,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS parts(edition_id TEXT NOT NULL REFERENCES editions(id),route_key TEXT NOT NULL,
          ordinal INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','uncertain','rejected')),
          external_id TEXT,PRIMARY KEY(edition_id,route_key,ordinal));
        CREATE INDEX IF NOT EXISTS editions_pending_manual ON editions(manual)
          WHERE manual=1 AND COALESCE(json_extract(body,'$.preview'),0)=0
          AND json_extract(body,'$.state') IN ('pending','collect_failed','ready');
        CREATE INDEX IF NOT EXISTS editions_pending_expiry ON editions(date)
          WHERE manual=0 AND json_extract(body,'$.state') IN ('pending','collect_failed','ready');
        CREATE INDEX IF NOT EXISTS editions_latest ON editions(manual,date DESC);`);
      this.db=db;
    }catch(error){db?.close();throw new TrendingPersistenceError(error);}
  }
  private safe<T>(operation:()=>T):T {try{return operation();}catch(error){throw new TrendingPersistenceError(error);}}
  private transaction<T>(operation:()=>T):T {return this.safe(()=>{this.db.exec('BEGIN IMMEDIATE');try{const result=operation();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}});}
  get(id:string):TrendingEdition|undefined {return this.safe(()=>{const row=this.db.prepare('SELECT body FROM editions WHERE id=?').get(id);return row?JSON.parse(String(row.body)) as TrendingEdition:undefined;});}
  latest():TrendingEdition|undefined {return this.safe(()=>{const row=this.db.prepare('SELECT body FROM editions WHERE manual=0 ORDER BY date DESC LIMIT 1').get();return row?JSON.parse(String(row.body)) as TrendingEdition:undefined;});}
  create(edition:TrendingEdition):TrendingEdition {return this.transaction(()=>{this.db.prepare('INSERT OR IGNORE INTO editions VALUES(?,?,?,?)').run(edition.id,edition.date,Number(edition.manual),JSON.stringify(edition));return this.get(edition.id)!;});}
  /** Local CLI queues a durable request; only the running harness performs network work. */
  requestManual(id:string,routes:readonly ChannelRoute[],at=Date.now()):TrendingEdition {
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!routes.length||routes.some(r=>r.channel!=='qq'||r.roomType!=='group'||!r.roomId||!r.accountId))throw new Error('手工日报编号或QQ群路由无效。');
    const targets=[...new Map(routes.map(r=>[routeKey(r),{...r}])).values()];
    const edition=this.create({id:`manual:${id}`,date:new Date(at+8*3_600_000).toISOString().slice(0,10),manual:true,state:'pending',
      routes:targets,attempts:0,nextAttemptAt:0,createdAt:at,updatedAt:at});
    if(JSON.stringify(edition.routes.map(routeKey).sort())!==JSON.stringify(targets.map(routeKey).sort()))throw new Error('同一手工日报编号不能变更群路由。');
    return edition;
  }
  /** Explicit recovery preserves the failed edition and its original frozen routes. Never retries delivery. */
  requestRecovery(date:string,at=Date.now()):TrendingEdition {
    const today=new Date(at+8*3_600_000).toISOString().slice(0,10);
    if(date!==today)throw new Error('仅能恢复北京时间今天的正式日报。');
    const result=this.transaction(()=>{
      const edition=this.get(date);
      if(!edition||edition.manual||edition.date!==date)return undefined;
      if(edition.recovery)return edition; // Repeated operator requests are idempotent.
      if(!edition.snapshot||!['failed','uncertain'].includes(edition.state)||!['generation_unknown','digest_invalid'].includes(edition.code??'')
        ||edition.parts||this.db.prepare('SELECT 1 FROM parts WHERE edition_id=? LIMIT 1').get(date))return undefined;
      edition.recovery={requestedAt:at,previousState:edition.state,previousCode:edition.code!,status:'requested'};
      edition.nextAttemptAt=0;edition.updatedAt=at;this.db.prepare('UPDATE editions SET body=? WHERE id=?').run(JSON.stringify(edition),date);
      return edition;
    });
    if(!result)throw new Error('恢复需要当天已有快照、生成失败且从未开始投递的正式日报。');
    return result;
  }
  pendingRecovery(at:number):TrendingEdition|undefined {return this.safe(()=>{
    const date=new Date(at+8*3_600_000).toISOString().slice(0,10);
    const edition=this.get(date);
    return edition?.recovery&&edition.nextAttemptAt<=at&&((edition.recovery.status==='requested'&&['failed','uncertain'].includes(edition.state)
      &&['generation_unknown','digest_invalid'].includes(edition.code??''))||(edition.recovery.status==='ready'&&edition.state==='ready'))?edition:undefined;
  });}
  prepareRecovery(id:string,digest:TrendingDigest,at:number):TrendingEdition|undefined {return this.transaction(()=>{
    const edition=this.get(id);
    if(!edition||edition.manual||edition.date!==new Date(at+8*3_600_000).toISOString().slice(0,10)||edition.recovery?.status!=='requested'
      ||!['failed','uncertain'].includes(edition.state)||!['generation_unknown','digest_invalid'].includes(edition.code??'')||edition.parts||this.db.prepare('SELECT 1 FROM parts WHERE edition_id=? LIMIT 1').get(id))return undefined;
    edition.digest=digest;edition.state='ready';edition.recovery.status='ready';edition.updatedAt=at;delete edition.code;
    this.db.prepare('UPDATE editions SET body=? WHERE id=?').run(JSON.stringify(edition),id);return edition;
  });}
  pendingManual(at:number):TrendingEdition|undefined {return this.safe(()=>{
    const row=this.db.prepare(`SELECT body FROM editions WHERE manual=1 AND COALESCE(json_extract(body,'$.preview'),0)=0
      AND json_extract(body,'$.state') IN ('pending','collect_failed','ready')
      AND json_extract(body,'$.nextAttemptAt')<=? ORDER BY rowid LIMIT 1`).get(at);
    return row?JSON.parse(String(row.body)) as TrendingEdition:undefined;
  });}
  claimCollection(id:string,at:number):TrendingEdition|undefined {return this.transaction(()=>{
    const edition=this.get(id)!;
    if(!['pending','collect_failed'].includes(edition.state)||edition.attempts>=3||edition.nextAttemptAt>at)return undefined;
    edition.state='collecting';edition.attempts++;edition.updatedAt=at;delete edition.code;
    this.db.prepare('UPDATE editions SET body=? WHERE id=?').run(JSON.stringify(edition),id);return edition;
  });}
  update(id:string,change:(edition:TrendingEdition)=>void):TrendingEdition {return this.transaction(()=>{const edition=this.get(id);if(!edition)throw new Error('Missing edition');change(edition);this.db.prepare('UPDATE editions SET body=? WHERE id=?').run(JSON.stringify(edition),id);return edition;});}
  prepareParts(id:string,parts:string[],at:number):TrendingEdition {return this.transaction(()=>{
    const edition=this.get(id)!;edition.parts=parts;edition.state='ready';edition.updatedAt=at;delete edition.code;
    this.db.prepare('UPDATE editions SET body=? WHERE id=?').run(JSON.stringify(edition),id);
    for(const route of edition.routes)for(let index=0;index<parts.length;index++)this.db.prepare('INSERT INTO parts VALUES(?,?,?,?,NULL)').run(id,routeKey(route),index,'pending');
    return edition;
  });}
  parts(id:string,route:ChannelRoute):TrendingPart[] {return this.safe(()=>this.db.prepare('SELECT ordinal,status,external_id FROM parts WHERE edition_id=? AND route_key=? ORDER BY ordinal').all(id,routeKey(route)).map(row=>({index:Number(row.ordinal),status:String(row.status) as TrendingPart['status'],...(row.external_id?{externalMessageId:String(row.external_id)}:{})})));}
  beginPart(id:string,route:ChannelRoute,index:number):boolean {return this.safe(()=>Number(this.db.prepare("UPDATE parts SET status='sending' WHERE edition_id=? AND route_key=? AND ordinal=? AND status='pending'").run(id,routeKey(route),index).changes)===1);}
  ackPart(id:string,route:ChannelRoute,index:number,status:'sent'|'uncertain'|'rejected',externalId?:string):void {this.safe(()=>{this.db.prepare("UPDATE parts SET status=?,external_id=? WHERE edition_id=? AND route_key=? AND ordinal=? AND status='sending'").run(status,externalId??null,id,routeKey(route),index);});}
  recover(at:number):void {this.transaction(()=>{
    const uncertain=this.db.prepare("SELECT DISTINCT edition_id FROM parts WHERE status='sending'").all();
    this.db.prepare("UPDATE parts SET status='uncertain' WHERE status='sending'").run();
    for(const row of this.db.prepare(`SELECT body FROM editions WHERE json_extract(body,'$.state') IN ('collecting','generating')
      OR id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(uncertain.map(row=>row.edition_id)))){
      const edition=JSON.parse(String(row.body)) as TrendingEdition;
      if(edition.state==='generating'){edition.state='uncertain';edition.code='generation_unknown';}
      else if(edition.state==='collecting'){edition.state='collect_failed';edition.code='collect_failed';edition.nextAttemptAt=at+60_000;}
      else edition.code='delivery_uncertain';
      edition.updatedAt=at;this.db.prepare('UPDATE editions SET body=? WHERE id=?').run(JSON.stringify(edition),edition.id);
    }
  });}
  expire(at:number):void {
    const today=new Date(at+8*3_600_000).toISOString().slice(0,10);
    const cutoff=new Date(at+8*3_600_000-10*3_600_000).toISOString().slice(0,10);
    // Empty polls must not reserve the writer or scan completed editions.
    if(!this.safe(()=>this.db.prepare(`SELECT 1 FROM editions INDEXED BY editions_pending_expiry WHERE manual=0 AND date<=?
      AND json_extract(body,'$.state') IN ('pending','collect_failed','ready')
      AND (date<? OR json_extract(body,'$.recovery') IS NULL) LIMIT 1`).get(cutoff,today)))return;
    this.transaction(()=>{
    for(const row of this.db.prepare(`SELECT body FROM editions INDEXED BY editions_pending_expiry WHERE manual=0 AND date<=?
      AND json_extract(body,'$.state') IN ('pending','collect_failed','ready')
      AND (date<? OR json_extract(body,'$.recovery') IS NULL)`).all(cutoff,today)){
      const edition=JSON.parse(String(row.body)) as TrendingEdition;
      edition.state='expired';edition.code='expired';edition.updatedAt=at;
      this.db.prepare('UPDATE editions SET body=? WHERE id=?').run(JSON.stringify(edition),edition.id);
    }
    });
  }
  close():void {this.safe(()=>this.db.close());}
}
export const routeKey=(route:ChannelRoute)=>JSON.stringify([route.channel,route.accountId,route.roomType,route.roomId]);

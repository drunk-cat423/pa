import {join} from 'node:path';
import type {PaConfig} from './config.js';
import type {ChannelRoute,DeliveryResult,OutboundMessage} from './channel-types.js';
import {splitMarkdown} from './markdown-chunks.js';
import {DiagnosticPersistenceError} from './diagnostics.js';
import {collectTrending,generateTrendingDigest,type TrendingDigest,type TrendingSnapshot} from './trending-content.js';
import {TrendingStore,TrendingPersistenceError,routeKey,type TrendingEdition,type TrendingCode} from './trending-store.js';

const DAY=86_400_000,OFFSET=8*60*60_000;
const dayAt=(at:number)=>new Date(at+OFFSET).toISOString().slice(0,10);
const dueAt=(day:string)=>Date.parse(`${day}T09:00:00+08:00`);
export interface TrendingDependencies {
  now?:()=>number;
  collector?:(config:PaConfig,signal:AbortSignal)=>Promise<TrendingSnapshot>;
  generator?:(config:PaConfig,snapshot:TrendingSnapshot,signal:AbortSignal)=>Promise<TrendingDigest>;
}
export interface TrendingRunOptions {id:string;groupIds?:string[];preview?:boolean}

/** A program-owned daily job. There is deliberately no chat tool or personal context. */
export class TrendingService {
  private store:TrendingStore|undefined;
  private timer:ReturnType<typeof setInterval>|undefined;
  private closed=false;
  private fatal=false;
  private pending:Promise<void>|undefined;
  private readonly abort=new AbortController();
  private readonly now:()=>number;
  private readonly collector:NonNullable<TrendingDependencies['collector']>;
  private readonly generator:NonNullable<TrendingDependencies['generator']>;
  private readonly targets:ChannelRoute[];
  constructor(private readonly config:PaConfig,routes:readonly ChannelRoute[],
    private readonly allowedRoutes:()=>readonly ChannelRoute[],
    private readonly enqueueOutput:(route:ChannelRoute,operation:()=>Promise<void>)=>Promise<void>,
    private readonly send:(message:OutboundMessage)=>Promise<DeliveryResult>,
    private readonly onError:(error:unknown)=>void,deps:TrendingDependencies={}){
    this.now=deps.now??Date.now;this.collector=deps.collector??collectTrending;this.generator=deps.generator??generateTrendingDigest;
    const ids=config.trending?.groupIds??[];
    if(config.trending?.enabled&&(!ids.length||ids.some(id=>!routes.some(r=>r.channel==='qq'&&r.roomType==='group'&&r.roomId===id))))
      throw new Error('Trending 群必须显式配置且属于当前允许的 QQ 群。');
    this.targets=routes.filter(r=>r.channel==='qq'&&r.roomType==='group'&&ids.includes(r.roomId)).map(r=>({...r}));
  }
  private storage():TrendingStore {
    if(!this.store){this.store=new TrendingStore(join(this.config.dataDir,'trending.sqlite'));this.store.recover(this.now());this.store.expire(this.now());}
    return this.store;
  }
  private enabled():boolean{return !this.closed&&!this.fatal&&this.config.trending?.enabled===true;}
  start():void {
    if(!this.enabled()||this.timer)return;
    try{this.storage();}catch(error){this.fail(error);return;}
    this.timer=setInterval(()=>this.poll(),1000);this.timer.unref();this.poll();
  }
  poll():void {
    if(!this.enabled()||this.pending)return;
    const at=this.now(),date=dayAt(at),due=dueAt(date);
    this.launch(async()=>{
      const store=this.storage();
      store.expire(at);
      if(at>=due-5*60_000&&at<due+60*60_000){
        const edition=store.create({id:date,date,manual:false,state:'pending',routes:this.targets.map(r=>({...r})),attempts:0,nextAttemptAt:0,createdAt:at,updatedAt:at});
        await this.process(edition,false);
      }
      const manual=store.pendingManual(this.now());
      if(manual)await this.process(manual,false);
    });
  }
  private launch(operation:()=>Promise<void>):void {
    this.pending=Promise.resolve().then(operation).catch(error=>this.fail(error)).finally(()=>{this.pending=undefined;});
  }
  private fail(error:unknown):void {
    if(this.persistenceFailure(error)){if(this.fatal)return;this.fatal=true;this.lastCode='persistence_failed';if(this.timer)clearInterval(this.timer);this.timer=undefined;this.onError(error);}
    else { // Unexpected program errors are observable feature failures, never chat shutdowns.
      this.lastCode='internal_error';
    }
  }
  private lastCode:TrendingCode|undefined;
  private persistenceFailure(error:unknown):boolean{return error instanceof TrendingPersistenceError||error instanceof DiagnosticPersistenceError;}
  private setState(id:string,state:TrendingEdition['state'],code?:TrendingCode):TrendingEdition {
    return this.storage().update(id,e=>{e.state=state;e.updatedAt=this.now();if(code)e.code=code;else delete e.code;});
  }
  private async bounded<T>(operation:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(Math.min(this.config.timeoutMs,120_000))]);
    signal.throwIfAborted();
    return new Promise<T>((resolve,reject)=>{
      const onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});
      Promise.resolve().then(()=>operation(signal)).then(resolve,error=>{
        // Cancellation can settle the outer wait before model/diagnostic cleanup fails.
        // Still notify the harness, including after close(), without waiting for cleanup.
        if(this.persistenceFailure(error))this.fail(error);
        reject(error);
      }).catch(reject).finally(()=>signal.removeEventListener('abort',onAbort));
    });
  }
  private async process(original:TrendingEdition,preview:boolean):Promise<void>{
    const store=this.storage();let edition=store.get(original.id)!;
    if(!this.enabled())return;
    if(this.now()<edition.nextAttemptAt)return;
    if(edition.routes.some(route=>!this.targets.some(r=>routeKey(r)===routeKey(route)))){this.setState(edition.id,'failed','route_unavailable');return;}
    if(['pending','collect_failed'].includes(edition.state)){
      if(edition.attempts>=3){this.setState(edition.id,'failed','collect_exhausted');return;}
      if(this.now()<edition.nextAttemptAt)return;
      const claimed=store.claimCollection(edition.id,this.now());if(!claimed)return;edition=claimed;
      let snapshot:TrendingSnapshot;
      try{snapshot=await this.bounded(signal=>this.collector(this.config,signal));}
      catch(error){if(this.persistenceFailure(error))throw error;store.update(edition.id,e=>{e.state=e.attempts>=3?'failed':'collect_failed';e.code=e.attempts>=3?'collect_exhausted':'collect_failed';e.nextAttemptAt=this.now()+60_000;e.updatedAt=this.now();});return;}
      if(!this.enabled()){this.setState(edition.id,'collect_failed','collect_failed');return;}
      edition=store.update(edition.id,e=>{e.snapshot=snapshot;e.state='generating';e.updatedAt=this.now();});
      let digest:TrendingDigest;
      try{digest=await this.bounded(signal=>this.generator(this.config,snapshot,signal));}
      catch(error){if(this.persistenceFailure(error))throw error;this.setState(edition.id,'uncertain','generation_unknown');return;}
      if(!this.enabled()){this.setState(edition.id,'uncertain','generation_unknown');return;}
      if(!digest.sections?.length||digest.sections.some(s=>typeof s.text!=='string'||!s.text.trim())){this.setState(edition.id,'failed','digest_invalid');return;}
      edition=store.update(edition.id,e=>{e.digest=digest;e.state='ready';e.updatedAt=this.now();});
    }
    if(edition.state!=='ready'||preview||!this.enabled())return;
    if(!edition.manual){const due=dueAt(edition.date);if(this.now()<due)return;if(this.now()>=due+60*60_000){this.setState(edition.id,'expired','expired');return;}}
    if(!edition.parts){
      const late=!edition.manual&&this.now()>=dueAt(edition.date)+60_000;
      const text=`# GitHub Trending · ${edition.date}${edition.manual?' · 试运行':''}\n${late?'延迟补发：原定北京时间 09:00。\n':''}${edition.digest!.sections.map(s=>s.text).join('\n\n')}`;
      const parts=splitMarkdown(text);
      if(!parts.length||parts.length>5){this.setState(edition.id,'failed','digest_invalid');return;}
      edition=store.prepareParts(edition.id,parts,this.now());
    }
    for(const route of edition.routes){
      if(!this.enabled())return;
      const current=store.parts(edition.id,route);
      if(!current.some(part=>part.status==='pending')||current.some(part=>['sending','uncertain','rejected'].includes(part.status)))continue;
      await this.enqueueOutput(route,async()=>{
        const parts=store.parts(edition.id,route);
        if(parts.some(part=>['sending','uncertain','rejected'].includes(part.status)))return;
        for(const part of parts){
          if(part.status!=='pending')continue;
          if(!this.enabled())return;
          if(!edition.manual&&this.now()>=dueAt(edition.date)+60*60_000){this.setState(edition.id,'expired','expired');return;}
          if(!this.allowedRoutes().some(r=>routeKey(r)===routeKey(route))||!this.targets.some(r=>routeKey(r)===routeKey(route))){
            store.update(edition.id,e=>{e.code='route_unavailable';e.nextAttemptAt=this.now()+60_000;e.updatedAt=this.now();});return;
          }
          if(!store.beginPart(edition.id,route,part.index))continue;
          let result:DeliveryResult;
          try{result=await this.send({route,text:edition.parts![part.index]!,deliveryMode:'active',markdown:true,partIndex:part.index});}
          catch(error){if(this.persistenceFailure(error))throw error;result={status:'uncertain'};}
          const status=result.status==='sent'&&(!result.externalMessageId||!result.externalMessageId.trim())?'uncertain':result.status;
          store.ackPart(edition.id,route,part.index,status,result.status==='sent'&&status==='sent'?result.externalMessageId:undefined);
          if(status!=='sent'){store.update(edition.id,e=>{e.code=status==='uncertain'?'delivery_uncertain':'delivery_rejected';e.updatedAt=this.now();});return;}
        }
      });
    }
    if(store.get(edition.id)?.state!=='ready')return;
    const groups=edition.routes.map(route=>store.parts(edition.id,route)),parts=groups.flat();
    // An unknown/rejected segment stops that group's whole batch; other groups recover independently.
    if(groups.some(group=>!group.some(p=>['uncertain','rejected'].includes(p.status))&&group.some(p=>p.status==='pending'||p.status==='sending')))return;
    if(parts.some(p=>p.status==='uncertain'))this.setState(edition.id,'uncertain','delivery_uncertain');
    else if(parts.some(p=>p.status==='rejected'))this.setState(edition.id,'failed','delivery_rejected');
    else if(parts.length&&parts.every(p=>p.status==='sent'))this.setState(edition.id,'delivered');
  }
  /** Local operator entry only: an explicit manual ID cannot consume a scheduled date. */
  async runNow(options:TrendingRunOptions):Promise<{id:string;state:string;code?:TrendingCode;digest?:TrendingDigest}> {
    if(!this.enabled())throw new Error('Trending 服务未开启或已关闭。');
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(options.id))throw new Error('手工日报 id 必须为1到80位字母、数字、下划线或连字符。');
    const ids=options.groupIds??this.targets.map(r=>r.roomId);
    if(!ids.length||ids.some(id=>!this.targets.some(r=>r.roomId===id)))throw new Error('手工日报只能使用已配置的 Trending 群。');
    while(this.pending)await this.pending;
    if(!this.enabled())throw new Error('Trending 服务未开启或已关闭。');
    const id=`manual:${options.id}`,at=this.now();
    this.launch(async()=>{
      const store=this.storage(),routes=this.targets.filter(r=>ids.includes(r.roomId));
      let edition=store.requestManual(options.id,routes,at);
      edition=store.update(edition.id,e=>{e.preview=options.preview===true;});
      await this.process(edition,options.preview===true);
    });
    await this.wait();
    const edition=this.storage().get(id)!;
    return {id,state:this.status(edition),...(edition.code?{code:edition.code}:{}),...(edition.digest?{digest:edition.digest}:{})};
  }
  private status(edition:TrendingEdition):string {
    if(!edition.parts||edition.state==='expired')return edition.state;
    const parts=edition.routes.flatMap(route=>this.storage().parts(edition.id,route));
    if(parts.length&&parts.every(p=>p.status==='sent'))return 'sent';
    if(parts.some(p=>p.status==='uncertain'))return 'delivery_uncertain';
    if(parts.some(p=>p.status==='rejected'))return 'delivery_rejected';
    return parts.some(p=>p.status==='sent')?'partial':'ready';
  }
  info(){
    const at=this.now(),today=dayAt(at),due=dueAt(today),tomorrow=dueAt(dayAt(at+DAY))-300_000;
    let edition:TrendingEdition|undefined,status:string|undefined;
    try{edition=this.store?.latest();if(edition)status=this.status(edition);}catch(error){this.fail(error);}
    const terminal=edition?.date===today&&['delivered','failed','uncertain','expired'].includes(edition.state);
    const generated=edition?.date===today&&['generating','ready'].includes(edition.state);
    const nextRun=terminal||generated||at>=due+3_600_000?tomorrow:Math.max(due-300_000,at,edition?.nextAttemptAt??0);
    const nextSend=terminal||at>=due+3_600_000?tomorrow+300_000:Math.max(due,at,edition?.nextAttemptAt??0);
    return {enabled:this.config.trending?.enabled===true,started:Boolean(this.timer),running:Boolean(this.pending),failed:this.fatal||Boolean(edition?.code??this.lastCode),
      ...(edition?{latestDate:edition.date,status}:{}),...(this.lastCode??edition?.code?{errorCode:this.lastCode??edition?.code}:{}),
      nextDue:this.enabled()?new Date(Math.min(nextRun,nextSend)).toISOString():null,
      nextRunAt:this.enabled()?new Date(nextRun).toISOString():null,
      nextSendAt:this.enabled()?new Date(nextSend).toISOString():null};
  }
  async wait():Promise<void>{while(this.pending)await this.pending;}
  async close():Promise<void>{if(this.closed)return;this.closed=true;this.abort.abort();if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.wait();this.store?.close();this.store=undefined;}
}

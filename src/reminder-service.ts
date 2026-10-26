import {join} from 'node:path';
import type {PaConfig} from './config.js';
import type {ChannelRoute,DeliveryResult,OutboundMessage} from './channel-types.js';
import {ConversationStore} from './store.js';
import {MemoryError} from './memory-types.js';
import type {ReminderToolContext,ReminderToolName} from './reminder-tools.js';
import type {ReminderInput,WorkItem} from './work-ledger-types.js';
import {requestTimeData} from './request-time.js';

const routeKey=(r:ChannelRoute)=>JSON.stringify([r.channel,r.accountId,r.roomType,r.roomId]);
const publicItem=(w:WorkItem)=>({id:w.id,goal:w.goal,remindAt:w.remindAt,timeZone:w.timezone,
  status:w.status==='completed' ? (w.notificationStatus?{queued:'awaiting_delivery',sending:'sending',uncertain:'delivery_uncertain',rejected:'delivery_rejected',sent:'sent'}[w.notificationStatus]:'delivery_unconfirmed') : w.status,
  ...(w.notificationStatus?{notificationStatus:w.notificationStatus}:{}),version:w.version});
const displayTime=(iso:string)=>requestTimeData(new Date(iso)).currentTime.replace('T',' ').replace('+08:00','');
// Only the separately supplied, trusted sender can become a QQ @ target.
const safeText=(text:string)=>text.replace(/<(?=\/?(?:qqbot-|@))/gi,'〈');

/** The clock and transport are ordinary program work; no model/runtime is imported. */
export class ReminderService {
  private store:ConversationStore|undefined;
  private closed=false;
  private timer:ReturnType<typeof setInterval>|undefined;
  private polling=false;
  private fatal:unknown;
  private readonly sending=new Map<string,Promise<void>>();
  constructor(private readonly config:Pick<PaConfig,'dataDir'>,
    private readonly allowedRoutes:()=>readonly ChannelRoute[],
    private readonly enqueueOutput:(route:ChannelRoute,operation:()=>Promise<void>)=>Promise<void>,
    private readonly send:(message:OutboundMessage)=>Promise<DeliveryResult>,
    private readonly onError:(error:unknown)=>void,
    private readonly now:()=>number=Date.now) {}

  private storage():ConversationStore {
    if(this.closed)throw new MemoryError('提醒服务已经关闭。');
    if(this.fatal)throw this.fatal;
    return this.store??=new ConversationStore(join(this.config.dataDir,'pa.sqlite'));
  }

  context(conversationId:string,sourceMessageId:string,sourceText:string):ReminderToolContext {
    return {execute:(name,params)=>this.execute(conversationId,sourceMessageId,sourceText,name,params)};
  }

  private execute(conversationId:string,sourceMessageId:string,sourceText:string,name:ReminderToolName,params:unknown):unknown {
    if(!params||typeof params!=='object'||Array.isArray(params))throw new MemoryError('提醒参数必须是对象。');
    const p=params as Record<string,unknown>,ledger=this.storage().workLedger;
    const keys={create_reminder:['key','goal','remindAt','timezone','requestQuote'],list_reminders:['offset','limit'],get_reminder:['id'],cancel_reminder:['id']}[name];
    if(!keys||Object.keys(p).some(k=>!keys.includes(k)))throw new MemoryError('提醒参数包含未允许字段。');
    if(name==='create_reminder') {
      if(typeof p.requestQuote!=='string'||!p.requestQuote.trim()||!sourceText.includes(p.requestQuote))
        throw new MemoryError('请依据当前发言者本条消息明确交代的提醒；引用、历史和画像不能自行授权创建。');
      const input={key:p.key,goal:p.goal,remindAt:p.remindAt,timezone:p.timezone} as ReminderInput;
      const work=ledger.createReminder(conversationId,sourceMessageId,input);
      if(work.status!=='scheduled'&&work.status!=='running')
        return {...publicItem(work),saved:false,confirmation:'该提醒已经处理或取消，本次没有重新安排。'};
      return {...publicItem(work),saved:true,confirmation:`已安排：北京时间 ${displayTime(work.remindAt)}，在原${work.sourceRoute.roomType==='group'?'群聊':'私聊'}提醒你「${safeText(work.goal)}」。默认提醒一次。`};
    }
    if(name==='list_reminders') {
      const offset=p.offset??0,limit=p.limit??20;
      if(!Number.isSafeInteger(offset)||Number(offset)<0||Number(offset)>1_000_000||!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>20)
        throw new MemoryError('提醒列表范围无效。');
      const all=ledger.listReminders(conversationId,sourceMessageId,{offset:Number(offset),limit:Number(limit)+1});
      return {items:all.slice(0,Number(limit)).map(publicItem),scope:'本人且当前场景可见的提醒',more:all.length>Number(limit),
        ...(all.length>Number(limit)?{nextOffset:Number(offset)+Number(limit)}:{})};
    }
    if(typeof p.id!=='string'||p.id.length>100)throw new MemoryError('提醒编号无效。');
    const work=ledger.getReminder(conversationId,sourceMessageId,p.id);
    if(name==='get_reminder')return publicItem(work);
    const cancelled=ledger.cancelReminder(conversationId,sourceMessageId,p.id,work.version);
    const accepted=['cancelled','cancel_requested'].includes(cancelled.status);
    return {...publicItem(cancelled),cancelled:accepted,confirmation:accepted?'已取消这项提醒，不再安排后续发送。':'通知已经开始发送或已有结果，不能撤回；不会自动重复发送。'};
  }

  start():void {
    if(this.closed||this.timer)return;
    this.storage();
    this.timer=setInterval(()=>this.poll(),1000);this.timer.unref();this.poll();
  }

  /** Bounded local work; the network operations proceed separately per room. */
  poll():void {
    if(this.closed||this.fatal||this.polling)return;
    this.polling=true;
    try {
      const ledger=this.storage().workLedger,at=this.now(),routes=this.allowedRoutes();
      // Do not expire our own live sends. Transport has its own bounded timeout.
      if(!this.sending.size)ledger.recoverAfterRestart(at);
      ledger.purgeExpiredReceipts(at);
      for(let i=0;i<20;i++) {
        const lease=ledger.claimDue(at,routes);if(!lease)break;
        ledger.completeReminder(lease,at,routes);
      }
      for(const notice of ledger.listPendingNotifications(100)) {
        if(this.sending.size>=2)break;
        const key=routeKey(notice.route);if(this.sending.has(key))continue;
        const pending=Promise.resolve().then(()=>this.enqueueOutput(notice.route,async()=>{
          if(this.closed||this.fatal)return; // Still queued, so a restart can discover it.
          let current;
          try {current=ledger.beginNotification(notice.id,this.now(),this.allowedRoutes());}
          catch(error) {
            if(error instanceof MemoryError&&['通知不处于可发送状态。','提醒已取消或状态不可通知。','通知不存在。'].includes(error.message))return;
            throw error;
          }
          if(current.status!=='sending')return;
          const late=this.now()-Date.parse(current.remindAt)>=60_000;
          const text=safeText(current.text)+(late?`\n原定北京时间 ${displayTime(current.remindAt)}，现补提醒一次。`:'');
          let outcome:DeliveryResult;
          try {outcome=await this.send({route:current.route,deliveryMode:'active',plainText:true,text,
            ...(current.route.roomType==='group'?{mentionSenderId:current.senderId}:{})});}
          catch {outcome={status:'uncertain'};}
          ledger.ackNotification(current.id,outcome.status,this.now(),outcome.status==='sent'?outcome.externalMessageId:undefined);
        })).catch(error=>this.fail(error)).finally(()=>this.sending.delete(key));
        this.sending.set(key,pending);
      }
    }catch(error){this.fail(error);}finally{this.polling=false;}
  }

  private fail(error:unknown):void {this.fatal=error;if(this.timer)clearInterval(this.timer);this.timer=undefined;this.onError(error);}
  info(){return {started:Boolean(this.timer),sending:this.sending.size,failed:Boolean(this.fatal)};}
  async wait():Promise<void>{await Promise.all([...this.sending.values()]);}
  async close():Promise<void>{this.closed=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.wait();this.store?.close();this.store=undefined;}
}

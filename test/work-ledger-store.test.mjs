import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { WorkLedgerStore, migrateReminderDelivery, REMINDER_RECEIPT_RETENTION_MS } from '../dist/work-ledger-store.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'pa-ledger-')), path=join(dir,'db.sqlite');
  let conversationStore=new ConversationStore(path);
  const route={channel:'qq',accountId:'bot',roomId:'room-a',roomType:'private'};
  const otherRoute={...route,roomId:'room-b'};
  const groupRoute={...route,roomId:'group-a',roomType:'group'};
  const conversation=conversationStore.ensureConversation('a','/pi/a.jsonl',route);
  const other=conversationStore.ensureConversation('b','/pi/b.jsonl',otherRoute);
  const group=conversationStore.ensureConversation('group','/pi/group.jsonl',groupRoute);
  conversationStore.recordInbound(conversation.id,'source one',{eventId:'e1',senderId:'alice',modelInputText:'source one'});
  conversationStore.recordInbound(other.id,'source two',{eventId:'e2',senderId:'alice',modelInputText:'source two'});
  conversationStore.recordInbound(other.id,'other person',{eventId:'e3',senderId:'bob',modelInputText:'other person'});
  conversationStore.recordInbound(group.id,'group source',{eventId:'e4',senderId:'alice',modelInputText:'group source'});
  conversationStore.configurePersons([{id:'person-a',bindings:[{route,senderId:'alice'},{route:otherRoute,senderId:'alice'},{route:groupRoute,senderId:'alice'}]},{id:'person-b',bindings:[{route:otherRoute,senderId:'bob'}]}]);
  const db=new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  assert.equal(db.prepare(`SELECT version FROM maintenance_contracts WHERE domain='work-ledger'`).get().version,2);
  const source1=conversationStore.externalMessage(conversation.id,'e1').id,
    source2=conversationStore.externalMessage(other.id,'e2').id, sourceBob=conversationStore.externalMessage(other.id,'e3').id;
  const sourceGroup=conversationStore.externalMessage(group.id,'e4').id;
  const result={db,get conversationStore(){return conversationStore;},get ledger(){return conversationStore.workLedger;},path,route,otherRoute,groupRoute,conversation,other,group,source1,source2,sourceBob,sourceGroup,
    reopen(){conversationStore.close();conversationStore=new ConversationStore(path);}};
  t.after(()=>{db.close();conversationStore.close();rmSync(dir,{recursive:true,force:true});});
  return result;
}
const dueAt=()=>new Date(Date.now()+60*60*1000).toISOString();
const input=(key='k1',remindAt=dueAt())=>({key,goal:'提交周报',remindAt,timezone:'Asia/Shanghai'});

test('提醒按真实人物授权，同人物跨场景查询但不迁移通知路由，幂等并拒绝冲突',t=>{
  const f=fixture(t), spec=input(), work=f.ledger.createReminder(f.conversation.id,f.source1,spec);
  assert.throws(()=>f.ledger.createReminder(f.conversation.id,f.source1,{...input('invalid'),remindAt:'2028-02-30T12:00:00Z'}),/有效/);
  for(const value of ['明天15点','2028-01-01T15:00:00','2028-01-01T25:00:00+08:00','2028-01-01T15:00:00+25:00']) {
    assert.throws(()=>f.ledger.createReminder(f.conversation.id,f.source1,{...spec,key:'invalid',remindAt:value}),/有效/);
  }
  assert.throws(()=>f.ledger.createReminder(f.conversation.id,f.source1,{...spec,key:'past',remindAt:new Date(Date.now()-60_000).toISOString()}),/晚于当前/);
  const beforeTime=f.db.prepare('SELECT count(*) n FROM work_items').get().n;
  const beijing=new Date(Date.parse(spec.remindAt)+8*3600_000).toISOString().replace('Z','+08:00');
  assert.equal(f.ledger.createReminder(f.conversation.id,f.source1,{...spec,remindAt:beijing}).id,work.id,'同一绝对时刻的Z和+08:00应幂等');
  assert.equal(f.db.prepare('SELECT remind_at FROM work_items WHERE id=?').get(work.id).remind_at,Date.parse(spec.remindAt));
  assert.equal(f.db.prepare('SELECT count(*) n FROM work_items').get().n,beforeTime);
  assert.throws(()=>f.ledger.claimDue(9e15,[f.route]),/时间参数/);
  assert.equal(work.ownerPersonId,'person-a'); assert.deepEqual(work.sourceRoute,f.route);
  assert.equal(f.ledger.createReminder(f.conversation.id,f.source1,spec).id,work.id);
  assert.throws(()=>f.ledger.createReminder(f.conversation.id,f.source1,{...spec,goal:'不同目标'}),/幂等键/);
  assert.equal(f.ledger.listReminders(f.other.id,f.source2)[0].id,work.id);
  assert.deepEqual(f.ledger.listReminders(f.group.id,f.sourceGroup),[]);
  assert.throws(()=>f.ledger.getReminder(f.group.id,f.sourceGroup,work.id),/不存在/);
  assert.throws(()=>f.ledger.cancelReminder(f.group.id,f.sourceGroup,work.id,work.version),/不存在/);
  const groupWork=f.ledger.createReminder(f.group.id,f.sourceGroup,input('group-key'));
  assert.deepEqual(f.ledger.listReminders(f.group.id,f.sourceGroup).map(item=>item.id),[groupWork.id]);
  const bobWork=f.ledger.createReminder(f.other.id,f.sourceBob,input('bob-key'));
  assert.throws(()=>f.ledger.getReminder(f.other.id,f.sourceBob,work.id),/不存在/);
  assert.equal(f.ledger.getReminder(f.other.id,f.sourceBob,bobWork.id).ownerPersonId,'person-b');
  assert.equal(f.db.prepare('SELECT text FROM messages WHERE id=?').get(f.source1).text,'source one');
});

test('身份重绑不把相同原始来源和幂等键转移给新人物',t=>{
  const f=fixture(t), spec=input(), original=f.ledger.createReminder(f.conversation.id,f.source1,spec);
  f.db.prepare(`UPDATE actor_person_bindings SET person_id='person-b' WHERE actor_id=(SELECT actor_id FROM messages WHERE id=?)`).run(f.source1);
  assert.throws(()=>f.ledger.createReminder(f.conversation.id,f.source1,spec),/幂等键/);
  assert.equal(f.ledger.getReminder(f.other.id,f.source2,original.id).ownerPersonId,'person-a');
});

test('到期查询命中部分索引，双连接领取不重复且提交检查 lease/version/授权',t=>{
  const f=fixture(t), work=f.ledger.createReminder(f.conversation.id,f.source1,input());
  const plan=f.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM work_items WHERE kind='reminder' AND status='scheduled' AND remind_at<=? ORDER BY remind_at,id LIMIT 1").all(Date.parse('2026-10-28'));
  assert.match(plan.map(x=>x.detail).join(' '),/work_reminders_due/);
  const secondDb=new DatabaseSync(f.path); // second SQLite connection to the same file
  const second=new WorkLedgerStore(secondDb,fn=>{secondDb.exec('BEGIN IMMEDIATE');try{const v=fn();secondDb.exec('COMMIT');return v}catch(e){secondDb.exec('ROLLBACK');throw e;}});
  try {
    const now=new Date(Date.now()+2*60*60*1000).toISOString(), lease=f.ledger.claimDue(now,[f.route]);
    assert.ok(lease); assert.equal(second.claimDue(now,[f.route]),null);
    assert.throws(()=>f.ledger.completeReminder({...lease,token:'stale'},now,[f.route]),/租约/);
    assert.throws(()=>f.ledger.completeReminder(lease,now,[f.otherRoute]),/授权/);
    const notice=f.ledger.completeReminder({...lease,route:f.otherRoute},now,[f.route]); assert.equal(notice.route.roomId,'room-a');
    assert.equal(notice.senderId,'alice'); assert.equal(notice.remindAt,work.remindAt);
    const sending=f.ledger.beginNotification(notice.id,now,[f.route]); assert.equal(sending.status,'sending');
    assert.throws(()=>f.ledger.ackNotification(notice.id,'sent',now),/外部消息编号/);
    assert.equal(f.ledger.ackNotification(notice.id,'sent',now,'qq-delivered-1').status,'sent');
    assert.throws(()=>f.ledger.cancelReminder(f.conversation.id,f.source1,work.id,lease.version),/不存在/);
  } finally {secondDb.close();}
  assert.throws(()=>f.ledger.getReminder(f.conversation.id,f.source1,work.id),/不存在/);
  for(const table of ['work_items','work_authorizations','work_attempts','work_events','work_notifications'])
    assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
  assert.equal(f.db.prepare('SELECT text FROM messages WHERE id=?').get(f.source1).text,'source one');
  const pendingWork=f.ledger.createReminder(f.conversation.id,f.source1,input('pending'));
  const pendingLease=f.ledger.claimDue(new Date(Date.now()+2*60*60*1000).toISOString(),[f.route]);
  const pending=f.ledger.completeReminder(pendingLease,new Date(Date.now()+2*60*60*1000).toISOString(),[f.route]);
  assert.equal(f.ledger.cancelReminder(f.conversation.id,f.source1,pendingWork.id,pendingWork.version).status,'cancelled');
  assert.equal(f.db.prepare('SELECT status FROM work_notifications WHERE id=?').get(pending.id).status,'rejected');
});

test('版本取消阻止迟到 worker；撤销来源绑定后不执行；重启未知通知不重发',t=>{
  const f=fixture(t), work=f.ledger.createReminder(f.conversation.id,f.source1,input());
  const due=new Date(Date.now()+2*60*60*1000).toISOString(), lease=f.ledger.claimDue(due,[f.route]);
  const cancelled=f.ledger.cancelReminder(f.conversation.id,f.source1,work.id,work.version);
  assert.equal(cancelled.status,'cancel_requested');
  assert.throws(()=>f.ledger.completeReminder(lease,due,[f.route]),/租约/);
  f.ledger.recoverAfterRestart(new Date(Date.now()+2*60*60*1000+61_000).toISOString());
  assert.equal(f.ledger.getReminder(f.conversation.id,f.source1,work.id).status,'cancelled');

  const second=f.ledger.createReminder(f.conversation.id,f.source1,input('k2'));
  f.db.prepare('DELETE FROM actor_person_bindings WHERE actor_id=(SELECT actor_id FROM messages WHERE id=?)').run(f.source1);
  assert.equal(f.ledger.claimDue(due,[f.route]),null);
  assert.equal(f.ledger.getReminder(f.other.id,f.source2,second.id).status,'waiting_user');

  // A valid reminder demonstrates that a process restart converts an in-flight send to uncertain.
  f.db.prepare('INSERT INTO actor_person_bindings SELECT a.id,? FROM actors a JOIN messages m ON m.actor_id=a.id WHERE m.id=?').run('person-a',f.source1);
  const third=f.ledger.createReminder(f.conversation.id,f.source1,input('k3'));
  const later=new Date(Date.now()+3*60*60*1000).toISOString(), l=f.ledger.claimDue(later,[f.route]), n=f.ledger.completeReminder(l,later,[f.route]);
  assert.deepEqual(f.ledger.listPendingNotifications().map(item=>item.id),[n.id]);
  f.reopen();
  assert.deepEqual(f.ledger.listPendingNotifications().map(item=>item.id),[n.id]);
  f.ledger.beginNotification(n.id,later,[f.route]);
  const competingDb=new DatabaseSync(f.path), competing=new WorkLedgerStore(competingDb,fn=>{competingDb.exec('BEGIN IMMEDIATE');try{const value=fn();competingDb.exec('COMMIT');return value}catch(error){competingDb.exec('ROLLBACK');throw error;}});
  assert.throws(()=>competing.beginNotification(n.id,later,[f.route]),/可发送状态/);
  competingDb.close();
  f.ledger.recoverAfterRestart(new Date(Date.now()+3*60*60*1000+61_000).toISOString());
  assert.throws(()=>f.ledger.beginNotification(n.id,new Date(Date.now()+3*60*60*1000+2000).toISOString(),[f.route]),/可发送状态/);
  assert.deepEqual(f.ledger.listPendingNotifications(),[]);
  assert.equal(f.db.prepare('SELECT status FROM work_notifications WHERE id=?').get(n.id).status,'uncertain');
  assert.equal(f.ledger.getReminder(f.conversation.id,f.source1,third.id).status,'completed');
});

test('送达事务失败保留 sending 和正文；成功仅留短期无正文回执并拒绝同来源重排',t=>{
  const f=fixture(t), spec=input(), work=f.ledger.createReminder(f.group.id,f.sourceGroup,spec);
  const at=Date.now()+2*60*60*1000, lease=f.ledger.claimDue(at,[f.groupRoute]);
  const notice=f.ledger.completeReminder(lease,at,[f.groupRoute]);
  assert.equal(notice.senderId,'alice'); assert.equal(notice.remindAt,spec.remindAt);
  f.ledger.beginNotification(notice.id,at,[f.groupRoute]);
  f.db.exec(`CREATE TRIGGER fail_reminder_cleanup BEFORE DELETE ON work_items BEGIN SELECT RAISE(ABORT,'cleanup failed'); END;`);
  assert.throws(()=>f.ledger.ackNotification(notice.id,'sent',at,'external-1'),/cleanup failed/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM work_delivery_receipts').get().n,0);
  assert.equal(f.db.prepare('SELECT status,text FROM work_notifications WHERE id=?').get(notice.id).status,'sending');
  assert.equal(f.ledger.getReminder(f.group.id,f.sourceGroup,work.id).goal,spec.goal);
  f.db.exec('DROP TRIGGER fail_reminder_cleanup');
  const sent=f.ledger.ackNotification(notice.id,'sent',at,'external-1');
  assert.equal(sent.status,'sent'); assert.equal(sent.text,notice.text);
  const receipt=f.db.prepare('SELECT * FROM work_delivery_receipts WHERE work_id=?').get(work.id);
  assert.equal(receipt.external_message_id,'external-1'); assert.equal(receipt.result,'sent');
  assert.equal(receipt.expires_at,at+REMINDER_RECEIPT_RETENTION_MS);
  assert.equal(Object.hasOwn(receipt,'text'),false); assert.equal(Object.hasOwn(receipt,'goal'),false);
  assert.throws(()=>f.ledger.createReminder(f.group.id,f.sourceGroup,spec),/已提醒/);
  assert.throws(()=>f.ledger.createReminder(f.group.id,f.sourceGroup,{...spec,goal:'其他事项'}),/幂等键/);
  f.db.prepare(`UPDATE actor_person_bindings SET person_id='person-b' WHERE actor_id=(SELECT actor_id FROM messages WHERE id=?)`).run(f.sourceGroup);
  assert.throws(()=>f.ledger.createReminder(f.group.id,f.sourceGroup,spec),/幂等键/);
  assert.equal(f.ledger.purgeExpiredReceipts(receipt.expires_at-1),0);
  assert.equal(f.ledger.purgeExpiredReceipts(receipt.expires_at),1);
  assert.equal(f.db.prepare('SELECT text FROM messages WHERE id=?').get(f.sourceGroup).text,'group source');
});

test('发送前复核真实绑定，失败和未知正文不清理；本地租约恢复及回执清理有界',t=>{
  const f=fixture(t), at=Date.now()+2*60*60*1000;
  const work=f.ledger.createReminder(f.group.id,f.sourceGroup,input('group'));
  const lease=f.ledger.claimDue(at,[f.groupRoute]), notification=f.ledger.completeReminder(lease,at,[f.groupRoute]);
  f.db.prepare(`UPDATE actor_person_bindings SET person_id='person-b' WHERE actor_id=(SELECT actor_id FROM messages WHERE id=?)`).run(f.sourceGroup);
  assert.equal(f.ledger.beginNotification(notification.id,at,[f.groupRoute]).status,'rejected');
  assert.equal(f.db.prepare('SELECT status FROM work_items WHERE id=?').get(work.id).status,'completed');
  assert.equal(f.db.prepare('SELECT text FROM work_notifications WHERE id=?').get(notification.id).text,notification.text);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM work_delivery_receipts').get().n,0);
  const local=f.ledger.createReminder(f.conversation.id,f.source1,input('local'));
  f.ledger.claimDue(at,[f.route]);
  f.ledger.recoverAfterRestart(at+61_000);
  assert.equal(f.ledger.getReminder(f.conversation.id,f.source1,local.id).status,'scheduled');
  for(const [sql,index] of [
    ["SELECT id FROM work_notifications WHERE status='sending' AND lease_until<=? ORDER BY lease_until,id LIMIT 100",'work_notifications_sending_expiry'],
    ["SELECT work_id FROM work_attempts WHERE status='running' AND lease_until<=? ORDER BY lease_until,work_id,attempt LIMIT 100",'work_attempts_running_expiry'],
    ['SELECT work_id FROM work_delivery_receipts WHERE expires_at<=? ORDER BY expires_at,work_id LIMIT 100','work_delivery_receipts_expiry']
  ]) assert.match(f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(at).map(row=>row.detail).join(' '),new RegExp(index));
  const insert=f.db.prepare(`INSERT INTO work_delivery_receipts VALUES(?,?,?,?,?,?,'sent',?,?,?)`);
  for(let i=0;i<101;i++) insert.run(`w${i}`,`m${i}`,'key','person-a','hash',`n${i}`,`external${i}`,at-1,at);
  assert.equal(f.ledger.purgeExpiredReceipts(at),100); assert.equal(f.ledger.purgeExpiredReceipts(at),1);
  assert.throws(()=>migrateReminderDelivery(f.db),/契约版本 1/);
});

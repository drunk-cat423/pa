import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { WorkLedgerStore } from '../dist/work-ledger-store.js';

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
    const notice=f.ledger.completeReminder(lease,now,[f.route]); assert.equal(notice.route.roomId,'room-a');
    const sending=f.ledger.beginNotification(notice.id,now,[f.route]); assert.equal(sending.status,'sending');
    assert.equal(f.ledger.ackNotification(notice.id,'sent',now).status,'sent');
    assert.equal(f.ledger.cancelReminder(f.conversation.id,f.source1,work.id,lease.version).status,'completed');
  } finally {secondDb.close();}
  assert.equal(f.ledger.getReminder(f.conversation.id,f.source1,work.id).status,'completed');
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

import { downgradeSchema14 } from './fixtures/legacy-schema.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { BackgroundMemory } from '../dist/auto-memory.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'pa-reclassification-')),path=join(dir,'pa.sqlite');
  let store=new ConversationStore(path),counter=0;
  const route={channel:'qq',accountId:'bot',roomType:'group',roomId:'one'};
  const room=store.ensureConversation('one','/one.jsonl',route);
  const other=store.ensureConversation('two','/two.jsonl',{...route,roomId:'two'});
  const policy={version:1,ownerBindings:[{route,senderId:'owner'}]};
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const inspect=fn=>{const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}};
  const note=(content='以后rsi指的是recursive self improvement',senderId='owner',inRoom=room)=>{
    const input={eventId:`source-${++counter}`,senderId,modelInputText:`/self ${content}`};
    store.recordInbound(inRoom.id,input.modelInputText,input);
    const source=store.externalMessage(inRoom.id,input.eventId);
    store.autoMemory.selfProfile.addPending(source.id,content);
    const pending=store.autoMemory.selfProfile.snapshot().pending.find(p=>p.sourceMessageId===source.id);
    return {source,pending,move:{pendingId:pending.id,expectedContent:content,key:'RSI'}};
  };
  return {dir,path,route,room,other,policy,inspect,note,get store(){return store;},restart(){store.close();store=new ConversationStore(path);}};
}

test('术语转入原群规则；保留原文、pending和旧版本，重启与重复执行不重复迁移',t=>{
  const f=fixture(t),term=f.note(),style=f.note('优先考虑AI和Agent领域');
  const before=f.inspect(db=>({messages:db.prepare('SELECT * FROM messages ORDER BY rowid').all(),pending:db.prepare('SELECT * FROM self_profile_pending ORDER BY rowid').all(),revisions:db.prepare('SELECT * FROM self_profile_revisions').all()}));
  const result=f.store.reclassifySelfProfileTerms([term.move],f.policy,0);
  assert.deepEqual(result,{revision:1,moved:1});
  assert.deepEqual(f.store.autoMemory.selfProfile.snapshot().pending.map(p=>p.id),[style.pending.id]);
  assert.deepEqual(f.store.roomRules(f.room.id),[{key:'rsi',content:term.pending.content}]);
  assert.deepEqual(f.store.roomRules(f.other.id),[]);
  f.inspect(db=>{
    assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY rowid').all(),before.messages);
    assert.deepEqual(db.prepare('SELECT * FROM self_profile_pending ORDER BY rowid').all(),before.pending);
    assert.deepEqual(db.prepare('SELECT * FROM self_profile_revisions WHERE revision=0').all(),before.revisions);
    const audit=db.prepare('SELECT * FROM self_profile_reclassifications').get();
    assert.equal(audit.source_message_id,term.source.id);assert.equal(audit.from_revision,0);assert.equal(audit.to_revision,1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  });
  f.restart();
  assert.deepEqual(f.store.reclassifySelfProfileTerms([term.move],f.policy,0),{revision:1,moved:0});
  f.store.autoMemory.selfProfile.addPending(term.source.id,term.pending.content);
  assert.deepEqual(f.store.autoMemory.selfProfile.snapshot().pending.map(p=>p.id),[style.pending.id]);
});

test('普通成员或仅在其他群有权限的来源不能变成群规则，私聊不会被外推到群',t=>{
  const f=fixture(t),member=f.note(undefined,'member'),other=f.note(undefined,'owner',f.other);
  const privateRoom=f.store.ensureConversation('private','/private.jsonl',{...f.route,roomType:'private',roomId:'owner'});
  const priv=f.note(undefined,'owner',privateRoom);
  for(const term of [member,other,priv]) {
    assert.throws(()=>f.store.reclassifySelfProfileTerms([term.move],f.policy,0),/来源群.*维护者/);
  }
  assert.equal(f.store.autoMemory.selfProfile.snapshot().baseVersion,0);
  assert.deepEqual(f.store.roomRules(f.room.id),[]);
});

test('目标已有更新版本时整批回滚，不能用历史约定覆盖新规则',t=>{
  const f=fixture(t),first=f.note('以后pa代表personal agent'),second=f.note();
  const text='rsi是本群已有的新定义';
  f.store.recordInbound(f.room.id,text,{eventId:'new-rule',senderId:'owner',modelInputText:text});
  const source=f.store.externalMessage(f.room.id,'new-rule');
  f.store.prepareTurn(f.room.id,source.id,{intent:'memory_update',mode:'casual',updates:[{target:'room_rule',key:'rsi',content:text}]},f.policy);
  const snapshot=f.store.autoMemory.selfProfile.snapshot();
  assert.throws(()=>f.store.reclassifySelfProfileTerms([{...first.move,key:'pa'},second.move],f.policy,0),/现行版本/);
  assert.deepEqual(f.store.autoMemory.selfProfile.snapshot(),snapshot);
  assert.deepEqual(f.store.roomRules(f.room.id),[{key:'rsi',content:text}]);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM self_profile_reclassifications').get().n),0);
});

test('迁移验证预期原文、当前版本和计划；已有归档不做猜测式改写',t=>{
  const f=fixture(t),term=f.note();
  assert.throws(()=>f.store.reclassifySelfProfileTerms([{...term.move,expectedContent:'虚构文字'}],f.policy,0),/原文不匹配/);
  assert.throws(()=>f.store.reclassifySelfProfileTerms([term.move],f.policy,3),/版本冲突/);
  assert.throws(()=>f.store.reclassifySelfProfileTerms([term.move,term.move],f.policy,0),/计划无效/);
  const snapshot=f.store.autoMemory.selfProfile.snapshot();
  f.store.autoMemory.selfProfile.commit(snapshot,{baseVersion:0,content:'归档文字',sourceMessageIds:[term.source.id],pendingIds:[term.pending.id]},[]);
  assert.throws(()=>f.store.reclassifySelfProfileTerms([term.move],f.policy,1),/已有归档/);
  assert.equal(f.store.autoMemory.selfProfile.snapshot().content,'归档文字');
});

test('不修改已捕获的后台输入；旧快照或原文不能把已迁移术语重新写入AI画像',t=>{
  const f=fixture(t),term=f.note();
  f.store.autoMemory.reserveBatch(f.room.id,'capacity');
  const job=f.store.autoMemory.claimNext(f.room.id,{owner:'test',leaseMs:60000});
  const input=f.store.autoMemory.taskInput(job);
  const frozen=f.inspect(db=>db.prepare('SELECT input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id));
  f.store.reclassifySelfProfileTerms([term.move],f.policy,0);
  assert.deepEqual(f.inspect(db=>db.prepare('SELECT input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id)),frozen);
  const proposal={baseVersion:0,content:'RSI术语',sourceMessageIds:[term.source.id],pendingIds:[term.pending.id]};
  assert.throws(()=>f.store.autoMemory.selfProfile.commit(input.selfProfile,proposal,input.messages),/已迁入群规则/);
  const next=f.store.autoMemory.selfProfile.snapshot();
  assert.throws(()=>f.store.autoMemory.selfProfile.commit(next,{...proposal,baseVersion:next.baseVersion,pendingIds:[]},input.messages),/已迁入群规则/);
  assert.equal(f.store.autoMemory.selfProfile.snapshot().content,'');
});

test('迁移后在途旧产物按输入版本冲突失败，显式重试可重新读取资料且不自动收费重试',async t=>{
  const f=fixture(t),term=f.note();
  let release,started,calls=0;
  const gate=new Promise(resolve=>{release=resolve;}),begun=new Promise(resolve=>{started=resolve;});
  const background=new BackgroundMemory({contextWindow:1000000,memory:{enabled:true,maxCalls:3,maxRetries:1,timeoutMs:5000}},
    f.store.autoMemory,f.room.id,{extract:async input=>{
      calls++;
      if(calls===1){started();await gate;}
      else assert.equal(input.selfProfile.pending.length,0);
      return {continuationSummary:'继续对话',topics:[],fragments:[],profiles:[],ignoredMessageIds:input.messages.filter(m=>m.role==='user').map(m=>m.id),
        ...(calls===1?{selfProfile:{baseVersion:input.selfProfile.baseVersion,content:term.pending.content,
          sourceMessageIds:[term.source.id],pendingIds:[term.pending.id]}}:{})};
    }});
  try {
    background.start('capacity');await begun;
    const job=f.store.autoMemory.listJobs()[0];
    const membership=f.inspect(db=>db.prepare('SELECT message_id FROM auto_memory_job_messages WHERE job_id=?').all(job.id));
    f.store.reclassifySelfProfileTerms([term.move],f.policy,0);release();
    await assert.rejects(background.wait(undefined,3000),/失败/);
    assert.equal(calls,1);
    const failed=f.inspect(db=>db.prepare('SELECT status,input_json,progress_json,error FROM auto_memory_jobs WHERE id=?').get(job.id));
    assert.equal(failed.status,'failed');assert.equal(failed.input_json,null);assert.equal(failed.progress_json,null);
    assert.match(failed.error,/profile_conflict/);
    background.retry(job.id);await background.wait(undefined,3000);
    assert.equal(calls,2);assert.equal(f.store.autoMemory.status(f.room.id).completed,1);
    assert.deepEqual(f.inspect(db=>db.prepare('SELECT message_id FROM auto_memory_job_messages WHERE job_id=?').all(job.id)),membership);
    assert.equal(f.store.autoMemory.selfProfile.snapshot().content,'');
  } finally {release();await background.close();}
});

test('规则容量超限回滚，画像和迁移审计保持原状',t=>{
  const f=fixture(t),term=f.note();
  f.inspect(db=>{const insert=db.prepare('INSERT INTO room_rule_revisions VALUES (?,?,?,?,?,?)');for(let i=0;i<50;i++)insert.run(f.room.id,`key-${i}`,1,'已有规则',term.source.id,new Date().toISOString());});
  assert.throws(()=>f.store.reclassifySelfProfileTerms([term.move],f.policy,0),/容量已满/);
  assert.equal(f.store.autoMemory.selfProfile.snapshot().baseVersion,0);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM self_profile_reclassifications').get().n),0);
});

test('相同目标复用既有规则版本，重复执行不能改写迁移去向',t=>{
  const f=fixture(t),term=f.note();
  f.store.prepareTurn(f.room.id,term.source.id,{intent:'memory_update',mode:'casual',updates:[
    {target:'room_rule',key:'rsi',content:term.pending.content},
  ]},f.policy);
  assert.deepEqual(f.store.reclassifySelfProfileTerms([term.move],f.policy,0),{revision:1,moved:1});
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM room_rule_revisions').get().n),1);
  assert.throws(()=>f.store.reclassifySelfProfileTerms([{...term.move,key:'another'}],f.policy,1),/去向不匹配/);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM self_profile_reclassifications').get().n),1);
});

test('v11升级只新增审计结构并保留历史，升级前创建一致性备份',t=>{
  const f=fixture(t),term=f.note();
  const pending=f.store.autoMemory.selfProfile.snapshot().pending;
  f.store.close();
  f.inspect(db=>{downgradeSchema14(db);db.exec('DROP TABLE person_profile_pending_results;DROP TABLE person_profile_revision_sources;DROP TABLE auto_memory_job_deferrals;DROP TABLE self_profile_reclassifications;PRAGMA user_version=11;');});
  f.restart();
  assert.equal(f.inspect(db=>db.prepare('PRAGMA user_version').get().user_version),17);
  assert.deepEqual(f.store.autoMemory.selfProfile.snapshot().pending,pending);
  assert.equal(f.store.externalMessage(f.room.id,term.source.eventId??'source-1').text,term.source.text);
  assert.ok(readdirSync(f.dir).some(name=>name.includes('.v11.')&&name.endsWith('.bak')));
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const budget = { maxModelCalls:12,maxToolCalls:24,maxSearchCalls:6 };
function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'pa-research-archive-')), path=join(directory,'pa.sqlite');
  let store=new ConversationStore(path), db=new DatabaseSync(path), serial=0;
  const route={channel:'qq',accountId:'fixture',roomType:'group',roomId:'group'};
  const privateRoute={...route,roomType:'private',roomId:'private'};
  const conversation=store.ensureConversation('group','/fixture/group.jsonl',route);
  const privateConversation=store.ensureConversation('private','/fixture/private.jsonl',privateRoute);
  const message=(senderId='alice',room=conversation) => {
    const eventId=`event-${++serial}`;
    store.recordInbound(room.id,'研究资料整理',{eventId,senderId,sentAt:new Date().toISOString(),modelInputText:'研究资料整理'});
    return {...store.externalMessage(room.id,eventId),conversationId:room.id};
  };
  const source=message();
  const create=(key,senderId='alice',room=conversation) => {
    const input=message(senderId,room);
    return store.research.create(room.id,input.id,{key,title:`资料整理 ${key}`,goal:'核验资料并生成研究报告'});
  };
  const reopen=()=>{db.close();store.close();store=new ConversationStore(path);db=new DatabaseSync(path);};
  const snapshot=()=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'research_task_archives' ORDER BY name").all()
    .map(({name})=>[name,hash(JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()))]));
  const files=(root=join(directory,'research'),prefix='')=>Object.fromEntries(readdirSync(root,{withFileTypes:true}).flatMap(entry=>{
    const relative=join(prefix,entry.name), path=join(root,entry.name);
    return entry.isDirectory()?Object.entries(files(path,relative)):[[relative,hash(readFileSync(path))]];
  }));
  t.after(()=>{db.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,path,route,privateRoute,conversation,privateConversation,source,message,create,reopen,snapshot,files,
    get store(){return store;},get db(){return db;},
    archive(ids,reason='用户明确要求从研究清单移除'){return store.research.archive(conversation.id,source.id,{ids,reason});},
    finish(task,status='failed'){
      store.research.claim(task.id,budget);
      return store.research.finish(task.id,1,status==='completed'
        ? {status,markdown:'# 研究原始报告\n\n保留原文。',abstract:'资料整理摘要',keywords:['资料整理']}
        : {status,reason:'测试失败，保留原始记录'});
    }};
}

test('归档其他三项后清单只保留目标，报告草稿历史和文件不变，幂等且停止执行与通知', t=>{
  const f=fixture(t), report=f.create('report'), draft=f.create('draft'), queued=f.create('queued'), target=f.create('target');
  f.finish(report,'completed');
  f.store.research.claim(draft.id,budget);
  const workflow=f.store.research.workflow;
  const planCycle=workflow.begin(draft.id,1,{phase:'plan',input:{goal:draft.goal}});
  workflow.savePlan(draft.id,1,planCycle,{version:1,sections:[{id:'s1',title:'证据',objective:'核对资料',acceptance:'保留来源'}]});
  const writeCycle=workflow.begin(draft.id,1,{phase:'write',sectionId:'s1',expectedVersion:0,input:{fixed:'历史固定输入'}});
  workflow.saveSection(draft.id,1,writeCycle,{sectionId:'s1',expectedVersion:0,markdown:'已保存的章节草稿',status:'draft',mode:'replace',summary:'草稿',sources:[],gaps:['待补足']});
  f.store.research.checkpoint(draft.id,1,{modelCalls:1,toolCalls:0,searchCalls:0,evidence:{tool:'report_draft',input:{},result:'原始草稿证据'}});
  f.store.research.finish(draft.id,1,{status:'failed',reason:'失败的章节保留'});
  f.finish(target);
  const before=f.snapshot(), beforeFiles=f.files(), ids=[report.id,draft.id,queued.id];
  assert.equal(f.store.research.list(f.conversation.id,f.source.id).total,4);
  assert.deepEqual(f.archive([...ids,report.id]),{archivedIds:ids});
  const audit=f.db.prepare('SELECT * FROM research_task_archives ORDER BY task_id').all();
  for(const row of audit){
    assert.equal(row.source_message_id,f.source.id);assert.equal(row.operator_actor_id,f.source.actorId);
    assert.equal(row.operator_person_id,`actor:${f.source.actorId}`);
    assert.equal(row.snapshot_hash,hash(JSON.stringify(f.db.prepare('SELECT * FROM research_tasks WHERE id=?').get(row.task_id))));
  }
  const date=new Date(Date.now()+8*3600_000).toISOString().slice(0,10);
  for(const params of [{},{date},{query:'资料整理'},{date,query:'资料整理',limit:1}]){
    const list=f.store.research.list(f.conversation.id,f.source.id,params);
    assert.equal(list.total,1);assert.deepEqual(list.items.map(item=>item.id),[target.id]);assert.equal(list.nextOffset,undefined);
  }
  const page=f.store.research.list(f.conversation.id,f.source.id,{query:'资料整理',offset:1,limit:1});
  assert.equal(page.total,1);assert.deepEqual(page.items,[]);
  assert.deepEqual(f.store.research.queued(),[]);
  assert.equal(f.store.research.claim(queued.id,budget),undefined);
  assert.deepEqual(f.store.research.pendingNotifications().map(task=>task.id),[target.id]);
  assert.throws(()=>f.store.research.reserveNotification(report.id,1,'旧通知'),/已归档/);
  for(const id of ids)assert.throws(()=>f.store.research.retry(f.conversation.id,f.source.id,{id,key:'continue'}),/已归档/);
  assert.match(f.store.research.read(f.conversation.id,f.source.id,{id:report.id}).text,/研究原始报告/);
  assert.match(f.store.research.read(f.conversation.id,f.source.id,{id:draft.id,draft:true}).text,/已保存的章节草稿/);
  assert.deepEqual(f.archive(ids,'再次明确归档'),{archivedIds:ids});
  assert.deepEqual(f.db.prepare('SELECT * FROM research_task_archives ORDER BY task_id').all(),audit);
  assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.files(),beforeFiles);
  f.reopen();
  assert.equal(f.store.research.list(f.conversation.id,f.source.id).total,1);
  assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.files(),beforeFiles);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MemoryError } from '../dist/memory-types.js';
import { ConversationStore } from '../dist/store.js';
import { assembleResearchReport } from '../dist/research-workflow.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const plan = { version:1,sections:[{id:'s1',title:'证据与结论',objective:'核对原始资料',acceptance:'结论与来源一致'}] };
const budget = { maxModelCalls:20,maxToolCalls:20,maxSearchCalls:10 };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(),'pa-research-workflow-')), path = join(directory,'pa.sqlite');
  let store = new ConversationStore(path), db = new DatabaseSync(path), serial = 0;
  const conversation = store.ensureConversation('group','/fixture/group.jsonl',{channel:'qq',accountId:'fixture',roomType:'group',roomId:'group'});
  const message = (senderId='alice') => {
    const eventId = `event-${++serial}`;
    store.recordInbound(conversation.id,'调研资料整理',{eventId,senderId,sentAt:new Date().toISOString(),modelInputText:'调研资料整理'});
    return store.externalMessage(conversation.id,eventId);
  };
  const source = message();
  const task = store.research.create(conversation.id,source.id,{key:'research',title:'资料整理',goal:'调研资料并写成报告'});
  const reopen = () => { db.close(); store.close(); store = new ConversationStore(path); db = new DatabaseSync(path); };
  t.after(() => { db.close(); store.close(); rmSync(directory,{recursive:true,force:true}); });
  return {directory,path,conversation,source,task,message,reopen,get store(){return store;},get db(){return db;},
    get workflow(){return store.research.workflow;},
    claim(){return store.research.claim(task.id,budget);},
    savePlan(attempt=1){const cycle=this.workflow.begin(task.id,attempt,{phase:'plan',input:{goal:task.goal}});this.workflow.savePlan(task.id,attempt,cycle,plan);return cycle;},
    write(markdown,status='written',mode='replace',attempt=1){
      const expectedVersion=this.workflow.load(task.id).sections[0].version;
      const cycle=this.workflow.begin(task.id,attempt,{phase:'write',sectionId:'s1',expectedVersion,input:{markdown}});
      this.workflow.saveSection(task.id,attempt,cycle,{sectionId:'s1',expectedVersion,markdown,status,mode,summary:'章节摘要',sources:['https://example.com/source'],gaps:[]});
      return cycle;
    },
    review(verdict='pass',attempt=1){
      const expectedVersion=this.workflow.load(task.id).sections[0].version;
      const cycle=this.workflow.begin(task.id,attempt,{phase:'review',sectionId:'s1',expectedVersion,input:{expectedVersion}});
      this.workflow.saveReview(task.id,attempt,cycle,{sectionId:'s1',expectedVersion,verdict,reason:'已逐项检查'});return cycle;
    },
  };
}

test('独立收集固定输入并原子完成，跨表周期编号及并发检查，章节保持不变', t => {
  const f=fixture(t), id=f.task.id;
  assert.deepEqual(f.workflow.load(id),{sections:[],nextCycle:1,collected:false});
  f.claim();
  assert.throws(()=>f.workflow.begin(id,1,{phase:'collect',input:{}}),/先固定计划/);
  const planning=f.savePlan(), before=f.workflow.load(id).sections;
  for (const extra of [{sectionId:'s1'},{expectedVersion:0}]) {
    assert.throws(()=>f.workflow.begin(id,1,{phase:'collect',input:{},...extra}),/不能指定章节/);
  }
  const input={plan,materials:['已存在证据'],stage:'独立查资料'};
  const cycle=f.workflow.begin(id,1,{phase:'collect',input}); assert.equal(cycle,planning+1);
  assert.equal(f.workflow.load(id).collected,false);
  assert.throws(()=>f.workflow.begin(id,1,{phase:'write',sectionId:'s1',expectedVersion:0,input:{}}),/拒绝并发/);
  assert.throws(()=>f.workflow.begin(id,1,{phase:'collect',input:{}}),/拒绝并发/);
  assert.throws(()=>f.workflow.savePlan(id,1,cycle,plan),/固定阶段/);
  assert.throws(()=>f.workflow.saveCollection(id,1,cycle,{reason:'unknown',note:''}),/结束原因无效/);
  assert.throws(()=>f.workflow.saveCollection(id,1,cycle,{reason:'complete',note:'🙂'.repeat(4001)}),/说明无效或过长/);
  assert.equal(f.db.prepare('SELECT status,result_json FROM research_collection_cycles WHERE task_id=? AND cycle=?').get(id,cycle).result_json,null);
  f.workflow.saveCollection(id,1,cycle,{reason:'budget',note:'预算已用完，保留已取得材料'});
  const saved=f.db.prepare('SELECT * FROM research_collection_cycles WHERE task_id=? AND cycle=?').get(id,cycle);
  assert.equal(saved.status,'succeeded'); assert.equal(saved.input_json,JSON.stringify(input)); assert.equal(saved.input_hash,hash(saved.input_json));
  assert.deepEqual(JSON.parse(saved.result_json),{reason:'budget',note:'预算已用完，保留已取得材料'});
  assert.equal(f.workflow.load(id).collected,true); assert.deepEqual(f.workflow.load(id).sections,before);
  assert.throws(()=>f.workflow.saveCollection(id,1,cycle,{reason:'complete',note:'重复提交'}),/周期已结束/);
  const writing=f.workflow.begin(id,1,{phase:'write',sectionId:'s1',expectedVersion:0,input:{}}); assert.equal(writing,cycle+1);
  assert.throws(()=>f.workflow.begin(id,1,{phase:'collect',input:{}}),/拒绝并发/);
  assert.throws(()=>f.workflow.saveCollection(id,1,writing,{reason:'complete',note:''}),/固定阶段/);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('收集失败和未知请求不标记成功，固定输入哈希失败拒绝完成', t => {
  const f=fixture(t), id=f.task.id; f.claim(); f.savePlan();
  for (const unknown of [false,true]) {
    const cycle=f.workflow.begin(id,1,{phase:'collect',input:{unknown}});
    f.workflow.failCycle(id,1,cycle,'收集请求失败或结果未知',unknown);
    const saved=f.db.prepare('SELECT * FROM research_collection_cycles WHERE task_id=? AND cycle=?').get(id,cycle);
    assert.equal(saved.status,unknown?'unknown':'failed'); assert.equal(saved.result_json,null); assert.equal(f.workflow.load(id).collected,false);
    assert.throws(()=>f.workflow.saveCollection(id,1,cycle,{reason:'complete',note:'迟到结果'}),/周期已结束/);
  }
  const cycle=f.workflow.begin(id,1,{phase:'collect',input:{frozen:'原始输入'}});
  f.db.prepare('UPDATE research_collection_cycles SET input_json=? WHERE task_id=? AND cycle=?').run('{}',id,cycle);
  assert.throws(()=>f.workflow.saveCollection(id,1,cycle,{reason:'complete',note:''}),/固定输入校验失败/);
  assert.equal(f.workflow.load(id).collected,false);
  assert.equal(f.db.prepare('SELECT status FROM research_collection_cycles WHERE task_id=? AND cycle=?').get(id,cycle).status,'running');
});

test('收集恢复保留检查点与既有章节，新attempt必须重新收集且拒绝旧提交', t => {
  const f=fixture(t), id=f.task.id; f.claim(); f.savePlan(); f.write('保留历史章节','draft');
  const success=f.workflow.begin(id,1,{phase:'collect',input:{existing:'历史材料'}});
  f.workflow.saveCollection(id,1,success,{reason:'complete',note:'首轮已完成'});
  const cycle=f.workflow.begin(id,1,{phase:'collect',input:{frozen:'中断时固定输入'}});
  f.reopen(); f.store.research.recover();
  const saved=f.db.prepare('SELECT * FROM research_collection_cycles WHERE task_id=? AND cycle=?').get(id,cycle);
  assert.equal(saved.status,'interrupted'); assert.equal(saved.result_json,null); assert.equal(JSON.parse(saved.input_json).frozen,'中断时固定输入');
  assert.equal(f.workflow.load(id).collected,true);
  const source=f.message(); f.store.research.retry(f.conversation.id,source.id,{id,key:'continue-collection'}); f.claim();
  assert.equal(f.workflow.load(id).collected,false); assert.equal(f.workflow.load(id).sections[0].markdown,'保留历史章节');
  assert.throws(()=>f.workflow.saveCollection(id,1,cycle,{reason:'complete',note:'旧结果'}),/批次已改变/);
  assert.throws(()=>f.workflow.failCycle(id,1,cycle,'旧结果'),/批次已改变/);
  assert.throws(()=>f.workflow.interrupt(id,1,'旧批次中断'),/批次已改变/);
  const next=f.workflow.begin(id,2,{phase:'collect',input:{reuse:'历史材料仍可复用'}}); assert.equal(next,cycle+1);
  f.workflow.saveCollection(id,2,next,{reason:'complete',note:'新批次完成收集'});
  f.reopen(); assert.equal(f.workflow.load(id).collected,true);
  const pending=f.workflow.begin(id,2,{phase:'collect',input:{}});
  f.store.research.finish(id,2,{status:'partial',markdown:'# 部分报告',abstract:'有已保存章节',keywords:[],reason:'保留未完资料'});
  assert.equal(f.db.prepare('SELECT status FROM research_collection_cycles WHERE task_id=? AND cycle=?').get(id,pending).status,'interrupted');
});

test('固定计划、追加完整章节版本、评审修订历史及CAS拒绝', t => {
  const f=fixture(t), id=f.task.id;
  f.claim(); const planCycle=f.savePlan();
  assert.throws(()=>f.workflow.savePlan(id,1,planCycle,plan),/周期已结束/);
  assert.throws(()=>f.workflow.begin(id,1,{phase:'plan',input:{}}),/计划已固定/);
  f.write('第一段','draft'); const first=readFileSync(join(f.directory,'research',id,'sections','s1','1.md'));
  f.write('第二段','written','append');
  assert.equal(f.workflow.load(id).sections[0].markdown,'第一段\n\n第二段');
  assert.equal(hash(readFileSync(join(f.directory,'research',id,'sections','s1','1.md'))),hash(first));
  assert.throws(()=>f.workflow.begin(id,1,{phase:'review',sectionId:'s1',expectedVersion:1,input:{}}),/版本已改变/);
  const reviewCycle=f.review('revise');
  assert.equal(f.workflow.load(id).sections[0].status,'needs_revision');
  assert.throws(()=>f.workflow.saveReview(id,1,reviewCycle,{sectionId:'s1',expectedVersion:2,verdict:'pass',reason:'迟到重复'}),/周期已结束/);
  const writeCycle=f.workflow.begin(id,1,{phase:'write',sectionId:'s1',expectedVersion:2,input:{fixed:'input'}});
  assert.throws(()=>f.workflow.saveSection(id,1,writeCycle,{sectionId:'s1',expectedVersion:1,mode:'replace',status:'written',markdown:'错误',summary:'',sources:[],gaps:[]}),/固定阶段/);
  f.workflow.saveSection(id,1,writeCycle,{sectionId:'s1',expectedVersion:2,mode:'replace',status:'written',markdown:'修订正文',summary:'新摘要',sources:[],gaps:[]});
  f.review(); f.workflow.assertComplete(id);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM research_workflow_reviews').get().n,2);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM research_workflow_versions').get().n,3);
  const fixed=f.db.prepare('SELECT input_json,input_hash FROM research_workflow_cycles WHERE task_id=? AND cycle=?').get(id,writeCycle);
  assert.equal(fixed.input_hash,hash(fixed.input_json));
});

test('恢复中断周期、保留固定输入与章节，显式新attempt拒绝旧提交且周期单调', t => {
  const f=fixture(t), id=f.task.id; f.claim(); f.savePlan(); f.write('已落盘草稿','draft');
  const cycle=f.workflow.begin(id,1,{phase:'write',sectionId:'s1',expectedVersion:1,input:{frozen:'不可改写'}});
  f.reopen(); f.store.research.recover();
  assert.equal(f.db.prepare('SELECT status FROM research_workflow_cycles WHERE task_id=? AND cycle=?').get(id,cycle).status,'interrupted');
  assert.equal(f.workflow.load(id).sections[0].markdown,'已落盘草稿');
  const source=f.message(); f.store.research.retry(f.conversation.id,source.id,{id,key:'continue'}); f.claim();
  assert.throws(()=>f.workflow.failCycle(id,1,cycle,'迟到'),/批次已改变/);
  assert.throws(()=>f.workflow.saveSection(id,1,cycle,{sectionId:'s1',expectedVersion:1,mode:'append',status:'written',markdown:'迟到',summary:'',sources:[],gaps:[]}),/批次已改变/);
  const next=f.write('续作','written','append',2); assert.ok(next>cycle); f.review('pass',2);
  assert.equal(f.workflow.load(id).sections[0].markdown,'已落盘草稿\n\n续作');
  assert.equal(JSON.parse(f.db.prepare('SELECT input_json FROM research_workflow_cycles WHERE task_id=? AND cycle=?').get(id,cycle).input_json).frozen,'不可改写');
});

test('孤儿章节文件跳号保留，正文哈希篡改和容量错误明确拒绝', t => {
  const f=fixture(t), id=f.task.id; f.claim(); f.savePlan();
  const directory=join(f.directory,'research',id,'sections','s1'); mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,'1.md'),'孤儿文件'); f.write('有效正文','draft');
  assert.equal(f.workflow.load(id).sections[0].version,2); assert.equal(readFileSync(join(directory,'1.md'),'utf8'),'孤儿文件');
  const cycle=f.workflow.begin(id,1,{phase:'write',sectionId:'s1',expectedVersion:2,input:{}});
  assert.throws(()=>f.workflow.saveSection(id,1,cycle,{sectionId:'s1',expectedVersion:2,mode:'replace',status:'written',markdown:'中'.repeat(40000),summary:'',sources:[],gaps:[]}),MemoryError);
  assert.equal(f.workflow.load(id).sections[0].version,2);
  f.workflow.failCycle(id,1,cycle,'正文超限');
  writeFileSync(join(directory,'2.md'),'篡改'); assert.throws(()=>f.workflow.load(id),/校验失败/);
});

test('完成不能绕过章节审查，本人草稿分页优先章节且他人无读取权限', t => {
  const f=fixture(t), id=f.task.id; f.claim(); f.savePlan(); f.write('章节正文🙂'.repeat(20));
  const finish=()=>f.store.research.finish(id,1,{status:'completed',markdown:'# 正式报告',abstract:'报告摘要',keywords:[]});
  assert.throws(finish,/未通过审查/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM research_reports').get().n,0);
  f.store.research.checkpoint(id,1,{modelCalls:1,toolCalls:0,searchCalls:0,evidence:{tool:'report_draft',input:{},result:'旧草稿回退'}});
  const first=f.store.research.read(f.conversation.id,f.source.id,{id,draft:true,limit:50});
  assert.match(first.text,/未归档草稿，不是正式报告/); assert.match(first.text,/章节正文/); assert.equal(first.nextOffset,50);
  const second=f.store.research.read(f.conversation.id,f.source.id,{id,draft:true,offset:first.nextOffset,limit:50}); assert.equal(second.offset,50);
  const other=f.message('bob'); assert.throws(()=>f.store.research.read(f.conversation.id,other.id,{id,draft:true}),/没有属于你的/);
  f.review(); finish(); assert.equal(f.store.research.get(id).status,'completed');
});

test('新方案校验、固定阶段与未知失败周期留下审计', t => {
  const f=fixture(t), id=f.task.id; f.claim();
  const cycle=f.workflow.begin(id,1,{phase:'plan',input:{task:id}});
  assert.throws(()=>f.workflow.savePlan(id,1,cycle,{version:1,sections:[{...plan.sections[0],id:'s2'}]}),/连续排列/);
  assert.throws(()=>f.workflow.begin(id,1,{phase:'plan',input:{}}),/拒绝并发/);
  f.workflow.failCycle(id,1,cycle,'调用结果未知',true);
  assert.equal(f.db.prepare('SELECT status FROM research_workflow_cycles WHERE cycle=?').get(cycle).status,'unknown');
  f.savePlan();
  const writing=f.workflow.begin(id,1,{phase:'write',sectionId:'s1',expectedVersion:0,input:{}});
  assert.throws(()=>f.workflow.saveSection(id,1,writing,{sectionId:'s1',expectedVersion:0,mode:'replace',status:'written',markdown:'正文',summary:'',sources:['https://secret:password@example.com/'],gaps:[]}),/无凭据/);
  f.workflow.failCycle(id,1,writing,'无效URL');
});

test('章节目录符号链接拒绝写出档案目录', t => {
  const f=fixture(t), id=f.task.id; f.claim(); f.savePlan();
  const outside=join(f.directory,'outside'); mkdirSync(outside);
  mkdirSync(join(f.directory,'research',id,'sections'),{recursive:true});
  symlinkSync(outside,join(f.directory,'research',id,'sections','s1'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>f.write('不应写出档案目录'),/符号链接/);
  assert.deepEqual(readdirSync(outside),[]);
});

test('章节总码点和UTF8字节容量分别预检，容量拒绝不修改已提交版本', t => {
  for (const encoding of ['points','bytes']) {
    const f=fixture(t), id=f.task.id; f.claim();
    const count=encoding==='points'?2:5;
    const planned={version:1,sections:Array.from({length:count},(_,i)=>({...plan.sections[0],id:`s${i+1}`}))};
    const cycle=f.workflow.begin(id,1,{phase:'plan',input:{}}); f.workflow.savePlan(id,1,cycle,planned);
    for (let i=1;i<=count;i++) {
      const sectionId=`s${i}`, cycle=f.workflow.begin(id,1,{phase:'write',sectionId,expectedVersion:0,input:{}});
      const markdown=encoding==='points'?(i===1?'a'.repeat(100000):'b'.repeat(80001)):'中'.repeat(33333);
      const save=()=>f.workflow.saveSection(id,1,cycle,{sectionId,expectedVersion:0,mode:'replace',status:'draft',markdown,summary:'',sources:[],gaps:[]});
      if(i===count) {
        assert.throws(save,MemoryError); assert.equal(f.workflow.load(id).sections[i-1].version,0);
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM research_workflow_versions WHERE task_id=?').get(id).n,count-1);
      } else save();
    }
  }
});

test('完整报告容量包含跨章缺口和去重来源，拒绝超限提案并保留可读的接近上限版本', t => {
  for (const metadata of ['gaps','sources']) {
    const f=fixture(t), id=f.task.id; f.claim();
    const count=metadata==='gaps'?7:6;
    const planned={version:1,sections:Array.from({length:count},(_,index)=>({...plan.sections[0],id:`s${index+1}`}))};
    const planning=f.workflow.begin(id,1,{phase:'plan',input:{}}); f.workflow.savePlan(id,1,planning,planned);
    const values=(index,nearLimit=false)=>metadata==='gaps'
      ? {gaps:Array.from({length:nearLimit?18:30},()=> 'g'.repeat(nearLimit?850:1000)),sources:[]}
      : {gaps:[],sources:Array.from({length:nearLimit?60:100},(_,ordinal)=>{
        const prefix=`https://example.com/${index}/${ordinal}/`; return prefix+'s'.repeat(350-prefix.length);
      })};
    const save=(index,fields,status='written')=>{
      const sectionId=`s${index}`, expectedVersion=f.workflow.load(id).sections[index-1].version;
      const cycle=f.workflow.begin(id,1,{phase:'write',sectionId,expectedVersion,input:{metadata}});
      return {cycle,commit:()=>f.workflow.saveSection(id,1,cycle,{sectionId,expectedVersion,mode:'replace',status,markdown:`章节${index}正文`,summary:'章节摘要',...fields})};
    };
    for(let index=1;index<=count;index++) save(index,values(index,index===count),index===count?'draft':'written').commit();
    const before=f.workflow.load(id), current=before.sections[count-1];
    const beforeRows=f.db.prepare('SELECT count(*) AS n FROM research_workflow_versions WHERE task_id=?').get(id).n;
    const directory=join(f.directory,'research',id,'sections',current.id), beforeFiles=readdirSync(directory);
    const beforeFile=hash(readFileSync(join(directory,`${current.version}.md`)));
    const excess=save(count,values(count));
    assert.throws(excess.commit,error=>error instanceof MemoryError && /组装报告.*容量上限/.test(error.message));
    assert.deepEqual(f.workflow.load(id).sections,before.sections);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM research_workflow_versions WHERE task_id=?').get(id).n,beforeRows);
    assert.deepEqual(readdirSync(directory),beforeFiles); assert.equal(hash(readFileSync(join(directory,`${current.version}.md`))),beforeFile);
    f.workflow.failCycle(id,1,excess.cycle,'完整报告容量超限');
    save(count,values(count,true)).commit();
    for(let index=1;index<=count;index++) {
      const section=f.workflow.load(id).sections[index-1];
      const reviewing=f.workflow.begin(id,1,{phase:'review',sectionId:section.id,expectedVersion:section.version,input:{}});
      f.workflow.saveReview(id,1,reviewing,{sectionId:section.id,expectedVersion:section.version,verdict:'pass',reason:'通过'});
    }
    const task=f.store.research.get(id), workflow=f.workflow.load(id);
    const partial=assembleResearchReport(task,workflow,'partial','🙂'.repeat(2000));
    assert.ok([...partial.markdown].length>195000); assert.ok([...partial.markdown].length<=199900);
    const complete=assembleResearchReport(task,workflow,'completed'); f.store.research.finish(id,1,complete);
    const points=[...complete.markdown],offset=points.length-100;
    const page=f.store.research.read(f.conversation.id,f.source.id,{id,offset,limit:100});
    assert.equal(page.totalChars,points.length); assert.equal(page.text,points.slice(offset).join(''));
  }
});

test('schema24到27保留式迁移自动备份，旧任务证据报告及正文哈希保持', t => {
  const f=fixture(t), id=f.task.id; f.claim();
  f.store.research.checkpoint(id,1,{modelCalls:1,toolCalls:0,searchCalls:0,evidence:{tool:'fetch',input:{url:'https://example.com'},result:'旧证据'}});
  f.store.research.finish(id,1,{status:'completed',markdown:'# 旧正式报告\n\n历史内容',abstract:'旧摘要',keywords:['历史']});
  const tableNames=['research_tasks','research_attempts','research_evidence','research_reports'];
  const snapshots=()=>Object.fromEntries(tableNames.map(name=>[name,hash(JSON.stringify(f.db.prepare(`SELECT * FROM ${name}`).all()))]));
  const before=snapshots(), reportHash=hash(readFileSync(join(f.directory,'research',id,'1.md')));
  f.db.exec(`DROP TABLE research_collection_cycles; DROP TABLE research_task_archives; DROP TABLE research_workflow_reviews; DROP TABLE research_workflow_versions; DROP TABLE research_workflow_sections;
    DROP TABLE research_workflow_plans; DROP TABLE research_workflow_cycles; PRAGMA user_version=24;`);
  f.reopen(); assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,27);
  assert.deepEqual(snapshots(),before); assert.equal(hash(readFileSync(join(f.directory,'research',id,'1.md'))),reportHash);
  const backups=readdirSync(f.directory).filter(name=>/^pa\.sqlite\.v24\..*\.bak$/.test(name)); assert.equal(backups.length,1);
  const backup=new DatabaseSync(join(f.directory,backups[0]),{readOnly:true});
  try { assert.equal(backup.prepare('PRAGMA user_version').get().user_version,24);
    for(const name of tableNames) assert.equal(hash(JSON.stringify(backup.prepare(`SELECT * FROM ${name}`).all())),before[name]);
  } finally { backup.close(); }
  assert.equal(f.workflow.load(id).plan,undefined); assert.deepEqual(f.workflow.load(id).sections,[]);
  assert.match(f.store.research.report(id,1).markdown,/历史内容/);
});

test('schema26到27仅新增收集表，所有旧表结构和行、章节文件与正式报告均保持', t => {
  const f=fixture(t), id=f.task.id; f.claim(); f.savePlan(); f.write('旧章节正文'); f.review();
  f.store.research.checkpoint(id,1,{modelCalls:1,toolCalls:1,searchCalls:0,evidence:{tool:'fetch',input:{url:'https://example.com'},result:'旧材料内容'}});
  f.store.research.finish(id,1,{status:'completed',markdown:'# 旧报告\n\n旧章节正文',abstract:'旧摘要',keywords:['资料']});
  f.db.exec('DROP TABLE research_collection_cycles; PRAGMA user_version=26;');
  const schemas=f.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const tables=schemas.filter(row=>row.type==='table').map(row=>row.name);
  const snapshots=db=>Object.fromEntries(tables.map(name=>[name,hash(JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()))]));
  const before=snapshots(f.db), paths=[join(f.directory,'research',id,'sections','s1','1.md'),join(f.directory,'research',id,'1.md'),join(f.directory,'research',id,'1.txt')];
  const files=paths.map(path=>hash(readFileSync(path)));
  f.reopen();
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,27);
  assert.deepEqual(f.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('research_collection_cycles','research_collection_one_cycle') ORDER BY name").all(),schemas);
  assert.deepEqual(snapshots(f.db),before); assert.deepEqual(paths.map(path=>hash(readFileSync(path))),files);
  assert.equal(f.workflow.load(id).collected,false); assert.equal(f.workflow.load(id).sections[0].status,'approved');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM research_collection_cycles').get().n,0);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
  const backups=readdirSync(f.directory).filter(name=>/^pa\.sqlite\.v26\..*\.bak$/.test(name)); assert.equal(backups.length,1);
  const backup=new DatabaseSync(join(f.directory,backups[0]),{readOnly:true});
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version,26);
    assert.deepEqual(snapshots(backup),before);
    assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE name='research_collection_cycles'").get(),undefined);
  } finally { backup.close(); }
});

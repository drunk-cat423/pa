import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { validateTurnPlan, hasUnbackedSaveClaim } from '../dist/turn-plan.js';

function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'pa-turn-plan-'));
  const path=join(directory,'pa.sqlite'),store=new ConversationStore(path);
  const route={channel:'qq',accountId:'bot',roomId:'group-a',roomType:'group'};
  const group=store.ensureConversation('g','/g.jsonl',route);
  const other=store.ensureConversation('g2','/g2.jsonl',{...route,roomId:'group-b'});
  const policy={version:1,ownerBindings:[{route,senderId:'owner'}],primaryPerson:{id:'primary',bindings:[{route,senderId:'owner'}]}};
  store.configurePersons([policy.primaryPerson]);
  const input=(text,senderId='owner',conv=group)=>{
    const eventId=crypto.randomUUID();store.recordInbound(conv.id,text,{eventId,senderId,modelInputText:text,senderName:senderId==='owner'?'佑':'同名'});
    return store.externalMessage(conv.id,eventId).id;
  };
  const inspect=fn=>{const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}};
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,route,policy,group,other,input,inspect};
}
const plan=updates=>({intent:'memory_update',mode:'casual',updates});

test('同轮本人、AI和群规则一起持久化；按source幂等，规则不混画像',t=>{
  const f=fixture(t),text='我喜欢清淡；你现在就叫初号机；本群pa代表personal agent';
  const id=f.input(text);
  const p=plan([{target:'sender',content:'我喜欢清淡',sourceType:'self'},
    {target:'ai_self',content:'你现在就叫初号机'},{target:'room_rule',key:'PA',content:'本群pa代表personal agent'}]);
  const first=f.store.prepareTurn(f.group.id,id,p,f.policy);
  assert.equal(first.saved.length,3);
  assert.deepEqual(f.store.prepareTurn(f.group.id,id,p,f.policy),first);
  assert.deepEqual(f.store.roomRules(f.group.id),[{key:'pa',content:'本群pa代表personal agent'}]);
  assert.deepEqual(f.store.roomRules(f.other.id),[]);
  assert.equal(f.store.autoMemory.profile('primary').pending.length,1);
  assert.deepEqual(f.store.autoMemory.selfProfile.snapshot().pending.map(p=>p.content),['你现在就叫初号机']);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM turn_preparations').get().n),1);
  assert.throws(()=>f.store.prepareTurn(f.group.id,id,{...p,updates:[]},f.policy),/已经完成准备/);
  f.store.autoMemory.reserveBatch(f.group.id,'capacity');
  const job=f.store.autoMemory.claimNext(f.group.id,{owner:'test',leaseMs:60000});
  assert.deepEqual(f.store.autoMemory.taskInput(job).roomRules,[{key:'pa',content:'本群pa代表personal agent'}]);
});

test('普通成员第二项越权时整批回滚，身份共享不获得管理权',t=>{
  const f=fixture(t);f.store.configurePersons([{id:'primary',bindings:[...f.policy.primaryPerson.bindings,{route:f.route,senderId:'same-person'}]}]);
  const id=f.input('我喜欢清淡；本群pa代表personal agent','same-person');
  assert.throws(()=>f.store.prepareTurn(f.group.id,id,plan([{target:'sender',content:'我喜欢清淡',sourceType:'self'},
    {target:'room_rule',key:'pa',content:'本群pa代表personal agent'}]),f.policy),/没有管理/);
  assert.equal(f.store.autoMemory.profile('primary').pending.length,0);
  assert.deepEqual(f.store.roomRules(f.group.id),[]);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM turn_preparations').get().n),0);
});

test('管理员能为明确@的成员记录第三方事实，来源不伪装成本人',t=>{
  const f=fixture(t);f.input('在的','member');
  const text='<@member>是ai，你记一下',id=f.input(text);
  f.store.prepareTurn(f.group.id,id,plan([{target:'mentioned_person',senderId:'member',content:text,sourceType:'self'}]),f.policy,['member']);
  const card=f.store.identityCard(f.group.id,'member',f.policy);
  assert.equal(card.displayName,'同名');assert.equal(card.isMaintainer,false);
  const note=f.store.autoMemory.profile(card.personId).pending[0];
  assert.equal(note.sourceType,'third_party');
  const other=f.input('请记录这个人','owner');
  assert.throws(()=>f.store.prepareTurn(f.group.id,other,plan([{target:'mentioned_person',senderId:'member',content:'请记录这个人'}]),f.policy),/对象/);
});

test('规则纠正保留旧版本、不同群和私聊相互隔离',t=>{
  const f=fixture(t);
  for(const text of ['pa代表personal assistant','pa代表personal agent']) f.store.prepareTurn(f.group.id,f.input(text),
    plan([{target:'room_rule',key:'pa',content:text}]),f.policy);
  assert.equal(f.store.roomRules(f.group.id)[0].content,'pa代表personal agent');
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM room_rule_revisions').get().n),2);
  const route={...f.route,roomType:'private',roomId:'private'},privateChat=f.store.ensureConversation('p','/p.jsonl',route);
  const policy={...f.policy,ownerBindings:[{route,senderId:'owner'}]};
  assert.throws(()=>f.store.prepareTurn(privateChat.id,f.input('pa代表personal agent','owner',privateChat),
    plan([{target:'room_rule',key:'pa',content:'pa代表personal agent'}]),policy),/只能在对应群聊/);
});

test('个人事件协议拒绝写入，普通成员仍可单独建议AI全局称呼',t=>{
  const f=fixture(t),id=f.input('记住我买了电脑；你叫初号机','member');
  assert.throws(()=>f.store.prepareTurn(f.group.id,id,plan([{target:'sender',purpose:'memory',content:'我买了电脑',sourceType:'self'},
    {target:'ai_self',content:'你叫初号机'}]),f.policy),/条目无效/);
  assert.equal(f.store.autoMemory.selfProfile.snapshot().pending.length,0);
  const r=f.store.prepareTurn(f.group.id,id,plan([{target:'ai_self',content:'你叫初号机'}]),f.policy);
  assert.equal(r.saved.length,1);
});

test('准备协议不能接受伪造来源或任意工具权限字段',t=>{
  const f=fixture(t),id=f.input('你好');
  assert.throws(()=>f.store.prepareTurn(f.group.id,id,plan([{target:'ai_self',content:'你叫初号机'}]),f.policy),/原文/);
  assert.throws(()=>validateTurnPlan({...plan([]),owner:true}),/协议无效/);
  assert.throws(()=>validateTurnPlan(plan([{target:'sender',content:'你好',senderId:'other'}])),/不能指定/);
});

test('群共享事实归属要求完整结构并校验归属边界',()=>{
  const attribution={kind:'statement',subjectSenderIds:['member'],excludedSenderIds:[],correctsMessageIds:[]};
  assert.deepEqual(validateTurnPlan(plan([{target:'room_memory',content:'唤醒失败是巧克力的',attribution}])).updates[0].attribution,attribution);
  const invalid=[
    {...attribution, excludedSenderIds:['owner']},
    {...attribution, correctsMessageIds:['old-message']},
    {...attribution, subjectSenderIds:['member'], excludedSenderIds:['member']},
    {...attribution, subjectSenderIds:['member','member']},
    {...attribution, subjectSenderIds:['x'.repeat(513)]},
    {...attribution, correctsMessageIds:['x'.repeat(129)]},
    {...attribution, extra:'owner'},
    {kind:'correction',subjectSenderIds:[],excludedSenderIds:[],correctsMessageIds:[]},
  ];
  for(const value of invalid) assert.throws(()=>validateTurnPlan(plan([{target:'room_memory',content:'事实',attribution:value}])),/归属信息无效/);
  assert.throws(()=>validateTurnPlan(plan([{target:'sender',content:'事实',attribution}])),/归属信息无效/);
  assert.throws(()=>validateTurnPlan(plan([{target:'room_memory',content:'事实',attribution:{...attribution,excludedSenderIds:undefined}}])),/归属信息无效/);
  const correction={kind:'correction',subjectSenderIds:['member'],excludedSenderIds:['owner'],correctsMessageIds:['old-message']};
  assert.deepEqual(validateTurnPlan(plan([{target:'room_memory',content:'归属纠正',attribution:correction}])).updates[0].attribution,correction);
});

test('进度提示允许60个Unicode字符并拒绝空白、超长和多行内容',()=>{
  const base=plan([]);
  assert.equal(validateTurnPlan({...base,progressText:'想'.repeat(60)}).progressText,'想'.repeat(60));
  for(const progressText of ['', '  ', '想'.repeat(61), '第一行\n第二行', '第一行\r第二行']) {
    assert.throws(()=>validateTurnPlan({...base,progressText}),/等待提示/);
  }
  assert.equal(validateTurnPlan(base).progressText,undefined);
});

test('无回执检查识别简单肯定确认，不误杀否定、引用和能力解释',()=>{
  for(const text of ['好的，已记下。','记住了。','我已经记住了你的偏好。','已保存到长期记忆。'])assert.equal(hasUnbackedSaveClaim(text),true,text);
  for(const text of ['这次没有成功保存到长期记忆。','不能仅凭“我记住了”就算保存。','“已保存”只是一个示例。','如果成功保存，才可以确认。','你可以问我怎么保存。'])assert.equal(hasUnbackedSaveClaim(text),false,text);
});

test('同一消息多项AI建议分别保留，不触发旧版单来源唯一约束',t=>{
  const f=fixture(t),id=f.input('你以后叫初号机；回答简短一点');
  f.store.prepareTurn(f.group.id,id,plan([{target:'ai_self',content:'你以后叫初号机'},{target:'ai_self',content:'回答简短一点'}]),f.policy);
  assert.equal(f.store.autoMemory.selfProfile.snapshot().pending.length,2);
});

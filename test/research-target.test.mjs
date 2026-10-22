import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '../dist/store.js';
import { researchUrls } from '../dist/research-target.js';

const target = 'https://github.com/example-owner/DeepSeek-Bot';
const wrong = 'https://github.com/other-owner/ai-storyteller';
const proposal = (changes = {}) => ({ key:'implementation', title:'DeepSeek Bot 实现研究', goal:'检查源码实现及部署条件', urls:[target], ...changes });

test('链接保留内部平衡括号，只去Markdown或句子附带的外围标点', t => {
  const url = 'https://en.wikipedia.org/wiki/Function_(mathematics)';
  for (const text of [url, `[函数](${url})`, `[函数](${url}).`, `(${url}),`, `${url}。`, `${url}!`])
    assert.deepEqual(researchUrls(text), [url], text);
  assert.deepEqual(researchUrls('[函数](https://example.com/function).'), ['https://example.com/function']);
  assert.deepEqual(researchUrls('https://example.com/a_(b_(c))'), ['https://example.com/a_(b_(c))']);
  const f = fixture(t), source = f.message(`研究这个页面 ${url}`);
  assert.equal(f.create(source, { key:'function', title:'数学函数', goal:'研究函数定义', urls:[url] }).urls[0], url);
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pa-research-target-'));
  const path = join(directory, 'pa.sqlite'), store = new ConversationStore(path);
  const route = { channel:'qq', accountId:'fixture', roomType:'group', roomId:'group' };
  const conversation = store.ensureConversation('group', '/fixture/group.jsonl', route);
  const second = store.ensureConversation('other-group', '/fixture/other.jsonl', { ...route, roomId:'other-group' });
  const db = new DatabaseSync(path);
  let serial = 0;
  const message = (text, { senderId='alice', room=conversation, sentAt=new Date().toISOString(), quote, modelInputText=text } = {}) => {
    const eventId = `event-${++serial}`;
    store.recordInbound(room.id, text, { eventId, senderId, sentAt, modelInputText });
    const source = store.externalMessage(room.id, eventId);
    if (quote) store.enqueueChannelTask(room.id, source.id, { route, eventId, senderId, sentAt, text, mentioned:true, quote });
    return { ...source, eventId, conversationId:room.id };
  };
  const create = (source, input=proposal()) => store.research.create(source.conversationId, source.id, input);
  const count = () => Number(db.prepare('SELECT count(*) AS n FROM research_tasks').get().n);
  t.after(() => { db.close(); store.close(); rmSync(directory, { recursive:true, force:true }); });
  return { store, db, conversation, second, message, create, count };
}

test('当前原文链接优先：替换对象与机械换URL不建任务，正确重组后可幂等保存锚点', t => {
  const f = fixture(t);
  f.message(wrong);
  const source = f.message(`调研这个仓库的实现 ${target}`, { modelInputText:`模型投影中的其他链接 ${wrong}` });
  assert.deepEqual(f.store.research.targetContext(source.conversationId, source.id), { kind:'current', sourceMessageId:source.id, urls:[target] });
  assert.throws(() => f.create(source, proposal({ title:'ai-storyteller 实现', urls:[wrong] })), /链接不一致/);
  assert.throws(() => f.create(source, proposal({ title:'ai-storyteller 实现', goal:'检查 ai-storyteller 源码' })), /标题缺少锚点/);
  assert.throws(() => f.create(source, proposal({ goal:`研究这个源码 ${wrong}` })), /链接不一致/);
  assert.equal(f.count(), 0);
  const task = f.create(source);
  assert.equal(f.create(source).id, task.id);
  const row = f.db.prepare('SELECT input_json FROM research_tasks WHERE id=?').get(task.id);
  assert.equal(JSON.parse(row.input_json).targetBinding.sourceMessageId, source.id);
  // Legacy rows have no targetBinding and retain their original idempotency behavior.
  const saved = JSON.parse(row.input_json); delete saved.targetBinding;
  f.db.prepare('UPDATE research_tasks SET input_json=? WHERE id=?').run(JSON.stringify(saved), task.id);
  assert.equal(f.create(source).id, task.id);
  assert.equal(f.count(), 1);
});

test('明确承接继承最近同actor链接，群友新链接不会覆盖', t => {
  const f = fixture(t), anchor = f.message(target);
  f.message(wrong, { senderId:'bob' });
  const source = f.message('那把这个作为调研任务，重点看如何实现，能否摆脱现有方案');
  assert.deepEqual(f.store.research.targetContext(source.conversationId, source.id), { kind:'recent', sourceMessageId:anchor.id, urls:[target] });
  assert.throws(() => f.create(source, proposal({ urls:[wrong], title:'ai-storyteller' })), /链接不一致/);
  assert.equal(f.create(source).urls[0], target);
});

test('不继承群友、跨房间、过期或已被本人新话题隔开的链接', t => {
  for (const scenario of ['other-person', 'other-room', 'old', 'new-topic', 'too-many-turns']) {
    const f = fixture(t);
    f.message(target, scenario === 'other-person' ? { senderId:'bob' }
      : scenario === 'other-room' ? { room:f.second }
      : scenario === 'old' ? { sentAt:new Date(Date.now()-16*60_000).toISOString() } : {});
    if (scenario === 'new-topic') f.message('我们现在聊一下午餐');
    if (scenario === 'too-many-turns') for (let i=0; i<5; i++) f.message('这个我再想想');
    const source = f.message('把那个仓库作为研究任务');
    assert.equal(f.store.research.targetContext(source.conversationId, source.id).kind, 'unresolved', scenario);
    assert.throws(() => f.create(source), /研究对象不明确/, scenario);
    assert.equal(f.count(), 0);
  }
});

test('显式引用只从当前房间持久化的唯一真人原文解析，不信inline引用文本', t => {
  const f = fixture(t), anchor = f.message(target, { senderId:'bob' });
  f.message(wrong);
  const source = f.message('研究引用里的项目', { quote:{ messageId:anchor.eventId, inlineMessages:[{ text:wrong }] } });
  assert.deepEqual(f.store.research.targetContext(source.conversationId, source.id), { kind:'quote', sourceMessageId:anchor.id, urls:[target] });
  assert.equal(f.create(source).urls[0], target);
  const unresolved = f.message('把这个作为任务', { quote:{ messageId:'missing', inlineMessages:[{ text:target }] } });
  assert.throws(() => f.create(unresolved), /研究对象不明确/);
});

test('纯主题不捡历史链接，Github比较研究保留主锚点及标题', t => {
  const f = fixture(t); f.message(target);
  const topic = f.message('调研 Devin 的产品能力');
  assert.equal(f.store.research.targetContext(topic.conversationId, topic.id).kind, 'none');
  assert.equal(f.create(topic, { key:'devin', title:'Devin', goal:'研究产品能力' }).title, 'Devin');
  const compare = f.message(`研究 ${target} 能否替代旧实现`);
  assert.equal(f.create(compare, proposal({ title:'DeepSeek-Bot 与 ai-storyteller 对比', goal:'比较两者实现', urls:[target,wrong] })).urls.length, 2);
});

test('只有任务本人可分页读最新保存草稿，保留失败原因和截断提示且不作为正式报告', t => {
  const f = fixture(t), source = f.message('调研 Devin 产品能力');
  const task = f.create(source, { key:'devin', title:'Devin', goal:'研究产品能力' });
  const absent = f.store.research.read(source.conversationId, source.id, { id:task.id, draft:true });
  assert.equal(absent.draft, true); assert.match(absent.text, /没有已保存/);
  f.store.research.claim(task.id, { maxModelCalls:3, maxToolCalls:3, maxSearchCalls:1 });
  const checkpoint = result => f.store.research.checkpoint(task.id, 1, { modelCalls:1, toolCalls:0, searchCalls:0,
    evidence:{ tool:'report_draft', input:{ attempt:1 }, result } });
  checkpoint('旧草稿'); checkpoint('新草稿🙂正文\n[此材料片段已截断]');
  f.store.research.finish(task.id, 1, { status:'failed', reason:'报告格式错误，保留原始输出' });
  const first = f.store.research.read(source.conversationId, source.id, { id:task.id, draft:true, limit:4 });
  assert.equal(first.status, 'failed'); assert.equal(first.reason, '报告格式错误，保留原始输出');
  assert.equal(first.nextOffset, 4); assert.match(first.text, /不是正式报告；原始草稿已截断.*\n新草稿🙂/s);
  const rest = f.store.research.read(source.conversationId, source.id, { id:task.id, draft:true, offset:first.nextOffset });
  assert.match(rest.text, /正文\n\[此材料片段已截断\]/);
  assert.match(f.store.research.read(source.conversationId, source.id, { id:task.id }).text, /报告尚未生成/);
  const other = f.message('给我看看那个草稿', { senderId:'bob' });
  assert.throws(() => f.store.research.read(other.conversationId, other.id, { id:task.id, draft:true }), /没有属于你的/);
  assert.throws(() => f.store.research.reserveDelivery(source.conversationId, source.id, { id:task.id, format:'md' }), /尚无可发送/);
});

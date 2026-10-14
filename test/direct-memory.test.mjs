import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '../dist/store.js';
import { executeMemoryRequest, parseMemoryRequest } from '../dist/memory-service.js';
import { memoryAssessmentResponse } from './fixtures/memory-assessment.mjs';

test('显式通用笔记直接保存，来源、画像、人物隔离和重启一致', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-direct-memory-'));
  const databasePath = join(directory, 'pa.sqlite');
  let store = new ConversationStore(databasePath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const route = { channel: 'qq', accountId: 'test', roomType: 'group', roomId: 'group' };
  const conversation = store.ensureConversation('group', '/group.jsonl', route);
  const adapter = {
    remember: input => store.rememberMemory(conversation.id, input),
    correctMemory: (id, input, revision) => store.correctMemory(conversation.id, id, input, revision),
    selfProfileMemory: (actorId, field) => store.selfProfileMemory(conversation.id, actorId, field),
  };
  const sources = [];
  for (const [eventId, text] of [
    ['trip', '记住我下周要出差'],
    ['meeting', '请你记住明天的会议在三点'],
    ['friend', '帮我记住我朋友小明不吃辣'],
    ['multiline', '麻烦你记一下项目说明：\n' + '细节'.repeat(300)],
  ]) {
    const request = parseMemoryRequest(text);
    assert.equal(request?.type, 'self_update', text);
    const assessment = JSON.parse(memoryAssessmentResponse({ messages: [
      { role: 'system', content: '你是应用的记忆更新判断模块' },
      { role: 'user', content: JSON.stringify({ text }) },
    ] }, { decision: { target: 'sender', content: request.content } }));
    assert.equal(assessment.target, 'sender', text);
    assert.equal(assessment.save, true, text);
    assert.ok(text.normalize('NFKC').includes(assessment.content), text);
    assert.equal(assessment.field, undefined, text);
    const result = store.recordControlRun(conversation.id, text, { eventId, senderId: 'alice', modelInputText: text }, source => {
      sources.push(source);
      return executeMemoryRequest(request, adapter, source, false);
    });
    assert.equal(result.text, '记住了。');
    store.ackDelivery(result.deliveryId, 'sent');
  }
  const alice = sources[0].actorId;
  const bob = store.ensureActor(conversation.id, 'bob');
  const facts = store.autoMemory.profileForActors(alice)[0].facts;
  assert.equal(facts.length, 4);
  assert.equal(facts.find(f => f.content === '我下周要出差').sourceType, 'self');
  assert.equal(facts.find(f => f.content === '明天的会议在三点').sourceType, 'third_party');
  assert.equal(facts.find(f => f.content === '我朋友小明不吃辣').sourceType, 'third_party');
  assert.deepEqual(store.autoMemory.profileForActors(bob)[0].facts, []);
  assert.equal(store.queryMemories(conversation.id, '', 20, alice).length, 4);
  assert.equal(store.queryMemories(conversation.id, '', 20, bob).length, 0);
  assert.throws(() => store.recordControlRun(conversation.id, '记住我下周要出差', {
    eventId: 'trip', senderId: 'alice', modelInputText: '记住我下周要出差',
  }, () => assert.fail('重复来源不得再次保存')), { name: 'DuplicateMessageError' });
  store.close();
  store = new ConversationStore(databasePath);
  assert.deepEqual(store.autoMemory.profileForActors(alice)[0].facts, facts);
  assert.deepEqual(store.autoMemory.profileForActors(bob)[0].facts, []);
});

test('通用笔记纠正替换画像中的旧来源，保留记忆与画像审计版本', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-direct-correct-'));
  const databasePath = join(directory, 'pa.sqlite');
  const store = new ConversationStore(databasePath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const route = { channel: 'qq', accountId: 'test', roomType: 'group', roomId: 'group' };
  const conversation = store.ensureConversation('group', '/group.jsonl', route);
  let source, memory;
  const saved = store.recordControlRun(conversation.id, '记住明天会议三点', {
    eventId: 'old', senderId: 'alice', modelInputText: '记住明天会议三点',
  }, current => {
    source = current;
    memory = store.rememberMemory(conversation.id, {
      content: '明天会议三点', subjectActorId: current.actorId, sourceMessageId: current.id,
    }).memory;
    return '记住了。';
  });
  store.ackDelivery(saved.deliveryId, 'sent');
  const corrected = store.recordControlRun(conversation.id, `/memory correct ${memory.id} 明天会议四点`, {
    eventId: 'new', senderId: 'alice', modelInputText: '纠正会议',
  }, current => {
    store.correctMemory(conversation.id, memory.id, { content: '明天会议四点', sourceMessageId: current.id });
    return '记住了。';
  });
  store.ackDelivery(corrected.deliveryId, 'sent');
  const facts = store.autoMemory.profileForActors(source.actorId)[0].facts;
  assert.deepEqual(facts.map(f => f.content), ['明天会议四点']);
  assert.equal(facts[0].sourceType, 'third_party');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT content,status FROM memory_revisions WHERE memory_id=? ORDER BY revision').all(memory.id)
      .map(r => ({ ...r })), [
      { content: '明天会议三点', status: 'superseded' },
      { content: '明天会议四点', status: 'active' },
    ]);
    assert.ok(db.prepare('SELECT facts_json FROM person_profile_revisions').all().some(r => r.facts_json.includes('明天会议三点')));
    assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE id=?').get(source.id).n, 1);
  } finally { db.close(); }
  const ownerCorrection = store.recordControlRun(conversation.id, `/memory correct ${memory.id} 我提醒的会议改为五点`, {
    eventId: 'owner-new', senderId: 'owner', modelInputText: '管理员纠正会议',
  }, current => {
    store.correctMemory(conversation.id, memory.id, { content: '我提醒的会议改为五点', sourceMessageId: current.id });
    return '记住了。';
  });
  store.ackDelivery(ownerCorrection.deliveryId, 'sent');
  const ownerFacts = store.autoMemory.profileForActors(source.actorId)[0].facts;
  assert.deepEqual(ownerFacts.map(f => f.content), ['我提醒的会议改为五点']);
  assert.equal(ownerFacts[0].sourceType, 'third_party');

  const writer = new DatabaseSync(databasePath);
  try {
    writer.exec("CREATE TRIGGER fail_direct_profile BEFORE INSERT ON person_profile_revisions BEGIN SELECT RAISE(ABORT,'fixture atomic failure'); END");
    assert.throws(() => store.recordControlRun(conversation.id, '纠正失败', {
      eventId: 'atomic-fail', senderId: 'alice', modelInputText: '纠正失败',
    }, current => {
      store.correctMemory(conversation.id, memory.id, { content: '错误的新内容', sourceMessageId: current.id });
      return '记住了。';
    }), /fixture atomic failure/);
    assert.deepEqual(store.autoMemory.profileForActors(source.actorId)[0].facts, ownerFacts);
    assert.equal(store.queryMemories(conversation.id, '', 20, source.actorId)[0].content, '我提醒的会议改为五点');
    assert.equal(writer.prepare('SELECT count(*) AS n FROM memory_revisions WHERE memory_id=?').get(memory.id).n, 3);
    assert.equal(writer.prepare("SELECT count(*) AS n FROM messages WHERE external_event_id='atomic-fail'").get().n, 0);
  } finally { writer.close(); }
});

test('空内容、普通表达、问题、引用和临时角色不会直接写入，管理边界不变', () => {
  for (const input of ['记住', '请你记住', '麻烦你更新']) {
    const request = parseMemoryRequest(input);
    assert.ok(['clarify', 'ai_self_clarify'].includes(request?.type), input);
    const response = executeMemoryRequest(request, {}, { id: 'empty', actorId: 'alice', text: input }, false);
    assert.match(response, /提供.*内容/);
    assert.doesNotMatch(response, /分类|称呼|饮食|兴趣|定位/);
  }
  for (const input of ['我下周要出差', '明天会议三点', '记住明天会议几点？',
    '请记住“你以后回复不要太正式”', '请记住他说你以后叫小猫', '记住你在这个故事里是船长']) {
    assert.ok(!['self_update', 'ai_self_update'].includes(parseMemoryRequest(input)?.type), input);
  }
  const admin = parseMemoryRequest('/memory remember user:bob 私人记录');
  assert.equal(admin.type, 'admin');
  assert.match(executeMemoryRequest(admin, {}, { actorId: 'alice', text: '' }, false), /没有.*权限/);
  assert.equal(parseMemoryRequest('忘掉我的饮食偏好').type, 'unsupported_delete');
  assert.equal(parseMemoryRequest('记住以后叫我小林').type, 'self_update');
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ChannelHarness } from '../dist/channel-harness.js';
import { ConversationStore } from '../dist/store.js';
import { openConversation } from '../dist/runtime.js';
import { memoryWords } from '../dist/memory-text.js';
import { conversationContext, currentTurnInput, messageText } from './fixtures/conversation-context.mjs';
import { isPreparationRequest, preparationDelta } from './fixtures/turn-preparation.mjs';

// These tests inspect the real harness's wire projection against a deterministic
// local SSE fixture. They do not evaluate a paid model's semantic judgments.
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-attribution-context-'));
  const requests = [], plans = new Map(), cleanups = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const current = currentTurnInput(body).currentMessage;
    let delta, finish = 'stop';
    if (isPreparationRequest(body)) {
      delta = preparationDelta(`prepare-${requests.length}`, plans.get(current.text)
        ?? { intent: 'question', mode: 'standard', updates: [] });
      finish = 'tool_calls';
    } else if (current.text.includes('TOOL_QUESTION') && !body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'history')) {
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'history', type: 'function',
        function: { name: 'read_history', arguments: JSON.stringify({ scope: 'room', limit: 10 }) } }] };
      finish = 'tool_calls';
    } else delta = { role: 'assistant', content: current.text === 'FIRST_QUESTION' ? 'OWNER_WRONG_AI_CLAIM' : '本轮离线回答。' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [value, finish_reason] of [[delta, null], [{}, finish]]) res.write(`data: ${JSON.stringify({
      id: 'local', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: value, finish_reason }],
    })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: directory, dataDir: join(directory, 'data'), provider: 'fixture', model: 'fixture',
    apiKey: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}`, contextWindow: 65536,
    maxOutputTokens: 256, timeoutMs: 5000, memory: { enabled: true, maxCalls: 1, timeoutMs: 5000, maxOutputTokens: 512 }, ...overrides };
  const route = { channel: 'qq', accountId: 'bot', roomType: 'group', roomId: 'group' };
  const other = { ...route, roomId: 'other-group' };
  const policy = { version: 1, ownerBindings: [{ route, senderId: 'owner-id' }], persons: [
    { id: 'person-owner', bindings: [{ route, senderId: 'owner-id' }] },
    { id: 'person-chocolate', bindings: [{ route, senderId: 'chocolate-id' }] },
  ] };
  let backgroundCalls = 0;
  const harness = new ChannelHarness(config, [route, other], { send: async () => ({ status: 'sent', externalMessageId: 'out' }) }, 0, policy,
    { extract: async () => { backgroundCalls++; throw new Error('No background extraction is expected in this small fixture'); } });
  const message = (eventId, text, extra = {}) => ({ route, eventId, text, senderId: 'owner-id', senderName: '巧克力',
    mentioned: true, sentAt: new Date().toISOString(), ...extra });
  t.after(async () => { await harness.close(); for (const cleanup of cleanups) await cleanup(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true }); });
  return { config, route, other, policy, requests, plans, harness, message, cleanups, backgroundCalls: () => backgroundCalls };
}

function background(body) {
  const text = body.messages.map(messageText).find(text => text.includes('以下 JSON 是已保存的候选背景数据。'));
  assert.ok(text, 'full request must include its bounded background payload');
  return JSON.parse(text.slice(text.lastIndexOf('\n') + 1));
}

test('归因纠正保留speaker/subjects/excluded，屏蔽旧证据且同昵称不合人、不扩画像或权限', async t => {
  const f = await fixture(t);
  await f.harness.handle(f.message('chocolate-source', 'CHOCOLATE_ORIGINAL_BUG', { senderId: 'chocolate-id', mentioned: false }));
  await f.harness.handle(f.message('owner-profile', 'OWNER_STABLE_PROFILE', { mentioned: false }));
  await f.harness.handle(f.message('statement-source', 'ROOM_SHARED_STATEMENT <@chocolate-id>', { mentioned: false }));
  await f.harness.handle(f.message('wrong-source', 'OWNER_WRONG_USER_CLAIM', { mentioned: false }));
  assert.equal(await f.harness.handle(f.message('first-question', 'FIRST_QUESTION')), 'sent');
  const file = join(f.config.dataDir, 'pa.sqlite');
  const db = new DatabaseSync(file);
  db.function('history_tokens', { deterministic: true }, value => memoryWords(String(value ?? '')).join(' '));
  const source = event => db.prepare('SELECT * FROM messages WHERE external_event_id=?').get(event);
  const chocolate = source('chocolate-source'), owner = source('owner-profile'), wrong = source('wrong-source');
  const badAi = db.prepare("SELECT id,text FROM messages WHERE role='assistant' AND text='OWNER_WRONG_AI_CLAIM'").get();
  const store = new ConversationStore(file);
  f.cleanups.push(() => { store.close(); db.close(); });
  const ownerPerson = store.autoMemory.personForActor(owner.actor_id);
  const chocolatePerson = store.autoMemory.personForActor(chocolate.actor_id);
  assert.notEqual(ownerPerson, chocolatePerson);
  store.autoMemory.addProfilePending(ownerPerson, owner.id, 'OWNER_STABLE_PROFILE', 'self');
  store.autoMemory.addProfilePending(chocolatePerson, chocolate.id, 'CHOCOLATE_STABLE_PROFILE', 'self');
  store.autoMemory.addProfilePending(ownerPerson, wrong.id, 'DERIVED_WRONG_PENDING', 'self');
  db.prepare('UPDATE persons SET revision=1 WHERE id=?').run(ownerPerson);
  db.prepare('INSERT INTO person_profile_revisions VALUES (?,1,?,NULL,?)').run(ownerPerson,
    JSON.stringify([{ content: 'DERIVED_WRONG_ARCHIVED', sourceType: 'self', messageIds: [wrong.id] }]), new Date().toISOString());
  store.rememberMemory(owner.conversation_id, { content: 'LEGACY_CHOCOLATE_FACT', sourceMessageId: chocolate.id });
  store.prepareTurn(owner.conversation_id, source('statement-source').id, { intent: 'memory_update', mode: 'standard', updates: [{
    target: 'room_memory', content: 'ROOM_SHARED_STATEMENT <@chocolate-id>',
    attribution: { kind: 'statement', subjectSenderIds: ['chocolate-id'], excludedSenderIds: [], correctsMessageIds: [] },
  }] }, f.policy, ['chocolate-id']);
  store.rememberMemory(owner.conversation_id, { content: 'DERIVED_WRONG_ROOM_FACT', sourceMessageId: wrong.id });
  db.prepare("INSERT INTO auto_memory_jobs(id,conversation_id,reason,status,start_seq,end_seq,created_at) VALUES ('fixture-job',?,'capacity','done',0,0,?)")
    .run(owner.conversation_id, new Date().toISOString());
  db.prepare("INSERT INTO memory_topics(id,conversation_id,job_id,summary,content_hash,created_at) VALUES ('wrong-topic',?,'fixture-job','唤醒失败 DERIVED_WRONG_TOPIC','hash',?)")
    .run(owner.conversation_id, new Date().toISOString());
  db.prepare("INSERT INTO memory_topic_messages VALUES ('wrong-topic',?)").run(wrong.id);
  assert.equal(store.autoMemory.searchTopics(owner.conversation_id, { text: '唤醒失败' }).topics.length, 1);

  const correctionText = '记住：唤醒失败是<@chocolate-id>的，不是我的。';
  f.plans.set(correctionText, { intent: 'memory_update', mode: 'standard', updates: [{ target: 'room_memory', content: correctionText,
    attribution: { kind: 'correction', subjectSenderIds: ['chocolate-id'], excludedSenderIds: ['owner-id'], correctsMessageIds: [wrong.id, badAi.id] } }] });
  assert.equal(await f.harness.handle(f.message('correction', correctionText, { mentionedSenderIds: ['chocolate-id'] })), 'sent');
  const correction = source('correction');
  const sameTurnAnswer = f.requests.at(-1);
  const receipt = sameTurnAnswer.messages.findLast(message => message.role === 'tool');
  const receiptPayload = JSON.parse(messageText(receipt).slice(messageText(receipt).lastIndexOf('\n') + 1));
  assert.equal(receiptPayload.saved[0].status, 'saved');
  assert.deepEqual(receiptPayload.attributionCorrections[0], { memoryId: receiptPayload.attributionCorrections[0].memoryId,
    sourceMessageId: correction.id, speakerSenderId: 'owner-id', subjectSenderIds: ['chocolate-id'], excludedSenderIds: ['owner-id'], correctsMessageIds: [wrong.id, badAi.id] });

  assert.equal(await f.harness.handle(f.message('follow-up', '唤醒失败 TOOL_QUESTION', { quote: { messageId: 'wrong-source' } })), 'sent');
  const follow = f.requests.filter(body => currentTurnInput(body).currentMessage.text === '唤醒失败 TOOL_QUESTION');
  assert.equal(follow.length, 3, 'preparation, history tool request, and answer are all inspected');
  for (const body of follow) {
    const payload = background(body), input = currentTurnInput(body);
    assert.equal(input.identity.currentSender.personId, ownerPerson);
    assert.equal(input.identity.currentSender.isMaintainer, true);
    assert.deepEqual(input.identity.mentioned, []);
    assert.deepEqual(input.currentMessage.quotedMessage.correctedBy, [correction.id]);
    assert.equal(input.currentMessage.quotedMessage.sourceMessageId, wrong.id);
    assert.match(input.currentMessage.quotedMessage.text, /已被明确纠正/);
    assert.deepEqual(payload.profiles.map(profile => profile.personId), [ownerPerson]);
    assert.match(JSON.stringify(payload.profiles), /OWNER_STABLE_PROFILE/);
    assert.doesNotMatch(JSON.stringify(payload.profiles), /CHOCOLATE_STABLE_PROFILE|DERIVED_WRONG/);
    const fact = payload.attributionCorrections[0];
    assert.equal(fact.sourceSpeaker.senderId, 'owner-id');
    assert.equal(fact.sourceSpeaker.personId, ownerPerson);
    assert.equal(fact.sourceSpeaker.displayName, '巧克力');
    assert.equal(fact.sourceMessageId, correction.id);
    assert.ok(Number.isFinite(Date.parse(fact.sourceTime)));
    assert.deepEqual(fact.subjects.map(person => [person.senderId, person.personId]), [['chocolate-id', chocolatePerson]]);
    assert.equal(fact.subjects[0].displayName, fact.sourceSpeaker.displayName);
    assert.deepEqual(fact.excludedSubjects.map(person => person.senderId), ['owner-id']);
    assert.deepEqual(fact.correctsMessageIds, [wrong.id, badAi.id]);
    const legacy = payload.roomMemories.find(fact => fact.content === 'LEGACY_CHOCOLATE_FACT');
    assert.equal(legacy.sourceSpeaker.senderId, 'chocolate-id');
    assert.deepEqual(legacy.subjects, [], 'old unclassified facts must not guess their subject');
    const statement = payload.roomMemories.find(fact => fact.content === 'ROOM_SHARED_STATEMENT <@chocolate-id>');
    assert.equal(statement.sourceSpeaker.senderId, 'owner-id');
    assert.equal(statement.sourceMessageId, source('statement-source').id);
    assert.ok(Number.isFinite(Date.parse(statement.sourceTime)));
    assert.deepEqual(statement.subjects.map(person => person.personId), [chocolatePerson]);
    assert.deepEqual(payload.topics, []);
    const history = conversationContext(body).messages;
    assert.equal(history.find(message => message.id === chocolate.id).personId, chocolatePerson);
    assert.equal(history.find(message => message.id === chocolate.id).text, 'CHOCOLATE_ORIGINAL_BUG');
    for (const id of [wrong.id, badAi.id]) {
      const message = history.find(message => message.id === id);
      assert.deepEqual(message.correctedBy, [correction.id]);
      assert.match(message.text, /已被明确纠正/);
    }
    assert.equal(history.find(message => message.id === badAi.id).sourceType, 'assistant_statement');
    assert.doesNotMatch(JSON.stringify(body), /OWNER_WRONG_AI_CLAIM|OWNER_WRONG_USER_CLAIM|DERIVED_WRONG/);
  }
  const tool = follow.at(-1).messages.findLast(message => message.role === 'tool' && message.tool_call_id === 'history');
  assert.match(messageText(tool), /correctedBy/);
  assert.doesNotMatch(messageText(tool), /OWNER_WRONG_AI_CLAIM|OWNER_WRONG_USER_CLAIM/);
  assert.equal(db.prepare('SELECT text FROM messages WHERE id=?').get(badAi.id).text, 'OWNER_WRONG_AI_CLAIM');
  assert.equal(db.prepare('SELECT text FROM messages WHERE id=?').get(wrong.id).text, 'OWNER_WRONG_USER_CLAIM');
  assert.equal(db.prepare("SELECT content FROM person_profile_pending WHERE content='DERIVED_WRONG_PENDING'").get().content, 'DERIVED_WRONG_PENDING');
  const storedHistory = store.readHistory(owner.conversation_id, source('follow-up').id, { scope: 'room', limit: 10 });
  assert.equal(storedHistory.messages.find(message => message.id === badAi.id).text, 'OWNER_WRONG_AI_CLAIM');

  assert.equal(await f.harness.handle(f.message('other-question', 'OTHER_ROOM_QUESTION', { route: f.other })), 'sent');
  const otherRequest = f.requests.at(-1);
  assert.deepEqual(background(otherRequest).attributionCorrections, []);
  assert.equal(currentTurnInput(otherRequest).identity.currentSender.isMaintainer, false);
  assert.doesNotMatch(JSON.stringify(otherRequest), /LEGACY_CHOCOLATE_FACT|CHOCOLATE_ORIGINAL_BUG|唤醒失败是|DERIVED_WRONG/);

  const deniedText = '记住：无权保存这条群事实';
  f.plans.set(deniedText, { intent: 'memory_update', mode: 'standard', updates: [{ target: 'room_memory', content: deniedText }] });
  assert.equal(await f.harness.handle(f.message('denied', deniedText, { senderId: 'chocolate-id' })), 'sent');
  const deniedReceipt = f.requests.at(-1).messages.findLast(message => message.role === 'tool');
  assert.match(messageText(deniedReceipt), /没有管理/);
  assert.equal(store.queryMemories(owner.conversation_id, deniedText).length, 0);
  assert.equal(f.backgroundCalls(), 0);
});

for (const scenario of [{ count: 1, size: 3400, name: '第一条' }, { count: 2, size: 1700, name: '第二条' }]) test(`${scenario.name}必要纠正放不进背景预算时明确失败，不静默省略后回答`, async t => {
  const f = await fixture(t, { memory: { enabled: false } });
  const contents = [];
  for (let i = 0; i < scenario.count; i++) {
    const content = `记住第${i}条：` + '归'.repeat(scenario.size); contents.push(content);
    f.plans.set(content, { intent: 'memory_update', mode: 'standard', updates: [{ target: 'room_memory', content,
      attribution: { kind: 'correction', subjectSenderIds: [], excludedSenderIds: ['owner-id'], correctsMessageIds: [] } }] });
    assert.equal(await f.harness.handle(f.message(`long-correction-${i}`, content)), 'sent');
  }
  const before = f.requests.length;
  assert.equal(await f.harness.handle(f.message('after-long-correction', '下一个问题')), 'failed');
  assert.equal(f.requests.length, before, 'must fail before any request that hides the necessary correction');
  const db = new DatabaseSync(join(f.config.dataDir, 'pa.sqlite'), { readOnly: true });
  try { assert.deepEqual(db.prepare('SELECT content FROM memories ORDER BY rowid').all().map(row => row.content), contents); }
  finally { db.close(); }
});

test('超过8条有效纠正仍完整载入，不以条数上限放回旧归因', async t => {
  const f = await fixture(t, { memory: { enabled: false } });
  for (let i = 0; i < 9; i++) {
    const content = `记住：第${i}条归因不属于我`;
    f.plans.set(content, { intent: 'memory_update', mode: 'standard', updates: [{ target: 'room_memory', content,
      attribution: { kind: 'correction', subjectSenderIds: [], excludedSenderIds: ['owner-id'], correctsMessageIds: [] } }] });
    assert.equal(await f.harness.handle(f.message(`correction-${i}`, content)), 'sent');
  }
  assert.equal(await f.harness.handle(f.message('all-corrections', 'ALL_CORRECTIONS')), 'sent');
  const corrections = background(f.requests.at(-1)).attributionCorrections;
  assert.equal(corrections.length, 9);
  assert.match(corrections[0].content, /第8条/);
  assert.match(corrections.at(-1).content, /第0条/);
});

test('已压缩的错误来源被纠正且纠正过期后，不再把旧摘要注入为证据', async t => {
  const f = await fixture(t, { memory: { enabled: false } });
  await f.harness.handle(f.message('compressed-wrong-source', 'COMPRESSED_WRONG_OWNER_CLAIM', { mentioned: false }));
  const file = join(f.config.dataDir, 'pa.sqlite'), db = new DatabaseSync(file), store = new ConversationStore(file);
  f.cleanups.push(() => { store.close(); db.close(); });
  const wrong = db.prepare("SELECT id,conversation_id FROM messages WHERE external_event_id='compressed-wrong-source'").get();
  store.autoMemory.conversationContext(wrong.conversation_id);
  const cursor = db.prepare('SELECT seq FROM conversation_context_messages WHERE message_id=?').get(wrong.id).seq;
  const oldSummary = 'COMPRESSED_WRONG_OWNER_CLAIM，错误地归给owner。';
  db.prepare('UPDATE conversation_context_state SET cursor=?,completed_seq=?,revision=1,summary=? WHERE conversation_id=?')
    .run(cursor, cursor, oldSummary, wrong.conversation_id);
  const correctionText = '记住：压缩摘要里那条归因不是我的。';
  f.plans.set(correctionText, { intent: 'memory_update', mode: 'standard', updates: [{ target: 'room_memory', content: correctionText,
    attribution: { kind: 'correction', subjectSenderIds: [], excludedSenderIds: ['owner-id'], correctsMessageIds: [wrong.id] } }] });
  assert.equal(await f.harness.handle(f.message('compressed-correction', correctionText)), 'sent');
  const correction = db.prepare("SELECT id FROM messages WHERE external_event_id='compressed-correction'").get();
  const memoryId = store.roomFactContext(wrong.conversation_id).corrections[0].id;
  store.correctMemory(wrong.conversation_id, memoryId, { content: correctionText, sourceMessageId: correction.id, expiresAt: '2000-01-01T00:00:00Z' }, 1);
  const expired = store.roomFactContext(wrong.conversation_id);
  assert.deepEqual(expired.corrections, []);
  assert.ok(expired.correctedMessages[wrong.id]?.length);
  assert.equal(expired.summaryInvalidated, true);
  assert.equal(await f.harness.handle(f.message('after-expired-correction', 'EXPIRED_CORRECTION_QUESTION')), 'sent');
  for (const body of f.requests.filter(body => currentTurnInput(body).currentMessage.text === 'EXPIRED_CORRECTION_QUESTION')) {
    const context = conversationContext(body);
    assert.equal(context.summary.continuationSummary, '');
    assert.equal(context.summary.summaryUnavailableReason, '包含已明确纠正的旧来源，请用本轮有效资料或历史核验');
    assert.doesNotMatch(JSON.stringify(body), /COMPRESSED_WRONG_OWNER_CLAIM/);
    assert.deepEqual(background(body).attributionCorrections, []);
  }
  assert.equal(db.prepare('SELECT summary FROM conversation_context_state WHERE conversation_id=?').get(wrong.conversation_id).summary, oldSummary);
  assert.equal(db.prepare('SELECT text FROM messages WHERE id=?').get(wrong.id).text, 'COMPRESSED_WRONG_OWNER_CLAIM');
  assert.equal(f.backgroundCalls(), 0);
});

test('prepare实际回执超预算时阻止后续模型请求，不返回截断JSON', async t => {
  const f = await fixture(t, { memory: { enabled: false } });
  const runtime = await openConversation(f.config, 'receipt-budget');
  f.cleanups.push(() => runtime.close());
  let saved = false;
  await assert.rejects(runtime.prompt('[本轮明确输入]\n' + JSON.stringify({ currentMessage: { senderId: 'owner-id', text: 'budget' } }), {
    runId: 'receipt-budget', companionTools: { readHistory: () => [], prepareTurn: () => {
      saved = true;
      return { prepared: true, mode: 'standard', saved: [{ target: 'room_memory', status: 'saved' }], attributionCorrections: [{
        memoryId: 'm', sourceMessageId: 's', speakerSenderId: 'owner-id', subjectSenderIds: ['s'.repeat(12000)], excludedSenderIds: [], correctsMessageIds: [],
      }] };
    } },
  }), /回执超过工具结果预算/);
  assert.equal(saved, true, 'receipt overflow does not roll back a committed save');
  assert.equal(f.requests.length, 1, 'no model answer may consume a truncated receipt');
});

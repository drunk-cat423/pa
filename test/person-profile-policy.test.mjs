import { downgradeSchema14 } from './fixtures/legacy-schema.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { openRecordedConversation } from '../dist/conversation.js';
import { prepareMemoryExtraction } from '../dist/memory-provider.js';
import { SELF_PROFILE_POLICY } from '../dist/profile-policy.js';
import { emptyExtraction } from './fixtures/memory-output.mjs';
import { currentMessage, isPreparationRequest, preparationDelta } from './fixtures/turn-preparation.mjs';
import { decodeMemoryWireResponse } from '../dist/memory-wire.js';
import { validateExtract } from '../dist/auto-memory.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pa-person-profile-policy-'));
  const path = join(dir, 'store.sqlite');
  let store = new ConversationStore(path);
  const route = { channel: 'qq', accountId: 'test', roomType: 'group', roomId: 'policy-room' };
  const room = store.ensureConversation('policy-room', '/policy-room.jsonl', route);
  let sequence = 0;
  return {
    dir, path, route, room,
    get store() { return store; },
    inbound(text, senderId = 'alice') {
      const external = { eventId: String(++sequence), senderId, modelInputText: text, sentAt: '2026-01-01T00:00:00Z' };
      store.recordInbound(room.id, text, external);
      return { ...external, existingMessageId: store.externalMessage(room.id, external.eventId).id };
    },
    inspect(fn) { const db = new DatabaseSync(path); try { return fn(db); } finally { db.close(); } },
    restart() { store.close(); store = new ConversationStore(path); },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function batch(f) {
  f.store.autoMemory.reserveBatch(f.room.id, 'capacity');
  const job = f.store.autoMemory.claimNext(f.room.id, { owner: 'policy-test', leaseMs: 60000 });
  assert.ok(job);
  return { job, input: f.store.autoMemory.taskInput(job) };
}
function personFor(f, senderId = 'alice') {
  return f.store.autoMemory.personForActor(f.store.findActor(f.room.id, senderId));
}
function extract(input, profiles) {
  const updated = profiles.map(profile => {
    const baseline = input.profiles.find(item => item.personId === profile.personId);
    const updates = [];
    profile.facts.forEach((fact, factIndex) => {
      const baselineFactIndexes = baseline?.facts.flatMap((previous, index) => previous.content === fact.content
        && previous.sourceType === fact.sourceType ? [index] : []) ?? [];
      const evidence = fact.messageIds.flatMap(messageId => {
        const source = [...input.messages, ...(input.profileSources ?? [])].find(message => message.id === messageId);
        if (!source || source.role !== 'user' || !/^\s*(?:我|本人)/u.test(source.text)) return [];
        return [{ messageId, factQuote: source.text, subjectKind: 'self', subjectQuote: source.text.trim().startsWith('本人') ? '本人' : '我' }];
      });
      if (baselineFactIndexes.length || evidence.length) updates.push({ factIndex, baselineFactIndexes, evidence });
    });
    return { ...profile, updates };
  });
  return { ...emptyExtraction(input), profiles: updated };
}

test('即时画像接受归纳正文和当前确认，保留来源绑定而不复制原话证据', () => {
  const f = fixture();
  try {
    const policy = { version: 1, ownerBindings: [] };
    const text = '以后回答我时先给结论，有必要再解释理由，请记下来';
    const source = f.inbound(text);
    const content = '偏好先给结论，按需要解释理由';
    assert.equal(text.includes(content), false);
    const receipt = f.store.prepareTurn(f.room.id, source.existingMessageId,
      { intent: 'memory_update', mode: 'casual', updates: [{ target: 'sender', content }] }, policy);
    assert.deepEqual(receipt.saved, [{ target: 'sender', status: 'saved_pending' }]);
    const confirmed = f.inbound('可以，就按你说的来');
    f.store.prepareTurn(f.room.id, confirmed.existingMessageId,
      { intent: 'memory_update', mode: 'casual', updates: [{ target: 'sender', content: '希望解释时使用具体例子' }] }, policy);
    const pending = f.store.autoMemory.profile(personFor(f)).pending;
    assert.deepEqual(pending.map(item => [item.content, item.sourceMessageId, item.sourceType]), [
      [content, source.existingMessageId, 'self'], ['希望解释时使用具体例子', confirmed.existingMessageId, 'self'],
    ]);
    assert.ok(pending.every(item => item.subject === undefined));
    assert.deepEqual(f.inspect(db => db.prepare('SELECT subject_json FROM person_profile_pending ORDER BY rowid').all())
      .map(row => row.subject_json), [null, null]);
    assert.equal(f.inspect(db => db.prepare('SELECT text FROM messages WHERE id=?').get(source.existingMessageId)).text, text);
    assert.throws(() => f.store.autoMemory.addProfilePending(personFor(f), 'missing', content, 'self'), /实际发送者/);
    const now = Date.now();
    f.store.autoMemory.reserveMaterialsIfDue(f.room.id, now);
    f.store.autoMemory.reserveMaterialsIfDue(f.room.id, now + 600001);
    const job = f.store.autoMemory.claimNext(f.room.id, { owner: 'normalized-pending', leaseMs: 60000, pipeline: 'materials' });
    const input = f.store.autoMemory.taskInput(job);
    const step = { ...input, mode: 'profiles', profiles: [input.profiles.find(item => item.personId === personFor(f))] };
    const organized = validateExtract(decodeMemoryWireResponse({ changes: [
      { content, sources: ['q0'] }, { content: '希望解释时使用具体例子', sources: ['q1'] },
    ] }, step), step);
    f.store.autoMemory.commit(job.id, job.leaseToken, { ...emptyExtraction(input), profiles: organized.profiles });
    assert.deepEqual(f.store.autoMemory.profile(personFor(f)).facts.map(item => item.content), [content, '希望解释时使用具体例子']);
    assert.equal(f.store.autoMemory.profile(personFor(f)).pending.length, 0, 'normalized confirmation must also archive successfully');
    const evidence = f.inspect(db => db.prepare('SELECT evidence_json FROM person_profile_subject_updates').all());
    assert.ok(evidence.length > 0);
    assert.ok(evidence.every(row => !Object.hasOwn(JSON.parse(row.evidence_json), 'factQuote')), 'do not duplicate original text after validation');
  } finally { f.close(); }
});

test('给定正确计划时Bot名称落AI pending，下一轮注入并归档原来源，个人称呼和偏好隔离', async () => {
  // Scripted plans verify persistence and final SDK payloads, not model classification accuracy.
  const directory = mkdtempSync(join(tmpdir(), 'pa-profile-ownership-'));
  const requests = [], errors = [];
  const botName = '名称改为星河';
  const personal = ['希望被称为小林', '偏好短回答'];
  const plans = new Map([
    ['不是的，星河指的就是你，以后就叫这个名字', [{ target: 'ai_self', content: botName,
      subject: { subjectKind: 'ai', subjectQuote: '你' } }]],
    ['我希望你以后叫我小林；我偏好短回答，请记住', personal.map(content => ({ target: 'sender', content,
      subject: { subjectKind: 'self', subjectQuote: '我' } }))],
  ]);
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      const preparing = isPreparationRequest(body);
      const delta = preparing ? preparationDelta(`ownership-${requests.length}`, {
        intent: 'memory_update', mode: 'casual', updates: plans.get(currentMessage(body)?.text) ?? [],
      }) : { role: 'assistant', content: '好。' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [value, finish] of [[delta, null], [{}, preparing ? 'tool_calls' : 'stop']]) {
        response.write(`data: ${JSON.stringify({ id: 'ownership', object: 'chat.completion.chunk', created: 1,
          model: 'fixture', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); response.destroy(); }
  });
  let conversation, store;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const route = { channel: 'qq', accountId: 'test', roomType: 'group', roomId: 'ownership' };
    conversation = await openRecordedConversation({ cwd: directory, dataDir: directory,
      provider: 'fixture', model: 'fixture', apiKey: 'local-key',
      baseUrl: `http://127.0.0.1:${server.address().port}`, contextWindow: 32768,
      maxOutputTokens: 512, timeoutMs: 10000 }, 'ownership', route);
    let sequence = 0;
    for (const text of [...plans.keys(), '你好']) {
      const result = await conversation.prompt(text, { eventId: String(++sequence), senderId: 'alice', modelInputText: text });
      conversation.acknowledge(result.deliveryId, 'sent', `out-${sequence}`);
    }
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 6, 'three turns retain exactly preparation + answer');
    for (const request of requests.slice(2)) {
      const text = request.messages.map(message => typeof message.content === 'string' ? message.content
        : (message.content ?? []).map(part => part.text ?? '').join('')).join('\n');
      const block = text.split('[AI自身画像｜已归档与未归档]\n')[1];
      assert.ok(block, 'the next preparation and answer must both receive AI pending');
      const self = block.split('\n').map(line => { try { return JSON.parse(line); } catch { return undefined; } })
        .find(value => value && typeof value.archived === 'string' && Array.isArray(value.pending));
      assert.deepEqual(self, { archived: '', pending: [botName] });
    }
    store = new ConversationStore(join(directory, 'pa.sqlite'));
    const room = store.db.prepare('SELECT id FROM conversations').get();
    const source = store.externalMessage(room.id, '1');
    const personId = store.autoMemory.personForActor(store.findActor(room.id, 'alice'));
    assert.deepEqual(store.autoMemory.profile(personId).pending.map(item => item.content), personal);
    const snapshot = store.autoMemory.selfProfile.snapshot();
    assert.deepEqual(snapshot.pending.map(item => [item.content, item.sourceMessageId]), [[botName, source.id]]);
    store.autoMemory.reserveMaterialsIfDue(room.id, 1000);
    store.autoMemory.reserveMaterialsIfDue(room.id, 601000);
    const job = store.autoMemory.claimNext(room.id, { owner: 'ownership', leaseMs: 60000, pipeline: 'materials' });
    const input = store.autoMemory.taskInput(job);
    const step = { ...input, mode: 'self', profiles: [], messages: input.messages.filter(message => message.id === source.id) };
    assert.ok(prepareMemoryExtraction(step, 32768).systemPrompt.includes(SELF_PROFILE_POLICY));
    const organized = validateExtract(decodeMemoryWireResponse({ selfProfile: {
      baseVersion: snapshot.baseVersion, content: botName, pendingIds: ['s0'], updates: [],
    } }, step), step);
    store.autoMemory.commit(job.id, job.leaseToken, organized, undefined, { key: 'self', messageIds: [] });
    assert.equal(store.autoMemory.selfProfile.snapshot().content, botName);
    assert.deepEqual(store.autoMemory.selfProfile.snapshot().pending, []);
    assert.deepEqual(store.autoMemory.profile(personId).pending.map(item => item.content), personal);
    const archived = store.db.prepare('SELECT message_id,pending_id FROM self_profile_update_sources').all();
    assert.deepEqual(archived.map(row => [row.message_id, row.pending_id]), [[source.id, snapshot.pending[0].id]]);
  } finally {
    await conversation?.close();
    store?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('第三方归纳仍须管理员与真实对象定位，仅保存对象token兼容旧协议', () => {
  const f = fixture();
  try {
    f.inbound('我是Bob', 'bob');
    const policy = { version: 1, ownerBindings: [{ route: f.route, senderId: 'alice' }] };
    const update = { target: 'mentioned_person', senderId: 'bob', content: '长期关注绘画' };
    const denied = f.inbound('记住bob一直喜欢画画', 'eve');
    assert.throws(() => f.store.prepareTurn(f.room.id, denied.existingMessageId,
      { intent: 'memory_update', mode: 'casual', updates: [update] }, policy), /没有管理/);
    const ambiguous = f.inbound('把这点给他记一下');
    assert.throws(() => f.store.prepareTurn(f.room.id, ambiguous.existingMessageId,
      { intent: 'memory_update', mode: 'casual', updates: [update] }, policy), /对象无法/);
    const falseMention = f.inbound('<@bob>一直喜欢画画，请记下');
    assert.throws(() => f.store.prepareTurn(f.room.id, falseMention.existingMessageId,
      { intent: 'memory_update', mode: 'casual', updates: [{ ...update, subject: { subjectKind: 'mention', subjectQuote: '<@bob>' } }] }, policy), /对象无法/);
    const source = f.inbound('bob一直喜欢画画，请记下');
    f.store.prepareTurn(f.room.id, source.existingMessageId,
      { intent: 'memory_update', mode: 'casual', updates: [{ ...update, subject: { subjectKind: 'name', subjectQuote: 'bob' } }] }, policy);
    const pending = f.store.autoMemory.profile(personFor(f, 'bob')).pending;
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0].subject, { messageId: source.existingMessageId, factQuote: 'bob', subjectKind: 'name', subjectQuote: 'bob' });
    assert.equal(pending[0].content, '长期关注绘画');
    assert.equal(pending[0].sourceType, 'third_party');
    const ownSource = f.inbound('alice以后希望先给结论，请记下');
    f.store.prepareTurn(f.room.id, ownSource.existingMessageId, { intent: 'memory_update', mode: 'casual',
      updates: [{ target: 'mentioned_person', senderId: 'alice', content: '偏好先结论后解释',
        subject: { subjectKind: 'name', subjectQuote: 'alice' } }] }, policy);
    assert.equal(f.store.autoMemory.profile(personFor(f)).pending[0].sourceType, 'self', 'an explicitly named self still binds to the same real person');
  } finally { f.close(); }
});

test('本地审阅去除已确认任务问句污染，旧画像与原文保留且拒绝旧版本和在途资料任务', () => {
  const f = fixture();
  try {
    const text = '我喜欢读书，长期学习数学；我想问这个接口怎么调用';
    const source = f.inbound(text), personId = personFor(f), current = batch(f);
    const facts = ['喜欢读书', '询问接口如何调用', '长期学习数学'].map(content => ({
      content, sourceType: 'self', messageIds: [source.existingMessageId],
    }));
    f.store.autoMemory.commit(current.job.id, current.job.leaseToken, extract(current.input, [{ personId, baseVersion: 0, facts }]));
    const before = f.store.autoMemory.profile(personId);
    const confirmation=f.inbound('我再次确认自己长期学习数学');
    f.inspect(db=>db.prepare('INSERT INTO person_profile_revision_sources VALUES (?,?,?,?)')
      .run(personId,before.baseVersion,2,confirmation.existingMessageId));
    assert.throws(() => f.store.autoMemory.reviewProfile(personId, before.baseVersion, [0, 0]), /索引无效/);
    assert.throws(() => f.store.autoMemory.reviewProfile(personId, before.baseVersion, [3]), /超出完整基线/);
    assert.throws(() => f.store.autoMemory.reviewProfile(personId, before.baseVersion, [0], [{factIndex:1,content:'不能从移除项创建新事实'}]), /归纳条目/);
    const reworded={...before.facts[2],content:'长期学习数学，属于稳定学习背景'};
    assert.deepEqual(f.store.autoMemory.reviewProfile(personId, before.baseVersion, [2, 0], [{factIndex:2,content:reworded.content}]), {
      beforeVersion: before.baseVersion, afterVersion: before.baseVersion + 1, beforeCount: 3, afterCount: 2,
    });
    assert.deepEqual(f.store.autoMemory.profile(personId).facts, [before.facts[0], reworded]);
    assert.deepEqual(JSON.parse(f.inspect(db => db.prepare('SELECT facts_json FROM person_profile_revisions WHERE person_id=? AND revision=?')
      .get(personId, before.baseVersion)).facts_json), facts);
    assert.equal(f.inspect(db => db.prepare('SELECT text FROM messages WHERE id=?').get(source.existingMessageId)).text, text);
    assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM person_profile_revision_sources WHERE person_id=? AND revision=?')
      .get(personId, before.baseVersion)).n, 4);
    assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM person_profile_revision_sources WHERE person_id=? AND revision=? AND fact_index=1 AND message_id=?')
      .get(personId,before.baseVersion+1,confirmation.existingMessageId)).n,1,'rewording keeps supplementary confirmation chronology');
    assert.throws(() => f.store.autoMemory.reviewProfile(personId, before.baseVersion, [0]), /版本冲突/);
    f.store.autoMemory.reserveMaterialsIfDue(f.room.id, 1000);
    assert.ok(f.store.autoMemory.reserveMaterialsIfDue(f.room.id, 601000));
    assert.throws(() => f.store.autoMemory.reviewProfile(personId, before.baseVersion + 1, [0]), /资料任务/);
    const queued = f.store.autoMemory.claimNext(f.room.id, { owner: 'review-recovery', leaseMs: 60000, pipeline: 'materials' });
    f.store.autoMemory.fail(queued.id, queued.leaseToken, 'model_request test failure');
    assert.throws(() => f.store.autoMemory.reviewProfile(personId, before.baseVersion + 1, [0]), /等待自动恢复/);
    assert.deepEqual(f.store.autoMemory.profile(personId).facts, [before.facts[0], reworded]);
  } finally { f.close(); }
});

test('v13 migration backup preserves archived legacy pending rows and current database advances to v23', () => {
  const f = fixture();
  try {
    const source = f.inbound('我喜欢读书，也有旧版已归档提醒');
    const personId = personFor(f);
    let current = batch(f);
    f.store.autoMemory.commit(current.job.id, current.job.leaseToken, extract(current.input, [{ personId, baseVersion: 0,
      facts: [{ content: '喜欢读书', sourceType: 'self', messageIds: [source.existingMessageId] }] }]));
    f.store.autoMemory.addProfilePending(personId, source.existingMessageId, '旧版已归档提醒', 'self');
    const archived = f.store.autoMemory.profile(personId).pending[0];
    f.inspect(db => db.prepare('UPDATE person_profile_pending SET archived_revision=1,archived_at=? WHERE id=?').run('2026-10-16T00:00:00Z', archived.id));
    f.store.close();
    f.inspect(db => {
      downgradeSchema14(db);db.exec('DROP TABLE person_profile_pending_results; DROP TABLE person_profile_revision_sources; PRAGMA user_version=13;');
    });
    f.restart();
    assert.equal(f.inspect(db => db.prepare('PRAGMA user_version').get().user_version),33);
    assert.deepEqual({ ...f.inspect(db => db.prepare('SELECT id,person_id,source_message_id,archived_revision,archived_at FROM person_profile_pending WHERE id=?').get(archived.id)) }, {
      id: archived.id, person_id: personId, source_message_id: source.existingMessageId, archived_revision: 1, archived_at: '2026-10-16T00:00:00Z',
    });
    const backups = readdirSync(f.dir).filter(name => name.includes('.v13.') && name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(f.dir, backups[0]), { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 13);
      assert.deepEqual({ ...backup.prepare('SELECT id,person_id,source_message_id,archived_revision,archived_at FROM person_profile_pending WHERE id=?').get(archived.id) }, {
        id: archived.id, person_id: personId, source_message_id: source.existingMessageId, archived_revision: 1, archived_at: '2026-10-16T00:00:00Z',
      });
      assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE name='person_profile_pending_results'").get(), undefined);
      assert.deepEqual(backup.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { backup.close(); }
  } finally { f.close(); }
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ChannelHarness, channelConversationKey } from '../dist/channel-harness.js';
import { ConversationStore } from '../dist/store.js';
import { personLabel, messagePeople } from '../dist/context-people.js';
import { prepareMemoryWireExtraction } from '../dist/memory-wire.js';
import { conversationContext, currentTurnInput } from './fixtures/conversation-context.mjs';
import { companionReply } from './fixtures/companion-tools.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-context-people-'));
  const requests = [], sent = [], harnesses = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const reply = companionReply(body, 'A说B以前用的免费插件，花了八个小时才写了几行代码。');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish] of [[reply.delta, null], [{}, reply.finishReason]])
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: directory, dataDir: join(directory, 'data'), provider: 'deepseek', model: 'fixture',
    apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${server.address().port}`, contextWindow: 1000000,
    maxOutputTokens: 256, timeoutMs: 10000, memory: { enabled: false } };
  const route = { channel: 'qq', accountId: 'bot', roomType: 'group', roomId: 'people-test' };
  const other = { ...route, roomId: 'other-room' };
  const policy = { version: 1, ownerBindings: [], persons: [
    { id: 'person-a', bindings: [{ route, senderId: 'a' }] },
    { id: 'person-b', bindings: [{ route, senderId: 'b' }] },
    { id: 'person-c', bindings: [{ route, senderId: 'c' }] },
  ] };
  const open = () => {
    const harness = new ChannelHarness(config, [route, other], { send: async message => {
      sent.push(message); return { status: 'sent', externalMessageId: `out-${sent.length}` };
    } }, 0, policy);
    harnesses.push(harness); return harness;
  };
  const message = (eventId, text, senderId, options = {}) => ({ route, eventId, text, senderId,
    senderName: '同名昵称', mentioned: true, sentAt: new Date().toISOString(), ...options });
  t.after(async () => {
    await Promise.allSettled(harnesses.map(harness => harness.close()));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const conversationId = targetRoute => {
    const db = new DatabaseSync(join(config.dataDir, 'pa.sqlite'));
    try { return db.prepare(`SELECT c.id FROM conversations c JOIN rooms r ON r.id=c.room_id
      WHERE r.channel=? AND r.account=? AND r.external_chat_id=? AND r.room_type=?`)
      .get(targetRoute.channel, targetRoute.accountId, targetRoute.roomId, targetRoute.roomType)?.id; }
    finally { db.close(); }
  };
  return { config, route, other, requests, sent, open, message, conversationId };
}

test('speaker swap incident keeps source speaker, original AI reply target, quote identities, and history labels', async t => {
  const f = await fixture(t), harness = f.open();
  assert.equal(await harness.handle(f.message('a-source', '我之前用的免费插件，花了八个小时才写了几行代码。', 'a')), 'sent');
  assert.equal(f.sent.length, 1);
  const deliveredBotReplyId = 'out-1'; // fixture transport returned this externalMessageId for A's Bot reply
  const quoteStore = new ConversationStore(join(f.config.dataDir, 'pa.sqlite'));
  let deliveredBotReply;
  try { deliveredBotReply = quoteStore.quotedMessage(f.conversationId(f.route), deliveredBotReplyId); }
  finally { quoteStore.close(); }
  assert.equal(deliveredBotReply.role, 'assistant');
  assert.equal(deliveredBotReply.replyToPersonId, 'person-a');
  assert.equal(await harness.handle(f.message('b-question', '甲刚才说的是什么？我想记录这句话', 'b', { quote: {
    messageId: deliveredBotReplyId,
    inlineMessages: [
      { text: deliveredBotReply.text, senderId: 'unknown-platform-bot-author', senderName: '同名昵称' },
    ],
  } })), 'sent');

  const request = f.requests.at(-1), turn = currentTurnInput(request), context = conversationContext(request);
  const labelA = personLabel('person-a'), labelB = personLabel('person-b');
  assert.equal(turn.replyTarget.personLabel, labelB);
  assert.equal(turn.currentMessage.speakerLabel, labelB);
  assert.deepEqual(turn.currentMessage.quotedMessage.messages.map(item => item.speakerLabel), ['BOT']);
  assert.equal(turn.currentMessage.quotedMessage.messages[0].text, deliveredBotReply.text);
  assert.equal(turn.currentMessage.quotedMessage.messages[0].senderId, undefined);
  assert.equal(turn.currentMessage.quotedMessage.messages[0].senderName, undefined);
  assert.equal(Object.hasOwn(turn.currentMessage.quotedMessage.messages[0], 'subject'), false);
  assert.equal(turn.currentMessage.quotedMessage.speakerLabel, 'BOT');
  assert.equal(turn.currentMessage.quotedMessage.replyToLabel, labelA);
  assert.equal(await harness.handle(f.message('b-bot-author-human', '引用Bot原文，但平台明确标为A', 'b', { quote: {
    messageId: deliveredBotReplyId, inlineMessages: [
      { text: deliveredBotReply.text, senderId: 'a', senderName: '同名昵称' },
    ],
  } })), 'sent');
  const humanAttributedBotInline = currentTurnInput(f.requests.at(-1)).currentMessage.quotedMessage;
  assert.equal(humanAttributedBotInline.messages[0].speakerLabel, labelA);
  assert.equal(humanAttributedBotInline.messages[0].senderId, 'a');
  assert.equal(Object.hasOwn(humanAttributedBotInline, 'speakerLabel'), false);
  assert.equal(Object.hasOwn(humanAttributedBotInline, 'replyToLabel'), false);
  const source = context.messages.find(item => item.text.includes('八个小时'));
  const oldReply = context.messages.find(item => item.role === 'assistant');
  assert.equal(source.speakerLabel, labelA);
  assert.equal(oldReply.speakerLabel, 'BOT');
  assert.equal(oldReply.replyToLabel, labelA);
  assert.notEqual(turn.replyTarget.personLabel, oldReply.replyToLabel);

  const humanStore = new ConversationStore(join(f.config.dataDir, 'pa.sqlite'));
  let humanSource;
  try { humanSource = humanStore.quotedMessage(f.conversationId(f.route), 'a-source'); }
  finally { humanStore.close(); }
  assert.equal(humanSource.role, 'user');
  assert.equal(await harness.handle(f.message('b-inline-human', '引用甲的原话和另一条同昵称内容', 'b', { quote: {
    messageId: 'a-source', inlineMessages: [
      { text: humanSource.text, senderId: 'a', senderName: '同名昵称' },
      { text: '冒用同昵称但身份未知', senderId: 'intruder', senderName: '同名昵称' },
    ],
  } })), 'sent');
  const humanQuote = currentTurnInput(f.requests.at(-1)).currentMessage.quotedMessage;
  assert.equal(humanQuote.messages[0].speakerLabel, labelA);
  assert.equal(humanQuote.messages[0].text, humanSource.text);
  assert.equal(humanQuote.messages[1].speakerLabel, 'UNKNOWN');
  assert.equal(humanQuote.messages[1].text, '冒用同昵称但身份未知');
  assert.equal(Object.hasOwn(humanQuote, 'speakerLabel'), false);
  assert.equal(Object.hasOwn(humanQuote, 'replyToLabel'), false);
  assert.equal(Object.hasOwn(humanQuote.messages[0], 'subject'), false);

  const store = new ConversationStore(join(f.config.dataDir, 'pa.sqlite'));
  try {
    const conversation = f.conversationId(f.route);
    const current = store.db.prepare("SELECT id FROM messages WHERE conversation_id=? AND role='user' AND text LIKE '%甲刚才说的是什么%' ORDER BY ingest_seq DESC LIMIT 1").get(conversation).id;
    const history = store.readHistory(conversation, current, { scope: 'room', limit: 10 });
    assert.equal(history.messages.find(item => item.text.includes('八个小时')).speakerLabel, labelA);
    assert.equal(Object.hasOwn(history.messages.find(item => item.text.includes('八个小时')), 'replyToLabel'), false);
    assert.equal(history.messages.find(item => item.role === 'assistant').replyToLabel, labelA);
  } finally { store.close(); }
  assert.equal(f.requests.length, 8, 'four ordinary turns should each use the normal two model requests');
});

test('adding people, changing sender, restart, and another room preserve the existing context prefix and raw records', async t => {
  const f = await fixture(t), harness = f.open();
  assert.equal(await harness.handle(f.message('a-first', '第一条：A的原始记录。', 'a')), 'sent');
  const store = new ConversationStore(join(f.config.dataDir, 'pa.sqlite'));
  try {
    const conversation = f.conversationId(f.route);
    const source = store.db.prepare("SELECT id FROM messages WHERE conversation_id=? AND role='user' AND text=?").get(conversation, '第一条：A的原始记录。');
    assert.ok(source);
    assert.ok(source.id);
  } finally { store.close(); }

  assert.equal(await harness.handle(f.message('b-second', '第二条：B的新内容。', 'b')), 'sent');
  let context = conversationContext(f.requests.at(-1));
  const stablePrefix = context.historyRaw;
  assert.ok(stablePrefix.length > 0, 'capture history after it contains A\'s first message');
  assert.ok(stablePrefix.includes('第一条：A的原始记录。'));
  assert.ok(context.historyRaw.startsWith(stablePrefix));
  assert.equal(context.messages.find(item => item.text.includes('第一条')).speakerLabel, personLabel('person-a'));
  assert.equal(currentTurnInput(f.requests.at(-1)).currentMessage.speakerLabel, personLabel('person-b'));
  await harness.close();

  const reopened = f.open();
  assert.equal(await reopened.handle(f.message('a-after-restart', '重启后的A消息。', 'a', { senderName: 'A的新昵称' })), 'sent');
  context = conversationContext(f.requests.at(-1));
  assert.ok(context.historyRaw.startsWith(stablePrefix));
  assert.equal(context.messages.find(item => item.text.includes('第一条')).speakerLabel, personLabel('person-a'));
  assert.equal(context.messages.find(item => item.text.includes('第二条')).speakerLabel, personLabel('person-b'));
  assert.equal(context.messages.find(item => item.text.includes('第一条')).senderName, '同名昵称');
  assert.equal(currentTurnInput(f.requests.at(-1)).currentMessage.senderName, 'A的新昵称');

  assert.equal(await reopened.handle(f.message('c-third', '第三条：C加入群聊。', 'c', { senderName: '新成员' })), 'sent');
  context = conversationContext(f.requests.at(-1));
  assert.ok(context.historyRaw.startsWith(stablePrefix));
  assert.equal(currentTurnInput(f.requests.at(-1)).currentMessage.speakerLabel, personLabel('person-c'));
  assert.equal(currentTurnInput(f.requests.at(-1)).currentMessage.senderName, '新成员');
  assert.equal(await reopened.handle(f.message('after-c-check', '确认C之前说了什么？', 'a')), 'sent');
  context = conversationContext(f.requests.at(-1));
  assert.ok(context.historyRaw.startsWith(stablePrefix));
  assert.equal(context.messages.find(item => item.text.includes('第三条：C加入群聊')).speakerLabel, personLabel('person-c'));

  const before = f.requests.length;
  assert.equal(await reopened.handle(f.message('other-room', '另一房间消息', 'a', { route: f.other })), 'sent');
  assert.equal(f.requests.length, before + 2);
  const crossRoomStore = new ConversationStore(join(f.config.dataDir, 'pa.sqlite'));
  try {
    const sourceId = crossRoomStore.db.prepare("SELECT id FROM messages WHERE role='user' AND text=?").get('第一条：A的原始记录。').id;
    assert.throws(() => crossRoomStore.readHistory(f.conversationId(f.other), sourceId, { scope: 'room' }), /边界/);
  } finally { crossRoomStore.close(); }
  const db = new DatabaseSync(join(f.config.dataDir, 'pa.sqlite'));
  try {
    assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE text LIKE '%第一条：A的原始记录%' AND role='user'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE text LIKE '%第二条：B的新内容%' AND role='user'").get().n, 1);
  } finally { db.close(); }
});

test('background memory projections keep stable person labels across local reference remapping and unknown legacy identity', () => {
  const message = (id, role, text, personId, replyToPersonId) => ({ id, role, text, personId, replyToPersonId,
    conversationId: 'conversation-a', ingestSeq: 1, createdAt: '2026-10-26T00:00:00.000Z' });
  const base = { extractionProtocol: 2, profileProtocol: 2, contextProtocol: 1, pipeline: 'compression', roomType: 'group',
    previousSummary: '', job: { id: 'job', conversationId: 'conversation-a', reason: 'capacity', status: 'queued', startSeq: 1,
      endSeq: 1, messageIds: ['a-msg', 'bot-msg'], attempts: 0 },
    messages: [message('a-msg', 'user', 'A的原文', 'person-a'), message('bot-msg', 'assistant', '回复A', undefined, 'person-a')],
    profiles: [{ personId: 'person-a', baseVersion: 1, facts: [] }] };
  const original = structuredClone(base);
  const first = JSON.parse(prepareMemoryWireExtraction(base, 100000).userContent);
  const changedMapping = structuredClone(base);
  changedMapping.profiles.unshift({ personId: 'person-b', baseVersion: 1, facts: [] });
  const second = JSON.parse(prepareMemoryWireExtraction(changedMapping, 100000).userContent);
  assert.equal(first.messages[0].personId, 'p0');
  assert.equal(second.messages[0].personId, 'p1');
  assert.equal(first.messages[0].speakerLabel, personLabel('person-a'));
  assert.equal(second.messages[0].speakerLabel, personLabel('person-a'));
  assert.equal(first.messages[1].replyToLabel, personLabel('person-a'));
  assert.equal(messagePeople({ role: 'user' }).speakerLabel, 'UNKNOWN');
  assert.match(prepareMemoryWireExtraction(base, 100000).systemPrompt, /稳定人物标签/);
  const topicWire = prepareMemoryWireExtraction({...base,pipeline:'materials',materialsProtocol:3,mode:'messages'},100000);
  assert.equal(JSON.parse(topicWire.userContent).messages[0].speakerLabel,personLabel('person-a'));
  assert.match(topicWire.systemPrompt,/Topic和摘要涉及人物时保留稳定人物标签/);
  const profileWire = prepareMemoryWireExtraction({...base,pipeline:'materials',materialsProtocol:3,mode:'profiles',
    profileProposalProtocol:'delta-v1'},100000);
  const profileInput=JSON.parse(profileWire.userContent);
  assert.equal(profileInput.personLabel,personLabel('person-a'));
  assert.equal(profileInput.sources[0].speakerLabel,personLabel('person-a'));
  assert.deepEqual(base,original,'model projections must not rewrite the frozen source input');
});

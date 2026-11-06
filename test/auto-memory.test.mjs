import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { companionReply } from './fixtures/companion-tools.mjs';
import { conversationMessages } from './fixtures/turn-preparation.mjs';
import { ChannelHarness } from '../dist/channel-harness.js';
import { ConversationStore } from '../dist/store.js';
import { conversationContext } from './fixtures/conversation-context.mjs';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function wait(signal, gate) {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    gate.then(() => { signal.removeEventListener('abort', abort); resolve(); });
  });
}
function extracted(input) {
  if (input.pipeline === 'compression') return { topics: [], fragments: [], profiles: [], ignoredMessageIds: [],
    continuationSummary: '已经讨论测试计划，下一步继续执行。' };
  if (input.mode === 'profiles') return { profiles: input.profiles.map(profile => ({ personId: profile.personId,
    baseVersion: profile.baseVersion, facts: profile.facts, pendingResults: (profile.pending ?? []).map(pending => ({ pendingId: pending.id, status: 'deferred' })) })) };
  const ids = input.messages.filter(message => message.role === 'user').map(message => message.id);
  return { topics: ids.length ? [{ summary: '本批讨论了测试计划。', messageIds: input.extractionProtocol === 2 ? [] : ids }] : [],
    fragments: [], profiles: [], ignoredMessageIds: [],
    ...(input.roomType === 'private' || input.contextProtocol === 1
      ? { continuationSummary: '已经讨论测试计划，下一步继续执行。' } : {}) };
}

function currentMessageText(body) {
  const user = conversationMessages(body).filter(message => message.role === 'user').at(-1);
  if (!user) return '';
  const content = typeof user.content === 'string' ? user.content : user.content.map(part => part.text ?? '').join('');
  try { return JSON.parse(content.slice(content.lastIndexOf('\n') + 1)).currentMessage?.text ?? content; }
  catch { return content; }
}

function backgroundPayload(body) {
  const message = body.messages.filter(item => item.role === 'user').findLast(item => {
    const content = typeof item.content === 'string' ? item.content : item.content.map(part => part.text ?? '').join('');
    return content.includes('已保存的候选背景数据');
  });
  assert.ok(message, 'request should carry its bounded background payload');
  const content = typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('');
  return JSON.parse(content.slice(content.lastIndexOf('\n') + 1));
}

async function fixture(t, extract = async input => extracted(input), overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-memory-integration-'));
  const requests = [], sent = [], inputs = [], harnesses = [];
  const chatGate = deferred();
  const chatStarted = deferred();
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    if (currentMessageText(body).includes('BLOCK_CHAT')) { chatStarted.resolve(); await chatGate.promise; }
    const reply = companionReply(body,'继续讨论');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choices of [
      [{ index: 0, delta: reply.delta, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: reply.finishReason }],
    ]) response.write(`data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: directory, dataDir: join(directory, 'data'), provider: 'deepseek', model: 'fixture',
    apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${server.address().port}`, contextWindow: 1000000,
    maxOutputTokens: 256, timeoutMs: 10000,
    memory: { enabled: true, maxCalls: 100, timeoutMs: 10000 }, ...overrides };
  config.memory = { maxOutputTokens: 8192, ...config.memory };
  const route = { channel: 'qq', accountId: 'bot', roomType: 'group', roomId: 'g1' };
  const other = { ...route, roomId: 'g2' };
  const privateRoute = { ...route, roomType: 'private', roomId: 'private-a' };
  const provider = { extract: async (input, signal) => { inputs.push(structuredClone(input)); return extract(input, signal); } };
  function harness(policy = { version: 1, ownerBindings: [] }) {
    const h = new ChannelHarness(config, [route, other, privateRoute], {
      send: async message => { sent.push(message); return { status: 'sent', externalMessageId: `out-${sent.length}` }; } }, 0, policy, provider);
    harnesses.push(h); return h;
  }
  const message = (id, text, options = {}) => ({ route, eventId: id, text, senderId: 'a',
    mentioned: false, sentAt: new Date().toISOString(), ...options });
  t.after(async () => {
    chatGate.resolve();
    await Promise.allSettled(harnesses.map(h => h.close()));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { config, route, other, privateRoute, requests, sent, inputs, harness, message, chatGate, chatStarted,
    reserveCapacity(route) {
      const db = new DatabaseSync(join(config.dataDir, 'pa.sqlite'));
      let conversationId;
      try {
        conversationId = db.prepare(`SELECT c.id FROM conversations c JOIN rooms r ON r.id=c.room_id
          WHERE r.channel=? AND r.account=? AND r.external_chat_id=? AND r.room_type=?`)
          .get(route.channel, route.accountId, route.roomId, route.roomType).id;
      } finally { db.close(); }
      const store = new ConversationStore(join(config.dataDir, 'pa.sqlite'));
      try { return store.autoMemory.reserveBatch(conversationId, 'capacity'); }
      finally { store.close(); }
    },
    retryFailed: () => {
      const store = new ConversationStore(join(config.dataDir, 'pa.sqlite'));
      try { for (const job of store.autoMemory.listJobs()) if (job.status === 'failed') store.autoMemory.retry(job.id); }
      finally { store.close(); }
    },
    db: () => new DatabaseSync(join(config.dataDir, 'pa.sqlite')) };
}

test('最终上下文达到85%才整理；摘要与检查点后消息跨新轮和重启继续', async t => {
  const gate = deferred(), started = deferred();
  let extractionStarted = false;
  // Leave room for the expanded preparation protocol after compaction, while
  // the growing 3500-character messages still cross the actual 85% boundary.
  const f = await fixture(t, async (input, signal) => { extractionStarted = true; started.resolve(); await wait(signal, gate.promise); return extracted(input); }, { contextWindow: 32768 });
  const h = f.harness();
  let pending;
  for (let i = 1; i <= 10 && !extractionStarted; i++) {
    pending = h.handle(f.message(`capacity${i}`, `${i}:` + 'x'.repeat(3500), { route: f.privateRoute }));
    const state = await Promise.race([pending.then(result => ({ result })), started.promise.then(() => ({ started: true }))]);
    if (state.started) break;
    assert.equal(state.result, 'sent');
  }
  assert.ok(extractionStarted, 'the measured final request should cross the 85% threshold');
  await started.promise;
  let finished = false; void pending.then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(finished, false);
  const before = f.requests.filter(request=>request.messages.at(-2)?.role==='tool').length; gate.resolve();
  assert.equal(await pending, 'sent'); assert.equal(f.requests.filter(request=>request.messages.at(-2)?.role==='tool').length, before + 1);
  await h.waitForMemory(); assert.equal(f.inputs[0].contextProtocol, 1);
  assert.equal(await h.handle(f.message('capacity-follow-up', 'CAPACITY_FOLLOW_UP', { route: f.privateRoute })), 'sent');
  let context = conversationContext(f.requests.at(-1));
  assert.equal(context.summary.continuationSummary, '已经讨论测试计划，下一步继续执行。');
  assert.ok(context.summary.checkpoint > 0);
  assert.equal(await h.handle(f.message('capacity-tail-check', 'CAPACITY_TAIL_CHECK', { route: f.privateRoute })), 'sent');
  context = conversationContext(f.requests.at(-1));
  assert.ok(context.messages.some(message => message.text === 'CAPACITY_FOLLOW_UP'));
  await h.close();
  const reopened = f.harness();
  assert.equal(await reopened.handle(f.message('capacity-reopened', 'CAPACITY_AFTER_RESTART', { route: f.privateRoute })), 'sent');
  context = conversationContext(f.requests.at(-1));
  assert.equal(context.summary.continuationSummary, '已经讨论测试计划，下一步继续执行。');
  assert.ok(context.messages.some(message => message.text === 'CAPACITY_FOLLOW_UP'));
  assert.ok(!context.messages.some(message => message.text === 'CAPACITY_AFTER_RESTART'));
});

test('仅发送者及真实@对象画像，绑定人物私聊自述可在群使用', async t => {
  const f = await fixture(t); const binding = (route, senderId) => ({ route, senderId });
  const policy = { version: 1, ownerBindings: [], persons: [{ id: 'person-a', bindings: [binding(f.privateRoute, 'a'), binding(f.route, 'a')] }] };
  const h = f.harness(policy);
  assert.equal(await h.handle(f.message('pref-a', '记住我喜欢登山', { route: f.privateRoute })), 'sent');
  assert.equal(await h.handle(f.message('pref-b', '记住我喜欢绘画', { senderId: 'b', mentioned: true })), 'sent');
  assert.equal(await h.handle(f.message('ask-no-at', '和小B玩什么', { mentioned: true })), 'sent');
  const noAtInput = backgroundPayload(f.requests.at(-1));
  assert.ok(noAtInput.profiles.some(profile => profile.senderIds.includes('a')));
  assert.ok(!noAtInput.profiles.some(profile => profile.personId === 'person-b' || profile.senderIds.includes('b')));
  assert.ok(!JSON.stringify(noAtInput.profiles).includes('绘画'));
  assert.ok(conversationContext(f.requests.at(-1)).messages
    .some(message => message.senderId === 'b' && message.text.includes('绘画')));
  assert.equal(await h.handle(f.message('ask-at', '和被提及的人玩什么', { mentioned: true, mentionedSenderIds: ['b', 'b'] })), 'sent');
  const mentionedProfiles = backgroundPayload(f.requests.at(-1)).profiles;
  assert.ok(mentionedProfiles.some(profile => profile.senderIds.includes('a')));
  assert.ok(mentionedProfiles.some(profile => profile.senderIds.includes('b')
    && JSON.stringify(profile).includes('绘画')));
});

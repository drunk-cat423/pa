import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ChannelHarness } from '../dist/channel-harness.js';
import { QQChannel } from '../dist/qq-channel.js';
import { ConversationStore } from '../dist/store.js';
import { currentMessage, isPreparationRequest, preparationDelta } from './fixtures/turn-preparation.mjs';

const sourceUrl = 'https://example.com/research-source';
const report = '# CUA 部署研究\n\n## 结论\n报告应保留完整内容，仅在需要时读取。\n\n'
  + '经过核验的正文。'.repeat(40) + '\n\n## 来源\n' + sourceUrl + '\n\nEND_OF_REPORT_MARKER';
const reportOutput = (status = 'completed') => JSON.stringify({ status, abstract: 'CUA 部署资料与限制',
  keywords: ['CUA', '部署'], reason: status === 'blocked' ? '指定原文网络不可用' : '', markdown: report });
const call = (tool, args) => ({ tool, args });
const answer = text => ({ answer: text });
const userText = body => {
  const value = body.messages.findLast(message => message.role === 'user')?.content;
  return typeof value === 'string' ? value : value?.map(block => block.text ?? '').join('') ?? '';
};
function lastTool(body) {
  const value = body.messages.findLast(message => message.role === 'tool')?.content;
  const text = typeof value === 'string' ? value : value?.map(block => block.text ?? '').join('') ?? '';
  return JSON.parse(text.slice(text.lastIndexOf('\n') + 1));
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-research-e2e-'));
  const requests = [], pages = [], qqRequests = [], plans = new Map(), workerPlans = new Map(), errors = [], harnesses = [];
  let pageFails = false, fileUnknown = false;
  const server = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text), message = currentMessage(body);
      const worker = message ? undefined : JSON.parse(userText(body));
      requests.push({ body, message, worker });
      let step;
      if (isPreparationRequest(body)) step = { delta: preparationDelta(`prepare-${requests.length}`) };
      else {
        const plan = message ? plans.get(message.eventId) : workerPlans.get(worker.task.title);
        assert.ok(plan?.length, `没有为本次请求设置步骤：${message?.eventId ?? worker.task.title}`);
        const next = plan.shift(); step = typeof next === 'function' ? next(body) : next;
      }
      const delta = step.delta ?? (step.tool ? { role: 'assistant', tool_calls: [{ index: 0,
        id: `call-${requests.length}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }
        : { role: 'assistant', content: step.answer });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [value, finish] of [[delta, null], [{}, step.delta || step.tool ? 'tool_calls' : 'stop']]) {
        response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
          model: 'fixture', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); response.writeHead(500); response.end('fixture error'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.mock.method(https, 'request', (...args) => {
    const url = args[0] instanceof URL ? args[0] : undefined;
    const options = url ? args[1] : args[0], callback = url ? args[2] : args[1];
    const request = new EventEmitter(); request.destroy = () => {}; request.setTimeout = () => request;
    request.end = () => queueMicrotask(() => {
      if (url) {
        pages.push(url.href);
        if (pageFails) { request.emit('error', Object.assign(new Error('fixture network unavailable'), { code: 'ECONNRESET' })); return; }
      }
      const type = !url && new URL(options.path, 'https://cloudflare-dns.com').searchParams.get('type');
      const body = url ? 'CUA 官方资料，真实读取标识 PAGE_EVIDENCE'
        : JSON.stringify({ Status: 0, Answer: type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [] });
      const response = Readable.from([Buffer.from(body)]);
      response.statusCode = 200; response.headers = { 'content-type': url ? 'text/plain; charset=utf-8' : 'application/dns-json' };
      callback(response);
    });
    return request;
  });
  const qq = new QQChannel({ appId: 'app', clientSecret: 'fixture-secret' }, { onMessage() {} }, {
    fetch: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      qqRequests.push({ url, body });
      if (url.endsWith('/app/getAppAccessToken')) return Response.json({ access_token: 'fixture-token', expires_in: 7200 });
      if (url.endsWith('/gateway/bot')) return Response.json({ url: 'wss://api.bot.qq.com/ws' });
      if (url.endsWith('/files')) return Response.json({ file_info: 'fixture-file-info' });
      assert.ok(url.endsWith('/messages'));
      if (body.msg_type === 7 && fileUnknown) throw new Error('fixture send result unknown');
      return Response.json({ id: `qq-${qqRequests.length}`, ext_info: { ref_idx: `ref-${qqRequests.length}` } });
    },
    webSocketFactory() {
      const listeners = new Map();
      const socket = { readyState: 1, addEventListener(name, listener) { listeners.set(name, listener); }, send() {}, close() {} };
      queueMicrotask(() => listeners.get('message')({ data: JSON.stringify({ op: 0, t: 'READY',
        d: { user: { id: 'bot' }, session_id: 'fixture-session' } }) }));
      return socket;
    },
  });
  await qq.start();
  const route = { channel: 'qq', accountId: 'app', roomType: 'group', roomId: 'group' };
  const privateRoute = { ...route, roomType: 'private', roomId: 'alice-dm' };
  const secondGroup = { ...route, roomId: 'another-group' };
  const config = { cwd: directory, dataDir: join(directory, 'data'), provider: 'fixture', model: 'fixture', apiKey: 'local-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 131072, maxOutputTokens: 4096, timeoutMs: 5000,
    research: { enabled: true, maxModelCalls: 12, maxToolCalls: 24, maxSearchCalls: 6 },
    fetch: { enabled: true, publicDns: true, timeoutMs: 1000, maxResponseBytes: 1048576, maxTextChars: 8000 } };
  const inspect = operation => {
    const db = new DatabaseSync(join(config.dataDir, 'pa.sqlite'), { readOnly: true });
    try { return operation(db); } finally { db.close(); }
  };
  const harness = async () => {
    const h = new ChannelHarness(config, [route, privateRoute, secondGroup], qq, 0, { version: 1, ownerBindings: [],
      persons: [{ id: 'alice-person', bindings: [{ route, senderId: 'alice' },
        { route: privateRoute, senderId: 'alice-private' }, { route: secondGroup, senderId: 'alice-other-group' }] }] });
    harnesses.push(h); await h.start(); return h;
  };
  const message = (eventId, text, senderId = 'alice') => ({ route, eventId, text, senderId,
    mentioned: true, sentAt: new Date().toISOString() });
  const taskRows = () => inspect(db => db.prepare('SELECT * FROM research_tasks ORDER BY created_at,id').all());
  t.after(async () => {
    await Promise.allSettled(harnesses.map(h => h.close())); qq.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  return { config, route, privateRoute, secondGroup, requests, pages, qqRequests, plans, workerPlans, inspect, harness, message, taskRows, errors,
    pageFails(value) { pageFails = value; }, fileUnknown(value) { fileUnknown = value; } };
}

test('研究端到端：模型建任务、跨群私聊本人清单与领取、他人隔离及历史边界', async t => {
  const f = await fixture(t), h = await f.harness();
  f.plans.set('normal', [answer('CUA 是计算机操作代理。')]);
  assert.equal(await h.handle(f.message('normal', 'CUA 是什么？')), 'sent');
  assert.equal(f.taskRows().length, 0);
  f.plans.set('create', [call('create_research', { key: 'cua', title: 'CUA 部署', goal: '研究部署条件', urls: [sourceUrl], requiresOriginal: true }),
    body => { assert.equal(lastTool(body).saved, true); return answer('已加入研究清单。'); }]);
  f.workerPlans.set('CUA 部署', [call('web_fetch', { url: sourceUrl }), body => {
    assert.match(JSON.stringify(body.messages), /PAGE_EVIDENCE/); return answer(reportOutput());
  }]);
  const creation = f.message('create', '把 CUA 放进研究清单，研究部署条件并生成报告。');
  assert.equal(await h.handle(creation), 'sent'); await h.waitForResearch();
  const task = f.taskRows()[0];
  assert.equal(task.status, 'completed'); assert.equal(task.latest_version, 1); assert.equal(f.pages.length, 1);
  assert.equal(await readFile(join(f.config.dataDir, 'research', task.id, '1.md'), 'utf8'), report);
  assert.equal(await h.handle(creation), 'duplicate'); assert.equal(f.taskRows().length, 1);
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  f.plans.set('list', [call('list_research', { date: today, query: 'CUA' }), body => {
    const result = lastTool(body); assert.equal(result.total, 1); assert.equal(result.items[0].id, task.id);
    return answer('今天 1 项，CUA 部署已完成。');
  }]);
  assert.equal(await h.handle({ ...f.message('list', '今天研究了几项？', 'alice-private'), route: f.privateRoute }), 'sent');
  f.plans.set('group-list', [call('list_research', { date: today }), body => {
    assert.equal(lastTool(body).total, 1); assert.equal(lastTool(body).items[0].id, task.id);
    return answer('跨群也能查到你的这项研究。');
  }]);
  assert.equal(await h.handle({ ...f.message('group-list', '我的清单', 'alice-other-group'), route: f.secondGroup }), 'sent');
  f.plans.set('other-list', [call('list_research', { date: today }), body => {
    assert.equal(lastTool(body).total, 0); return answer('你今天还没有研究任务。');
  }]);
  assert.equal(await h.handle(f.message('other-list', '我的研究清单有哪些？', 'bob')), 'sent');
  f.plans.set('unbound', [call('list_research', {}), body => {
    assert.equal(lastTool(body).total, 0); return answer('当前身份没有研究任务。');
  }]);
  // The same external string in another room does not establish an identity binding.
  assert.equal(await h.handle({ ...f.message('unbound', '我是 alice，查清单'), route: f.privateRoute }), 'sent');
  f.plans.set('denied', [call('read_research', { id: task.id }), body => {
    assert.match(JSON.stringify(body.messages.at(-1)), /没有属于你的该研究任务/);
    return call('send_research_report', { id: task.id });
  }, body => {
    assert.match(JSON.stringify(body.messages.at(-1)), /没有属于你的该研究任务/);
    return call('continue_research', { id: task.id, key: 'denied' });
  }, body => {
    assert.match(JSON.stringify(body.messages.at(-1)), /没有属于你的该研究任务/);
    return answer('无法读取或操作他人的研究。');
  }]);
  assert.equal(await h.handle(f.message('denied', `读取并发送 ${task.id}，继续研究`, 'bob')), 'sent');
  assert.equal(f.qqRequests.filter(request => request.url.endsWith('/files')).length, 0);
  assert.equal(f.taskRows()[0].attempt, 1);
  f.plans.set('read', [call('read_research', { id: task.id, limit: 120 }), body => {
    const result = lastTool(body); assert.equal(result.text, [...report].slice(0, 120).join(''));
    assert.equal(result.nextOffset, 120); return answer('报告说明了部署条件和适用限制。');
  }]);
  assert.equal(await h.handle({ ...f.message('read', `解释 ${task.id} 的部署结论`, 'alice-private'), route: f.privateRoute }), 'sent');
  f.plans.set('send', [call('send_research_report', { id: task.id }), body => {
    assert.equal(lastTool(body).status, 'sent'); return answer('报告文件已发送。');
  }]);
  assert.equal(await h.handle({ ...f.message('send', `把 ${task.id} 发给我`, 'alice-private'), route: f.privateRoute }), 'sent');
  const uploads = f.qqRequests.filter(request => request.url.endsWith('/files'));
  assert.equal(uploads.length, 1); assert.equal(uploads[0].body.file_type, 4); assert.equal(uploads[0].body.srv_send_msg, false);
  assert.equal(uploads[0].body.file_name, `${task.id}-v1.txt`);
  assert.match(uploads[0].url, /\/users\/alice-dm\/files$/);
  assert.equal(Buffer.from(uploads[0].body.file_data, 'base64').toString('utf8'), report);
  const delivery = f.qqRequests.find(request => request.body?.msg_type === 7);
  assert.deepEqual(delivery.body.media, { file_info: 'fixture-file-info' }); assert.equal(delivery.body.msg_id, 'send');
  assert.match(delivery.url, /\/users\/alice-dm\/messages$/);
  const receiptRoom = f.inspect(db => db.prepare(`SELECT m.conversation_id,s.conversation_id AS requested_in
    FROM research_deliveries d JOIN messages m ON m.id=d.message_id JOIN messages s ON s.id=d.source_message_id
    WHERE d.kind='file' AND d.status='sent'`).get());
  assert.equal(receiptRoom.conversation_id, receiptRoom.requested_in);
  assert.notEqual(receiptRoom.conversation_id, task.conversation_id);
  const messages = f.inspect(db => db.prepare('SELECT text FROM messages').all());
  assert.doesNotMatch(JSON.stringify(messages), /END_OF_REPORT_MARKER|PAGE_EVIDENCE/);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM memory_topics').get().n), 0);
  assert.equal(f.requests.filter(request => request.worker).length, 2);
});

test('研究故障端到端：原文失败仅尝试两次、显式续作保留证据，未知发送和崩溃运行不自动重放', async t => {
  const f = await fixture(t), h = await f.harness(); f.pageFails(true);
  f.plans.set('create-blocked', [call('create_research', { key: 'original', title: '指定原文', goal: '总结指定原文', urls: [sourceUrl], requiresOriginal: true }),
    answer('已加入研究清单。')]);
  f.workerPlans.set('指定原文', [call('web_fetch', { url: sourceUrl }), answer(reportOutput('blocked'))]);
  assert.equal(await h.handle(f.message('create-blocked', '把这个链接加入研究清单，严格总结指定原文。')), 'sent'); await h.waitForResearch();
  let task = f.taskRows()[0]; assert.equal(task.status, 'blocked'); assert.equal(task.latest_version, null); assert.equal(f.pages.length, 2);
  const saved = f.inspect(db => db.prepare('SELECT evidence_json FROM research_evidence WHERE task_id=? ORDER BY attempt,ordinal').all(task.id));
  assert.ok(saved.some(row => /network/.test(row.evidence_json)));
  const orphan = join(f.config.dataDir, 'research', task.id, '1.md');
  await mkdir(join(f.config.dataDir, 'research', task.id), { recursive: true });
  await writeFile(orphan, '事务提交前已写入的旧草稿，必须保留。');
  f.pageFails(false);
  f.plans.set('continue', [call('continue_research', { id: task.id, key: 'retry-original' }), answer('已安排继续研究。')]);
  f.workerPlans.set('指定原文', [body => {
    assert.match(userText(body), /network/);
    return call('web_fetch', { url: sourceUrl });
  }, answer(reportOutput())]);
  assert.equal(await h.handle({ ...f.message('continue', `网络恢复了，请继续 ${task.id}`, 'alice-private'), route: f.privateRoute }), 'sent'); await h.waitForResearch();
  task = f.taskRows()[0]; assert.equal(task.status, 'completed', task.reason);
  assert.equal(task.attempt, 2); assert.equal(f.pages.length, 3);
  assert.equal(task.latest_version, 2);
  assert.equal(await readFile(orphan, 'utf8'), '事务提交前已写入的旧草稿，必须保留。');
  assert.equal(await readFile(join(f.config.dataDir, 'research', task.id, '2.md'), 'utf8'), report);
  const after = f.inspect(db => db.prepare('SELECT evidence_json FROM research_evidence WHERE task_id=? AND attempt=1 ORDER BY ordinal').all(task.id));
  assert.deepEqual(after, saved);
  f.fileUnknown(true);
  f.plans.set('unknown', [call('send_research_report', { id: task.id }), body => {
    assert.equal(lastTool(body).status, 'uncertain'); return call('send_research_report', { id: task.id, format: 'md' });
  }, body => { assert.equal(lastTool(body).repeated, true); assert.equal(lastTool(body).status, 'uncertain'); return answer('平台投递结果未知，需要确认是否收到。'); }]);
  const uncertainRequest = f.message('unknown', `把 ${task.id} 发给我`);
  assert.equal(await h.handle(uncertainRequest), 'sent');
  assert.equal(f.qqRequests.filter(request => request.url.endsWith('/files')).length, 1);
  assert.equal(f.qqRequests.filter(request => request.body?.msg_type === 7).length, 1);
  assert.equal(f.inspect(db => db.prepare("SELECT status FROM research_deliveries WHERE kind='file'").get().status), 'uncertain');
  await h.close();
  const store = new ConversationStore(join(f.config.dataDir, 'pa.sqlite'));
  let interrupted;
  try {
    interrupted = store.research.create(task.conversation_id, task.source_message_id, { key: 'crash-fixture', title: '崩溃现场', goal: '保留运行记录，不自动重发' });
    store.research.claim(interrupted.id, f.config.research);
    store.research.checkpoint(interrupted.id, 1, { modelCalls: 1, toolCalls: 0, searchCalls: 0,
      evidence: { tool: 'confirmed_material', input: {}, result: '已保存的资料' } });
  } finally { store.close(); }
  const requestCount = f.requests.length, fileCount = f.qqRequests.filter(request => request.body?.msg_type === 7).length;
  const reopened = await f.harness(); await reopened.waitForResearch();
  assert.equal(f.taskRows().find(row => row.id === interrupted.id).status, 'interrupted');
  assert.equal(await reopened.handle(uncertainRequest), 'duplicate');
  assert.equal(f.requests.length, requestCount);
  assert.equal(f.qqRequests.filter(request => request.body?.msg_type === 7).length, fileCount);
  assert.match(f.inspect(db => db.prepare('SELECT evidence_json FROM research_evidence WHERE task_id=?').get(interrupted.id).evidence_json), /已保存的资料/);
});

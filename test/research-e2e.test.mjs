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
import { ResearchService } from '../dist/research-service.js';
import { currentMessage, isPreparationRequest, preparationDelta } from './fixtures/turn-preparation.mjs';

const sourceUrl = 'https://example.com/research-source';
const report = '# CUA 部署研究\n\n## 结论\n报告应保留完整内容，仅在需要时读取。\n\n'
  + '经过核验的正文。'.repeat(40) + '\n\n## 来源\n' + sourceUrl + '\n\nEND_OF_REPORT_MARKER';
const sectionOutput = (status = 'written', body = report, extra = {}) => '<research_section>' + JSON.stringify({ status,
  summary: 'CUA 部署资料与限制', sources: status === 'blocked' ? [] : [sourceUrl], gaps: status === 'blocked' ? ['指定原文网络不可用'] : [], ...extra })
  + '</research_section>\n' + body;
const planOutput = (titles = ['研究结论']) => JSON.stringify({ sections: titles.map(title => ({ title,
  objective: `核验${title}并回答用户问题`, acceptance: '依据实际来源解释结论与限制' })) });
const reviewOutput = (verdict = 'pass', reason = '本章节已达到目标和验收要求。') => JSON.stringify({ verdict, reason });
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
  const requests = [], pages = [], qqRequests = [], plans = new Map(), workerPlans = new Map(), phasePlans = new Map(), errors = [], harnesses = [];
  let pageFails = false, fileUnknown = false, pageText = 'CUA 官方资料，真实读取标识 PAGE_EVIDENCE';
  const server = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text), message = currentMessage(body);
      const worker = message ? undefined : JSON.parse(userText(body));
      requests.push({ body, message, worker });
      let step;
      if (isPreparationRequest(body)) step = { delta: preparationDelta(`prepare-${requests.length}`) };
      else {
        const plan = message ? plans.get(message.eventId) : phasePlans.get(`${worker.task.title}:${worker.phase}`)
          ?? (worker.phase === 'write' ? workerPlans.get(worker.task.title) : undefined);
        if (!message) {
          assert.deepEqual(body.thinking, { type: 'enabled' }); assert.equal(body.reasoning_effort, 'high');
          assert.equal(body.max_tokens, undefined); assert.equal(body.max_completion_tokens, undefined);
          assert.ok(['none', 'auto'].includes(body.tool_choice));
          if (worker.phase === 'plan' || worker.phase === 'write') {
            assert.equal(body.tool_choice, 'none'); assert.deepEqual(body.tools ?? [], []);
            assert.ok(body.messages.every(message => message.role !== 'tool' && !message.tool_calls));
          } else if (worker.phase === 'collect') {
            assert.equal(worker.section, undefined);
          } else if (worker.phase === 'review') {
            assert.ok((body.tools ?? []).every(tool => tool.function.name === 'read_research_material'));
          }
        }
        if (!plan && worker?.phase === 'plan') step = answer(planOutput());
        else if (!plan && worker?.phase === 'collect') step = answer('沿用已有材料，未补充新来源。');
        else if (!plan && worker?.phase === 'review') step = answer(reviewOutput());
        else {
          assert.ok(plan?.length, `没有为本次请求设置步骤：${message?.eventId ?? `${worker.task.title}:${worker.phase}`}`);
          const next = plan.shift(); step = typeof next === 'function' ? next(body) : next;
        }
      }
      if (step.httpError) { response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'fixture unknown provider error' } })); return; }
      const delta = step.delta ?? (step.tool ? { role: 'assistant', tool_calls: [{ index: 0,
        id: `call-${requests.length}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }
        : { role: 'assistant', content: step.answer });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [value, finish] of [[delta, null], [{}, step.delta || step.tool ? 'tool_calls' : step.stopReason ?? 'stop']]) {
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
      const body = url ? pageText
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
  return { config, route, privateRoute, secondGroup, requests, pages, qqRequests, plans, workerPlans, phasePlans, inspect, harness, message, taskRows, errors,
    pageFails(value) { pageFails = value; }, pageText(value) { pageText = value; }, fileUnknown(value) { fileUnknown = value; } };
}

test('定点真实测试入口只领取指定批次，不运行其他队列、不通知QQ、不重试网页失败', async t => {
  const f = await fixture(t); f.pageFails(true);
  const store = new ConversationStore(join(f.config.dataDir, 'pa.sqlite'));
  const conversation = store.ensureConversation('trial', '/fixture/trial.jsonl', f.route);
  store.recordInbound(conversation.id, '研究资料', { eventId: 'trial', senderId: 'alice', sentAt: new Date().toISOString(), modelInputText: '研究资料' });
  const source = store.externalMessage(conversation.id, 'trial');
  const target = store.research.create(conversation.id, source.id, { key: 'target', title: '仅此任务', goal: '读取原文', urls: [sourceUrl], requiresOriginal: true });
  const other = store.research.create(conversation.id, source.id, { key: 'other', title: '其他队列', goal: '不能运行' });
  const old = JSON.stringify(store.research.get(other.id));
  assert.equal(store.research.claim(target.id, f.config.research, 2), undefined);
  assert.equal(store.research.get(target.id).status, 'queued');
  f.phasePlans.set('仅此任务:collect', [call('web_fetch', { url: sourceUrl }), answer('指定原文读取失败。')]);
  f.workerPlans.set('仅此任务', [answer(sectionOutput('blocked', ''))]);
  let sends = 0;
  const service = new ResearchService(f.config, [f.route], async () => { sends++; return { status: 'rejected' }; }, () => {});
  try {
    const task = await service.runOnce(target.id, 1);
    assert.equal(task.status, 'blocked'); assert.equal(f.pages.length, 1); assert.equal(sends, 0);
    assert.equal(JSON.stringify(store.research.get(other.id)), old);
    assert.ok(f.requests.every(request => request.worker.task.title === '仅此任务'));
    assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM research_deliveries').get().n), 0);
    await assert.rejects(() => service.runOnce(target.id, 1), /独立/);
  } finally { await service.close(); }
  const next = new ResearchService(f.config, [f.route], async () => ({ status: 'rejected' }), () => {});
  const count = f.requests.length;
  try { await assert.rejects(() => next.runOnce(target.id, 1), /不匹配/); }
  finally { await next.close(); store.close(); }
  assert.equal(f.requests.length, count);
});

test('研究端到端：模型建任务、跨群私聊本人清单与领取、他人隔离及历史边界', async t => {
  const f = await fixture(t), h = await f.harness();
  f.plans.set('normal', [answer('CUA 是计算机操作代理。')]);
  assert.equal(await h.handle(f.message('normal', 'CUA 是什么？')), 'sent');
  assert.equal(f.taskRows().length, 0);
  f.plans.set('create', [call('create_research', { key: 'cua', title: 'CUA 部署', goal: '研究部署条件', urls: [sourceUrl], requiresOriginal: true }),
    body => { assert.equal(lastTool(body).saved, true); return answer('已加入研究清单。'); }]);
  f.phasePlans.set('CUA 部署:collect', [call('web_fetch', { url: sourceUrl }), answer('资料采集结束。')]);
  f.workerPlans.set('CUA 部署', [body => {
    assert.match(JSON.stringify(body.messages), /PAGE_EVIDENCE/); return answer(sectionOutput());
  }]);
  const creation = f.message('create', '把 CUA 放进研究清单，研究部署条件并生成报告。');
  assert.equal(await h.handle(creation), 'sent'); await h.waitForResearch();
  const task = f.taskRows()[0];
  assert.equal(task.status, 'completed'); assert.equal(task.latest_version, 1); assert.equal(f.pages.length, 1);
  const assembled = await readFile(join(f.config.dataDir, 'research', task.id, '1.md'), 'utf8');
  assert.ok(assembled.includes(report)); assert.match(assembled, /CUA 部署/); assert.ok(assembled.includes(sourceUrl));
  assert.deepEqual(f.requests.filter(request => request.worker).map(request => request.worker.phase), ['plan', 'collect', 'collect', 'write', 'review']);
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
    const result = lastTool(body); assert.equal(result.text, [...assembled].slice(0, 120).join(''));
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
  assert.equal(Buffer.from(uploads[0].body.file_data, 'base64').toString('utf8'), assembled);
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
  assert.equal(f.requests.filter(request => request.worker).length, 5);
});

test('研究故障端到端：原文失败仅尝试两次、显式续作保留证据，未知发送和崩溃运行不自动重放', async t => {
  const f = await fixture(t), h = await f.harness(); f.pageFails(true);
  f.plans.set('create-blocked', [call('create_research', { key: 'original', title: '指定原文', goal: '总结指定原文', urls: [sourceUrl], requiresOriginal: true }),
    answer('已加入研究清单。')]);
  f.phasePlans.set('指定原文:collect', [call('web_fetch', { url: sourceUrl }), answer('指定原文读取失败。')]);
  f.workerPlans.set('指定原文', [answer(sectionOutput('blocked'))]);
  assert.equal(await h.handle(f.message('create-blocked', `把这个链接加入研究清单，严格总结指定原文。 ${sourceUrl}`)), 'sent'); await h.waitForResearch();
  let task = f.taskRows()[0]; assert.equal(task.status, 'blocked'); assert.equal(task.latest_version, null); assert.equal(f.pages.length, 2);
  const saved = f.inspect(db => db.prepare('SELECT evidence_json FROM research_evidence WHERE task_id=? ORDER BY attempt,ordinal').all(task.id));
  assert.ok(saved.some(row => /network/.test(row.evidence_json)));
  const orphan = join(f.config.dataDir, 'research', task.id, '1.md');
  await mkdir(join(f.config.dataDir, 'research', task.id), { recursive: true });
  await writeFile(orphan, '事务提交前已写入的旧草稿，必须保留。');
  f.pageFails(false);
  f.plans.set('continue', [call('continue_research', { id: task.id, key: 'retry-original' }), answer('已安排继续研究。')]);
  f.phasePlans.set('指定原文:collect', [body => {
    assert.match(userText(body), /network/);
    return call('web_fetch', { url: sourceUrl });
  }, answer('原文读取成功。')]);
  f.workerPlans.set('指定原文', [answer(sectionOutput())]);
  assert.equal(await h.handle({ ...f.message('continue', `网络恢复了，请继续 ${task.id}`, 'alice-private'), route: f.privateRoute }), 'sent'); await h.waitForResearch();
  task = f.taskRows()[0]; assert.equal(task.status, 'completed', task.reason);
  assert.equal(task.attempt, 2); assert.equal(f.pages.length, 3);
  assert.equal(task.latest_version, 2);
  assert.equal(await readFile(orphan, 'utf8'), '事务提交前已写入的旧草稿，必须保留。');
  assert.ok((await readFile(join(f.config.dataDir, 'research', task.id, '2.md'), 'utf8')).includes(report));
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
    interrupted = store.research.create(task.conversation_id, task.source_message_id, { key: 'crash-fixture', title: '崩溃现场', goal: '保留运行记录，不自动重发', urls: [sourceUrl] });
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

test('章节报告不继承聊天输出上限，程序组装长正文；伪调用保留失败草稿且不重试', async t => {
  const f = await fixture(t); f.config.research.maxModelCalls = 4;
  const h = await f.harness();
  const longBody = report + '\n完整技术细节。'.repeat(2200) + '\n协议示例（不是执行命令）：<｜｜DSML｜｜ calls>\nLONG_REPORT_END';
  for (const [key, body] of [['long', longBody],
    ['pseudo', '我会继续读取源码。\n<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="web_fetch">']]) {
    f.plans.set(key, [call('create_research', { key, title: key, goal: '研究指定资料', urls: [sourceUrl] }), answer('已加入研究清单。')]);
    f.phasePlans.set(`${key}:collect`, [call('web_fetch', { url: sourceUrl })]);
    f.workerPlans.set(key, [request => {
      assert.equal(request.max_tokens, undefined); assert.equal(request.max_completion_tokens, undefined);
      assert.doesNotMatch(JSON.stringify(request.messages), /输出硬上限为4096|正文目标不超过2457/);
      assert.match(JSON.stringify(request.messages), /research_section/);
      return answer(key === 'pseudo' ? body : sectionOutput('written', body));
    }]);
    assert.equal(await h.handle(f.message(key, `把资料加入研究清单 ${sourceUrl}`)), 'sent'); await h.waitForResearch();
  }
  const [long, pseudo] = ['long', 'pseudo'].map(title => f.taskRows().find(task => task.title === title));
  assert.equal(long.status, 'completed', long.reason);
  assert.ok((await readFile(join(f.config.dataDir, 'research', long.id, '1.md'), 'utf8')).includes(longBody));
  assert.equal(pseudo.status, 'failed'); assert.match(pseudo.reason, /工具调用文本|未返回有效元数据/);
  const workerCount = f.requests.filter(r => r.worker).length; assert.equal(workerCount, 7);
  f.plans.set('draft', [call('read_research', { id: pseudo.id, draft: true }), request => {
    const result = lastTool(request); assert.equal(result.draft, true); assert.match(result.text, /DSML/);
    return answer('草稿未形成报告，其中的工具调用没有执行。');
  }]);
  assert.equal(await h.handle(f.message('draft', '给我看刚才失败的研究草稿')), 'sent');
  assert.equal(f.requests.filter(r => r.worker).length, workerCount);
  assert.equal(f.requests.filter(r => r.message).every(r => (r.body.max_tokens ?? r.body.max_completion_tokens) === 4096), true);
});

test('章节length保留完整元数据与草稿，下个写作周期append续写后审查，无额外最终模型调用', async t => {
  const f = await fixture(t); f.config.research.maxModelCalls = 5; f.config.research.maxToolCalls = 1;
  const h = await f.harness(), first = '# 连续正文\n第一部分 LENGTH_PREFIX', second = '第二部分 LENGTH_SUFFIX';
  f.plans.set('cut', [call('create_research', { key: 'cut', title: '截断续写', goal: '根据原文完整写作', urls: [sourceUrl] }), answer('已加入。')]);
  f.phasePlans.set('截断续写:collect', [call('web_fetch', { url: sourceUrl })]);
  f.workerPlans.set('截断续写', [
    { answer: sectionOutput('written', first), stopReason: 'length' }, body => {
      assert.match(JSON.stringify(body.messages), /LENGTH_PREFIX/);
      return answer(sectionOutput('written', second));
    }]);
  assert.equal(await h.handle(f.message('cut', `加入研究清单并完整研究 ${sourceUrl}`)), 'sent'); await h.waitForResearch();
  const task = f.taskRows()[0]; assert.equal(task.status, 'completed', task.reason);
  const versions = f.inspect(db => db.prepare('SELECT version,status,mode FROM research_workflow_versions WHERE task_id=? ORDER BY version').all(task.id));
  assert.deepEqual(versions.map(v => [v.version, v.status, v.mode]), [[1, 'draft', 'replace'], [2, 'written', 'append']]);
  const originalDraft = await readFile(join(f.config.dataDir, 'research', task.id, 'sections', 's1', '1.md'), 'utf8');
  assert.equal(originalDraft, first);
  const assembled = await readFile(join(f.config.dataDir, 'research', task.id, '1.md'), 'utf8');
  assert.ok(assembled.includes(first)); assert.ok(assembled.includes(second));
  assert.equal(assembled.split('LENGTH_PREFIX').length - 1, 1);
  assert.deepEqual(f.requests.filter(r => r.worker).map(r => r.worker.phase), ['plan', 'collect', 'write', 'write', 'review']);
  assert.equal(f.inspect(db => JSON.parse(db.prepare('SELECT usage_json FROM research_attempts WHERE task_id=?').get(task.id).usage_json).modelCalls), 5);
});

test('长原文在独立collect续读超过三页，共享游标只抓取一次并形成完整coverage', async t => {
  const f = await fixture(t); f.config.fetch.maxTextChars = 128;
  const page = 'PAGE_EVIDENCE ' + '0123456789'.repeat(60) + 'SOURCE_END'; f.pageText(page);
  const h = await f.harness(); let nextCursor;
  const nextPage = body => {
    const last = lastTool(body); assert.equal(last.hasMore, true); assert.ok(last.nextCursor);
    nextCursor = last.nextCursor; return call('web_fetch', { url: sourceUrl, cursor: nextCursor });
  };
  f.plans.set('long-source', [call('create_research', { key: 'long-source', title: '跨周期长原文', goal: '完整读取并核验长原文',
    urls: [sourceUrl], requiresOriginal: true }), answer('已加入。')]);
  f.phasePlans.set('跨周期长原文:collect', [call('web_fetch', { url: sourceUrl }), nextPage, nextPage, nextPage, nextPage, body => {
    const last = lastTool(body); assert.equal(last.hasMore, false); assert.equal(last.nextCursor, null);
    assert.ok(last.text.endsWith('SOURCE_END'));
    return answer('五页原文全部覆盖。');
  }]);
  f.workerPlans.set('跨周期长原文', [body => {
    assert.match(userText(body), /SOURCE_END/); assert.ok(!body.messages.some(message => message.role === 'tool'));
    return answer(sectionOutput('written', '五页原文全部覆盖后独立写作。'));
  }]);
  assert.equal(await h.handle(f.message('long-source', `加入研究清单并完整读取原文 ${sourceUrl}`)), 'sent'); await h.waitForResearch();
  const task = f.taskRows()[0]; assert.equal(task.status, 'completed', task.reason);
  assert.deepEqual(f.pages, [sourceUrl]);
  const fetched = f.inspect(db => db.prepare("SELECT evidence_json FROM research_evidence WHERE task_id=? AND json_extract(evidence_json,'$.tool')='web_fetch'")
    .all(task.id)).map(row => JSON.parse(row.evidence_json)).filter(e => e.result?.coverage);
  assert.equal(fetched.length, 5);
  let covered = 0;
  for (const item of fetched) {
    assert.equal(item.result.coverage.offset, covered); covered = item.result.coverage.end;
    assert.equal(item.result.coverage.contentHash, fetched[0].result.coverage.contentHash);
    assert.equal(item.result.coverage.totalChars, page.length);
  }
  assert.equal(covered, page.length);
  const cycles = f.inspect(db => db.prepare('SELECT phase,status FROM research_workflow_cycles WHERE task_id=? ORDER BY cycle').all(task.id));
  assert.deepEqual(cycles.map(c => [c.phase, c.status]), [['plan', 'succeeded'], ['write', 'succeeded'], ['review', 'succeeded']]);
  assert.deepEqual(f.inspect(db => db.prepare('SELECT status FROM research_collection_cycles WHERE task_id=?').all(task.id)).map(c => c.status), ['succeeded']);
  assert.equal(f.requests.filter(r => r.worker).length, 9);
});

test('审查按章节来源取得完整旧材料，60KB首屏以外正文通过只读材料分页后才通过', async t => {
  const f = await fixture(t); f.config.contextWindow = 262144; f.config.research.maxModelCalls = 20;
  const page = 'OLD_SOURCE_START ' + 'a'.repeat(63950) + 'UNSEEN_SOURCE_TAIL'; f.pageText(page);
  const h = await f.harness(); let cursor, missingPages = 0;
  const collect = body => {
    const toolCount = body.messages.filter(message => message.role === 'tool').length;
    if (toolCount) {
      const latest = lastTool(body); cursor = latest.nextCursor;
      if (!latest.hasMore) return answer('已完整读取长材料。');
      assert.ok(cursor);
    }
    return call('web_fetch', { url: sourceUrl, ...(cursor ? { cursor } : {}) });
  };
  f.plans.set('review-tail', [call('create_research', { key: 'review-tail', title: '长材料审查', goal: '完整读取长材料并审查结论',
    urls: [sourceUrl], requiresOriginal: true }), answer('已加入。')]);
  f.phasePlans.set('长材料审查:collect', Array(8).fill(collect));
  f.workerPlans.set('长材料审查', [body => {
    assert.match(userText(body), /UNSEEN_SOURCE_TAIL/);
    return answer(sectionOutput('written', '已完整读取长材料并写出结论。'));
  }]);
  f.phasePlans.set('长材料审查:review', [body => {
    const input = JSON.parse(userText(body)); assert.ok(input.reviewMaterial.length >= 8);
    assert.ok(input.reviewMaterial.some(item => item.text.includes('OLD_SOURCE_START')));
    assert.equal(JSON.stringify(input.reviewMaterial).includes('UNSEEN_SOURCE_TAIL'), false);
    const calls = input.reviewMaterial.filter(item => item.hasMore).flatMap(item => {
      const result = [];
      for (let offset = item.nextOffset; offset < item.totalChars; offset += 2800) result.push({ index: result.length,
        id: `read-${item.id}-${offset}`, type: 'function', function: { name: 'read_research_material',
          arguments: JSON.stringify({ id: item.id, offset }) } });
      return result;
    }).map((tool, index) => ({ ...tool, index }));
    missingPages = calls.length; assert.ok(missingPages > 0);
    assert.deepEqual(body.tools.map(tool => tool.function.name), ['read_research_material']);
    return { delta: { role: 'assistant', tool_calls: calls } };
  }, body => {
    const readResults = body.messages.filter(message => message.role === 'tool');
    assert.equal(readResults.length, missingPages);
    assert.ok(JSON.stringify(readResults).includes('UNSEEN_SOURCE_TAIL'));
    return answer(reviewOutput('pass', '已逐页取得所引用原材料全文，结论与来源一致。'));
  }]);
  assert.equal(await h.handle(f.message('review-tail', `加入研究清单并全文核验 ${sourceUrl}`)), 'sent'); await h.waitForResearch();
  const task = f.taskRows()[0]; assert.equal(task.status, 'completed', task.reason); assert.deepEqual(f.pages, [sourceUrl]);
  const workerRequests = f.requests.filter(r => r.worker);
  const collectionRequests = workerRequests.filter(r => r.worker.phase === 'collect');
  assert.equal(collectionRequests.length, 8);
  assert.ok(collectionRequests.every(r => r.body.tool_choice === 'auto'));
  const lastCollection = workerRequests.lastIndexOf(collectionRequests.at(-1));
  assert.equal(workerRequests[lastCollection + 1].worker.phase, 'write');
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM research_collection_cycles WHERE task_id=?').get(task.id).n), 1);
  assert.equal(f.requests.filter(r => r.worker?.phase === 'review').length, 2);
  const readEvidence = f.inspect(db => db.prepare("SELECT evidence_json FROM research_evidence WHERE task_id=? AND json_extract(evidence_json,'$.tool')='read_research_material'")
    .all(task.id)).map(row => JSON.parse(row.evidence_json)).filter(item => item.result);
  assert.equal(readEvidence.length, missingPages);
  assert.ok(readEvidence.some(item => item.result.text.includes('UNSEEN_SOURCE_TAIL')));
});

test('预算跨计划与多个章节周期累计，耗尽归档partial；显式继续复用计划和approved章节', async t => {
  const f = await fixture(t); f.config.research.maxModelCalls = 4;
  const h = await f.harness();
  f.plans.set('budget', [call('create_research', { key: 'budget', title: '分章预算', goal: '分章研究部署与限制', urls: [sourceUrl] }), answer('已加入。')]);
  f.phasePlans.set('分章预算:plan', [answer(planOutput(['部署条件', '适用限制']))]);
  f.phasePlans.set('分章预算:collect', [call('web_fetch', { url: sourceUrl })]);
  f.workerPlans.set('分章预算', [answer(sectionOutput('written', 'APPROVED_CHAPTER_ONE'))]);
  assert.equal(await h.handle(f.message('budget', `把部署条件和适用限制加入研究清单 ${sourceUrl}`)), 'sent'); await h.waitForResearch();
  let task = f.taskRows()[0]; assert.equal(task.status, 'partial', task.reason); assert.equal(task.latest_version, 1);
  const firstReport = await readFile(join(f.config.dataDir, 'research', task.id, '1.md'), 'utf8');
  assert.match(firstReport, /APPROVED_CHAPTER_ONE/);
  const firstCycles = f.inspect(db => db.prepare('SELECT phase,section_id FROM research_workflow_cycles WHERE task_id=? ORDER BY cycle').all(task.id));
  assert.deepEqual(firstCycles.map(c => [c.phase, c.section_id]), [['plan', null], ['write', 's1'], ['review', 's1']]);
  const firstUsage = f.inspect(db => JSON.parse(db.prepare('SELECT usage_json FROM research_attempts WHERE task_id=? AND attempt=1').get(task.id).usage_json));
  assert.deepEqual(firstUsage, { modelCalls: 4, toolCalls: 1, searchCalls: 0 });
  const checkpointCount = f.requests.filter(r => r.worker).length;
  f.plans.set('resume-budget', [call('continue_research', { id: task.id, key: 'resume' }), answer('已安排继续。')]);
  f.phasePlans.set('分章预算:collect', [answer('显式续作重新核对已有材料，无需新工具。')]);
  f.workerPlans.set('分章预算', [body => {
    const input = JSON.parse(userText(body)); assert.equal(input.phase, 'write'); assert.equal(input.section.id, 's2');
    assert.match(JSON.stringify(input.previousMaterial), /PAGE_EVIDENCE/);
    assert.match(JSON.stringify(input.progress), /部署条件/);
    return answer(sectionOutput('written', 'SECOND_CHAPTER_AFTER_EXPLICIT_RESUME'));
  }]);
  assert.equal(await h.handle(f.message('resume-budget', `请继续研究 ${task.id}`)), 'sent'); await h.waitForResearch();
  task = f.taskRows()[0]; assert.equal(task.status, 'completed', task.reason); assert.equal(task.attempt, 2); assert.equal(task.latest_version, 2);
  const resumed = f.requests.filter(r => r.worker).slice(checkpointCount);
  assert.deepEqual(resumed.map(r => [r.worker.phase, r.worker.section?.id]), [['collect', undefined], ['write', 's2'], ['review', 's2']]);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM research_collection_cycles WHERE task_id=?').get(task.id).n), 2);
  assert.equal(await readFile(join(f.config.dataDir, 'research', task.id, '1.md'), 'utf8'), firstReport);
  const completed = await readFile(join(f.config.dataDir, 'research', task.id, '2.md'), 'utf8');
  assert.match(completed, /APPROVED_CHAPTER_ONE/); assert.match(completed, /SECOND_CHAPTER_AFTER_EXPLICIT_RESUME/);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM research_workflow_plans WHERE task_id=?').get(task.id).n), 1);
});

test('审查revise开启replace修订周期，旧章节和审查记录保持可核验', async t => {
  const f = await fixture(t); f.config.research.maxModelCalls = 7;
  const h = await f.harness();
  f.plans.set('revise', [call('create_research', { key: 'revise', title: '修订检查点', goal: '核验并修订部署结论', urls: [sourceUrl] }), answer('已加入。')]);
  f.phasePlans.set('修订检查点:collect', [call('web_fetch', { url: sourceUrl }), answer('采集结束。')]);
  f.workerPlans.set('修订检查点', [answer(sectionOutput('written', 'OLD_CHAPTER_BEFORE_REVIEW')),
    body => { assert.match(JSON.stringify(body.messages), /缺少关键限制/); return answer(sectionOutput('written', 'REPLACEMENT_VERIFIED_CHAPTER')); }]);
  f.phasePlans.set('修订检查点:review', [answer(reviewOutput('revise', '缺少关键限制，请修订全文。')), answer(reviewOutput())]);
  assert.equal(await h.handle(f.message('revise', `把部署问题加入研究清单 ${sourceUrl}`)), 'sent'); await h.waitForResearch();
  const task = f.taskRows()[0]; assert.equal(task.status, 'completed', task.reason);
  const versions = f.inspect(db => db.prepare('SELECT version,mode FROM research_workflow_versions WHERE task_id=? ORDER BY version').all(task.id));
  assert.deepEqual(versions.map(v => [v.version, v.mode]), [[1, 'replace'], [2, 'replace']]);
  assert.equal(await readFile(join(f.config.dataDir, 'research', task.id, 'sections', 's1', '1.md'), 'utf8'), 'OLD_CHAPTER_BEFORE_REVIEW');
  assert.equal(await readFile(join(f.config.dataDir, 'research', task.id, 'sections', 's1', '2.md'), 'utf8'), 'REPLACEMENT_VERIFIED_CHAPTER');
  const assembled = await readFile(join(f.config.dataDir, 'research', task.id, '1.md'), 'utf8');
  assert.doesNotMatch(assembled, /OLD_CHAPTER_BEFORE_REVIEW/); assert.match(assembled, /REPLACEMENT_VERIFIED_CHAPTER/);
  assert.deepEqual(f.inspect(db => db.prepare('SELECT verdict,version FROM research_workflow_reviews WHERE task_id=? ORDER BY cycle').all(task.id)).map(r => [r.verdict, r.version]),
    [['revise', 1], ['pass', 2]]);
  assert.deepEqual(f.requests.filter(r => r.worker).map(r => r.worker.phase), ['plan', 'collect', 'collect', 'write', 'review', 'write', 'review']);
});

test('计划格式错误与未知provider错误保留失败周期，不自动重试或转为完成', async t => {
  const f = await fixture(t), h = await f.harness();
  f.phasePlans.set('计划格式错误:plan', [answer('{"sections":')]);
  f.phasePlans.set('未知请求:collect', [{ httpError: true }]);
  for (const [key, title, expectedCalls] of [['bad-plan', '计划格式错误', 1], ['unknown', '未知请求', 2]]) {
    f.plans.set(key, [call('create_research', { key, title, goal: '研究原文资料', urls: [sourceUrl] }), answer('已加入。')]);
    const before = f.requests.filter(r => r.worker).length;
    assert.equal(await h.handle(f.message(key, `加入研究清单 ${sourceUrl}`)), 'sent'); await h.waitForResearch();
    const task = f.taskRows().find(task => task.title === title); assert.equal(task.status, 'failed', task.reason);
    assert.equal(task.attempt, 1); assert.equal(task.latest_version, null);
    assert.equal(f.requests.filter(r => r.worker).length - before, expectedCalls);
    if (title === '未知请求') assert.deepEqual(f.requests.filter(r => r.worker?.task.title === title).map(r => r.worker.phase), ['plan', 'collect']);
    const cycles = f.inspect(db => db.prepare('SELECT cycle,status FROM research_workflow_cycles WHERE task_id=? UNION ALL SELECT cycle,status FROM research_collection_cycles WHERE task_id=? ORDER BY cycle').all(task.id, task.id));
    assert.ok(cycles.length); assert.ok(['failed', 'unknown'].includes(cycles.at(-1).status));
    const count = f.requests.length; await h.waitForResearch(); assert.equal(f.requests.length, count);
  }
});

test('明确检查链接必须真实读取，不能只凭URL文字回答能看到', async t => {
  const f = await fixture(t), h = await f.harness();
  f.plans.set('verify', [request => {
    assert.deepEqual(request.tool_choice, { type: 'function', function: { name: 'web_fetch' } });
    return call('web_fetch', { url: sourceUrl });
  }, request => { assert.match(JSON.stringify(request.messages), /PAGE_EVIDENCE/); return answer('能看到网页正文。'); }]);
  assert.equal(await h.handle(f.message('verify', `${sourceUrl}\n能看到内容不？只回答能不能。`)), 'sent');
  assert.deepEqual(f.pages, [sourceUrl]);
  f.plans.set('canonical', [request => {
    assert.deepEqual(request.tool_choice, { type: 'function', function: { name: 'web_fetch' } });
    return call('web_fetch', { url: 'https://example.com' });
  }, request => { assert.equal(request.tool_choice, 'auto'); return answer('已读到网页正文。'); }]);
  assert.equal(await h.handle(f.message('canonical', 'https://example.com/#readme\n能看到内容吗？')), 'sent');
  assert.deepEqual(f.pages, [sourceUrl, 'https://example.com/']);
  f.plans.set('skip', [answer('能看到。')]);
  assert.equal(await h.handle(f.message('skip', `${sourceUrl}\n能看到内容吗？`)), 'failed');
  const texts = f.inspect(db => db.prepare("SELECT text FROM messages WHERE role='assistant'").all()).map(row => row.text);
  assert.equal(texts.includes('能看到。'), false);
});

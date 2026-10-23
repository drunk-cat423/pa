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
          assert.equal(worker.budget, undefined);
          assert.doesNotMatch(userText(body), /"suggestedSections"/);
          assert.deepEqual(body.thinking, { type: 'enabled' }); assert.equal(body.reasoning_effort, 'high');
          assert.equal(body.max_tokens, undefined); assert.equal(body.max_completion_tokens, undefined);
          assert.ok(['none', 'auto'].includes(body.tool_choice));
          if (worker.phase === 'plan' || worker.phase === 'write') {
            assert.equal(body.tool_choice, 'none'); assert.deepEqual(body.tools ?? [], []);
            assert.ok(body.messages.every(message => message.role !== 'tool' && !message.tool_calls));
            assert.equal(worker.materialIndex, undefined);
            assert.equal(worker.plan, undefined);
          } else if (worker.phase === 'collect') {
            assert.equal(worker.section, undefined);
            assert.equal(worker.writeMode, undefined);
            assert.equal(worker.collectionNote, undefined);
            const instructions = body.messages.filter(m=>['system','developer'].includes(m.role));
            assert.doesNotMatch(JSON.stringify(instructions), /写作元数据summary|150至220/);
          } else if (worker.phase === 'review') {
            assert.ok((body.tools ?? []).every(tool => tool.function.name === 'read_research_material'));
            for (const key of ['collectionNote','writeMode','previousMaterial','materialIndex','remainingGaps','plan']) assert.equal(worker[key], undefined);
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
    research: { enabled: true, maxModelCalls: 16, maxToolCalls: 24, maxSearchCalls: 6 },
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

test('最后一个采集工具失败且无笔记时，写作仅带必要失败说明并保留blocked', async t => {
  const f = await fixture(t); f.config.research.maxToolCalls=1;
  const h = await f.harness(); f.pageFails(true);
  f.plans.set('last-failure',[call('create_research',{key:'last-failure',title:'最后抓取失败',goal:'读取指定原文',urls:[sourceUrl],requiresOriginal:true})]);
  f.phasePlans.set('最后抓取失败:collect',[call('web_fetch',{url:sourceUrl})]);
  f.workerPlans.set('最后抓取失败',[body=>{
    const input=JSON.parse(userText(body));
    assert.equal(input.collectionNote,''); assert.equal(input.materialIndex,undefined);
    assert.equal(input.sourceFailures.length,1);
    assert.equal(input.sourceFailures[0].code,'network');
    assert.match(input.sourceFailures[0].request,/research-source/);
    assert.ok(input.sourceFailures[0].error);
    return answer(sectionOutput('blocked'));
  }]);
  assert.equal(await h.handle(f.message('last-failure',`研究指定原文 ${sourceUrl}`)),'sent');
  await h.waitForResearch();
  assert.equal(f.taskRows()[0].status,'blocked');
  assert.deepEqual(f.requests.filter(r=>r.worker).map(r=>r.worker.phase),['collect','write']);
});

test('章节报告不继承聊天输出上限，程序组装长正文；伪调用保留失败草稿且不重试', async t => {
  const f = await fixture(t); f.config.research.maxModelCalls = 4;
  const h = await f.harness();
  const longBody = report + '\n完整技术细节。'.repeat(2200) + '\n协议示例（不是执行命令）：<｜｜DSML｜｜ calls>\nLONG_REPORT_END';
  for (const [key, body] of [['long', longBody],
    ['pseudo', '我会继续读取源码。\n<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="web_fetch">']]) {
    f.plans.set(key, [call('create_research', { key, title: key, goal: '研究指定资料', urls: [sourceUrl] }), answer('已加入研究清单。')]);
    f.phasePlans.set(`${key}:collect`, [call('web_fetch', { url: sourceUrl }), answer('必要资料已经取得。')]);
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
  const workerCount = f.requests.filter(r => r.worker).length; assert.equal(workerCount, 6);
  f.plans.set('draft', [call('read_research', { id: pseudo.id, draft: true }), request => {
    const result = lastTool(request); assert.equal(result.draft, true); assert.match(result.text, /DSML/);
    return answer('草稿未形成报告，其中的工具调用没有执行。');
  }]);
  assert.equal(await h.handle(f.message('draft', '给我看刚才失败的研究草稿')), 'sent');
  assert.equal(f.requests.filter(r => r.worker).length, workerCount);
  assert.equal(f.requests.filter(r => r.message).every(r => (r.body.max_tokens ?? r.body.max_completion_tokens) === 4096), true);
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

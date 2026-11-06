import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CodexService, codexPrivateOwner, codexOwnerKey } from '../dist/codex-service.js';
import { openConversation } from '../dist/runtime.js';
import { preparationDelta } from './fixtures/turn-preparation.mjs';
import { DiagnosticLog } from '../dist/diagnostics.js';
import { CodexPublication } from '../dist/codex-publication.js';

test('publication requires exact original owner confirmation and sent acknowledgement; restart reports success or rollback once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-publication-'));
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\pa-publish-${randomUUID()}` : join(directory, 'publish.sock');
  const route = { channel: 'qq', accountId: 'bot', roomType: 'private', roomId: 'owner' };
  const owner = codexOwnerKey({ route, senderId: 'owner' }), releases = [], deliveries = [];
  let starts = 0, publication;
  const task = { id: 'C17', revision: 1, status: 'completed', mode: 'fix', diff: 'diff --git a/src/plain-text.ts b/src/plain-text.ts\n+ fix' };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(req.method === 'GET' ? url.searchParams.get('owner') : true, req.method === 'GET' ? owner : true);
    if (req.method === 'GET') { res.end(JSON.stringify({ releases: releases.filter(item => item.requestId === url.searchParams.get('requestId')) })); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); assert.equal(body.owner, owner);
    if (url.pathname === '/releases') {
      assert.equal(body.taskId, task.id); assert.equal(body.revision, task.revision);
      assert.equal(body.patchSha256, createHash('sha256').update(task.diff).digest('hex'));
      let release = releases.find(item => item.requestId === body.requestId);
      if (!release) { release = { ...body, id: randomUUID(), status: 'prepared' }; releases.push(release); }
      res.end(JSON.stringify(release)); return;
    }
    const release = releases.find(item => url.pathname === `/releases/${item.id}/start`);
    assert.equal(body.requestId, release.requestId); release.status = 'queued'; starts++;
    res.end(JSON.stringify(release));
  });
  await new Promise(resolve => server.listen(socket, resolve));
  const create = () => new CodexPublication(directory, socket, owner, route, 'owner', () => true, async () => ({ ...task }), async message => {
    deliveries.push(message); return { status: 'sent', externalMessageId: randomUUID() };
  });
  const message = (eventId, text = '把这版上线') => ({ route, senderId: 'owner', eventId, text, mentioned: false, sentAt: new Date().toISOString() });
  try {
    publication = create(); publication.recordReport(task);
    assert.equal(await publication.confirm({ ...message('intruder'), senderId: 'someone' }), undefined);
    assert.equal(await publication.confirm({ ...message('group'), route: { ...route, roomType: 'group' } }), undefined);
    assert.equal(await publication.confirm(message('question', '你会如何处理“把这版上线”这句话？')), undefined);
    const quoted = await publication.confirm({ ...message('quoted'), quote: { messageId: 'old' } });
    assert.match(quoted.text, /引用/); assert.equal(releases.length, 0);
    const unknown = await publication.confirm(message('uncertain-ack')); assert.equal(releases.length, 1); assert.equal(starts, 0);
    await unknown.acknowledge(false); publication.close(); publication = create(); await publication.poll(); assert.equal(starts, 0);
    const confirmed = await publication.confirm(message('confirmed')); assert.equal(starts, 0);
    assert.equal(releases.length, 1, 'fresh confirmation reuses the prepared version whose old acknowledgement was uncertain');
    await confirmed.acknowledge(true); assert.equal(starts, 1);
    publication.close(); releases[0].status = 'succeeded'; releases[0].summary = '新版已连接 QQ。';
    publication = create(); await publication.poll(); assert.equal(deliveries.length, 1); assert.match(deliveries[0].text, /已上线/);
    publication.close(); publication = create(); await publication.poll(); assert.equal(deliveries.length, 1);
    task.revision = 2;
    const stale = await publication.confirm(message('stale')); assert.match(stale.text, /新版本/); assert.equal(releases.length, 1);
    publication.recordReport(task);
    const rollback = await publication.confirm(message('rollback', '可以，把这版上线。')); await rollback.acknowledge(true);
    publication.close(); releases[1].status = 'rolled_back'; releases[1].summary = '健康检查失败，旧版已恢复。';
    publication = create(); await publication.poll(); assert.equal(deliveries.length, 2); assert.match(deliveries[1].text, /已恢复旧版/);
    const query = await publication.confirm(message('query', '查看发布结果')); assert.match(query.text, /已恢复旧版/); assert.equal(starts, 2);
  } finally { publication?.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});

test('owner private task delivers a plain-language result, continues same task, and preserves uncertain delivery across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-codex-'));
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\pa-codex-${randomUUID()}` : join(directory, 'worker.sock');
  const route = { channel: 'qq', accountId: 'bot', roomType: 'private', roomId: 'owner' };
  const binding = { route, senderId: 'owner' }, policy = { version: 1, ownerBindings: [binding] };
  assert.equal(codexPrivateOwner(policy, [route]), binding);
  assert.throws(() => codexPrivateOwner({ ...policy, ownerBindings: [binding, binding] }, [route]));
  const revisions = [], requests = new Map(), deliveries = [];
  let responseStatus = 'sent', service;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.owner, codexOwnerKey(binding));
      let task = requests.get(body.requestId);
      if (!task) {
        if (revisions.length) assert.equal(body.taskId, 'C17');
        task = { id: 'C17', revision: revisions.length + 1, status: 'queued', requestId: body.requestId };
        revisions.push(task); requests.set(body.requestId, task);
      }
      res.end(JSON.stringify(task)); return;
    }
    assert.equal(url.searchParams.get('owner'), codexOwnerKey(binding));
    if (url.pathname === '/tasks') {
      const requestId = url.searchParams.get('requestId');
      res.end(JSON.stringify({ tasks: requestId ? [requests.get(requestId)].filter(Boolean) : revisions.slice(-1) })); return;
    }
    res.end(JSON.stringify(revisions.at(-1)));
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const create = () => new CodexService({ dataDir: directory, codex: { socketPath } }, binding, () => true, async message => {
    deliveries.push(message); return responseStatus === 'sent' ? { status: 'sent', externalMessageId: 'qq-result' } : { status: responseStatus };
  });
  try {
    service = create();
    assert.equal(service.context(route, 'someone-else', 's1'), undefined);
    assert.equal(service.context({ ...route, roomType: 'group' }, 'owner', 's1'), undefined);
    const first = service.context(route, 'owner', 's1');
    const receipt = await first.execute('delegate_task', { mode: 'fix', prompt: 'Fix the divider and run its test.' });
    await first.execute('delegate_task', { mode: 'fix', prompt: 'Fix the divider and run its test.' });
    assert.equal(receipt.id, 'C17'); assert.equal(revisions.length, 1);
    Object.assign(revisions[0], { status: 'completed', summary: '分隔线已过滤，针对性测试通过。\n```diff\ndiff --git a/src b/src\n+ private patch\n```', evidence: 'node --test divider.test.mjs\nexit_code=0', diff: '+ underscore divider' });
    await service.wait(); await service.wait();
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].deliveryMode, 'active');
    assert.equal(deliveries[0].file, undefined);
    assert.match(deliveries[0].text, /已完成[\s\S]*分隔线已过滤，针对性测试通过/);
    assert.doesNotMatch(deliveries[0].text, /private patch|diff --git|exit_code/);
    const second = await service.context(route, 'owner', 's2').execute('continue_coding_task', { id: 'C17', mode: 'fix', prompt: 'Keep the fix, undo the wording change.' });
    assert.equal(second.revision, 2);
    Object.assign(revisions[1], { status: 'completed', summary: 'Revised.', evidence: 'node --test divider.test.mjs\nexit_code=0', diff: '+ revised divider' });
    responseStatus = 'uncertain'; await service.wait(); await service.close();
    service = create(); await service.wait();
    assert.equal(deliveries.length, 2, 'uncertain sends are not replayed after restart');
    const status = await service.context(route, 'owner', 's3').execute('coding_status', { id: 'C17' });
    assert.equal(status.revision, 2); assert.equal(status.summary, 'Revised.');
    assert.equal(status.diff, undefined); // Patches stay in the worker's task directory.
  } finally {
    await service?.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
  }
});

test('Pi dispatches the saved coding task once and returns the durable acknowledgement without another model call', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-codex-runtime-')), requests = [];
  const confirmation = '已交给 Codex，任务 C17（第 1 次）。完成后我会在这里告诉你结果。';
  let executions = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    const delta = requests.length === 1 ? preparationDelta('coding') : { role: 'assistant', tool_calls: [{
      index: 0, id: 'dispatch', type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ mode: 'fix', prompt: 'Fix divider.' }) } }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [value, finish_reason] of [[delta, null], [{}, 'tool_calls']]) {
      res.write(`data: ${JSON.stringify({ id: 'fixture', model: body.model, choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runtime = await openConversation({ cwd: directory, dataDir: join(directory, 'data'), provider: 'fixture', model: 'fixture', apiKey: 'fixture',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 131072, maxOutputTokens: 1024, timeoutMs: 5000 }, 'owner-private', { enableSearch: true, enableCodex: true });
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const result = await runtime.prompt('Fix divider.', { runId: 'coding', companionTools: {
    prepareTurn: plan => ({ prepared: true, mode: plan.mode, saved: [] }), readHistory: () => [],
    codex: { async execute(name, params) { executions++; assert.equal(name, 'delegate_task'); assert.equal(params.mode, 'fix'); return { saved: true, id: 'C17', revision: 1, status: 'queued', confirmation }; } } } });
  assert.equal(result, confirmation); assert.equal(executions, 1); assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ['prepare_turn']);
  assert.ok(requests[1].tools.some(tool => tool.function.name === 'delegate_task'));
  assert.equal(runtime.recordedTurns().at(-1).assistant.text, confirmation);
  const evidence=new DiagnosticLog(join(directory,'data')).events({traceId:'coding'});
  assert.ok(evidence.some(event=>event.event==='turn.completed' && event.details.answer===confirmation));
  assert.equal(runtime.info().sessionFile,undefined);
});

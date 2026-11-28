import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { ChannelHarness } from '../dist/channel-harness.js';
import { QQChannel } from '../dist/qq-channel.js';
import { isPreparationRequest, preparationDelta } from './fixtures/turn-preparation.mjs';

const account = 'fixture-app';
const member = 'owner-private';
const otherMember = 'guest-private';
const ownerRoute = { channel: 'qq', accountId: account, roomType: 'private', roomId: member };
const guestRoute = { ...ownerRoute, roomId: otherMember };
const originalFile = '# 第一版报价对比\n\n保留第一份内容。\n';
const revisedFile = '# 第二版报价对比\n\n按涨幅排列。\n';
const initialGoal = '把两份说明整理成一张对比表';
const revisedGoal = '改为按涨幅排列';
const independentGoal = '写一份会议议程';
const independentFile = '# 会议议程\n\n确认议题，分配时间。\n';

async function observe(read, description) {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const found = read();
    if (found) return found;
    if (Date.now() >= deadline) throw new Error('没有观察到' + description);
    await wait(15);
  }
}

function renderText(payload) {
  return payload?.markdown?.content ?? payload?.content ?? '';
}

function readDb(path, read) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return read(db); } finally { db.close(); }
}

function replyModel(response, delta, stop) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [value, reason] of [[delta, null], [{}, stop]]) {
    response.write('data: ' + JSON.stringify({
      id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta: value, finish_reason: reason }],
    }) + '\n\n');
  }
  response.end('data: [DONE]\n\n');
}

test('V11 QQ task entry preserves authorized versioned delivery across cutover and restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-p6-qq-'));
  const dataDir = join(directory, 'data');
  const legacyDb = join(dataDir, 'codex-delivery.sqlite');
  const tasksDb = join(dataDir, 'task-coordinator.sqlite');
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\pa-p6-' + randomUUID() : join(directory, 'legacy.sock');
  const sent = [], uploads = [], modelRequests = [], legacyWrites = [], legacyReads = [], workerStarts = [], errors = [];
  const originalTask = { id: 'OLD-42', revision: 1, status: 'queued', mode: 'read', summary: '旧任务已有结论，仅供查询。' };
  const revisionGate = Promise.withResolvers();
  let harness, qq, dispatchGateway, inbound;
  const coordinatorFailures = [];
  let loseLegacyDelivery = true;
  const model = createServer(async (request, response) => {
    try {
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf-8'));
      modelRequests.push(body);
      if (isPreparationRequest(body)) return replyModel(response, preparationDelta('prepare-local'), 'tool_calls');
      if (body.messages.some(message => message.role === 'system' && message.content.includes('本次后台文字任务'))) {
        assert.deepEqual(body.tools ?? [], []);
        const { content } = body.messages.find(message => message.role === 'user');
        const input = JSON.parse(typeof content === 'string' ? content : content.map(block => block.text).join(''));
        workerStarts.push(input);
        if (input.goal === revisedGoal) await revisionGate.promise;
        const outputs = { [initialGoal]: originalFile, [revisedGoal]: revisedFile, [independentGoal]: independentFile };
        assert.ok(Object.hasOwn(outputs, input.goal), 'unexpected task ' + input.goal);
        return replyModel(response, { role: 'assistant', content: outputs[input.goal] }, 'stop');
      }
      const tools = body.tools?.map(tool => tool.function.name) ?? [];
      if (!tools.includes('delegate_task')) {
        replyModel(response, { role: 'assistant', content: '普通聊天回复。' }, 'stop');
        return;
      }
      const delegate = body.tools.find(tool => tool.function.name === 'delegate_task');
      const legacy = 'mode' in delegate.function.parameters.properties;
      const args = legacy ? { mode: 'read', prompt: '整理之前的记录' }
        : { prompt: initialGoal, delivery: 'markdown' };
      replyModel(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'delegation-local',
        type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify(args) } }] }, 'tool_calls');
    } catch (error) {
      errors.push(error);
      response.destroy();
    }
  });
  const legacy = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://legacy-local');
      if (request.method === 'POST') {
        const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf-8'));
        legacyWrites.push(body);
        originalTask.requestId = body.requestId;
        response.end(JSON.stringify(originalTask));
      } else {
        legacyReads.push(url.pathname);
        response.end(JSON.stringify(url.pathname === '/tasks'
          ? { tasks: originalTask.requestId ? [originalTask] : [] } : originalTask));
      }
    } catch (error) {
      errors.push(error);
      response.destroy();
    }
  });
  t.after(async () => {
    revisionGate.resolve();
    try { await harness?.close(); } finally {
      qq?.close();
      await Promise.all([model, legacy].map(server => {
        server.closeAllConnections();
        return server.listening ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : undefined;
      }));
      await rm(directory, { recursive: true, force: true });
    }
    assert.deepEqual(errors, []);
  });
  await Promise.all([
    new Promise(resolve => model.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => legacy.listen(socketPath, resolve)),
  ]);

  const config = {
    cwd: directory, dataDir, provider: 'fixture', model: 'fixture', apiKey: 'local-key',
    baseUrl: 'http://127.0.0.1:' + model.address().port + '/v1', contextWindow: 131072,
    maxOutputTokens: 4096, timeoutMs: 5_000, codex: { socketPath },
  };
  const policy = { version: 1, ownerBindings: [{ route: ownerRoute, senderId: member }] };
  const run = async enabled => {
    // Recreation discards both the gateway session and PA in-memory state.
    qq = new QQChannel({ appId: account, clientSecret: 'local-fixture' }, {
      onMessage(message) { harness.handle(message).then(inbound.resolve, inbound.reject); },
    }, {
      async fetch(url, init) {
        if (url.endsWith('/app/getAppAccessToken')) return Response.json({ access_token: 'fixture-token', expires_in: 7200 });
        if (url.endsWith('/gateway/bot')) return Response.json({ url: 'wss://api.bot.qq.com/ws' });
        const body = JSON.parse(init.body);
        if (url.endsWith('/files')) {
          uploads.push({ url, bytes: Buffer.from(body.file_data, 'base64'), name: body.file_name });
          assert.equal(body.srv_send_msg, false);
          return Response.json({ file_info: 'file-' + uploads.length });
        }
        assert.ok(url.endsWith('/messages'), url);
        sent.push({ url, body });
        if (loseLegacyDelivery && renderText(body).includes('旧任务已有结论') && !body.msg_id) {
          throw new Error('fixture lost the legacy result receipt');
        }
        if (body.media?.file_info === 'file-1') throw new Error('fixture lost the first coordinator file receipt');
        return Response.json({ id: 'qq-' + sent.length });
      },
      webSocketFactory() {
        const listeners = new Map();
        dispatchGateway = payload => listeners.get('message')({ data: JSON.stringify(payload) });
        queueMicrotask(() => dispatchGateway({
          op: 0, t: 'READY', d: { user: { id: 'fixture-bot' }, session_id: randomUUID() },
        }));
        return { readyState: 1, addEventListener(name, listener) { listeners.set(name, listener); }, send() {}, close() {} };
      },
    });
    await qq.start();
    harness = new ChannelHarness({ ...config, ...(enabled ? { taskCoordinator: { enabled: true } } : {}) },
      [ownerRoute, guestRoute], qq, 0, policy, undefined, undefined, undefined, {
        onCoordinatorFailure: () => coordinatorFailures.push(harness.info().taskCoordinator),
      });
    await harness.start();
  };
  const stop = async () => {
    await harness.close();
    qq.close();
    harness = qq = undefined;
  };
  const receive = (id, content, sender = member) => {
    inbound = Promise.withResolvers();
    dispatchGateway({ op: 0, t: 'C2C_MESSAGE_CREATE',
      d: { id, content, timestamp: new Date().toISOString(), author: { user_openid: sender } } });
    return inbound.promise;
  };
  const userReply = id => sent.find(({ body }) => body.msg_id === id);
  const taskReceipt = id => {
    const reply = userReply(id);
    const taskId = renderText(reply?.body).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0];
    assert.ok(taskId, JSON.stringify(reply));
    return taskId;
  };
  const readDelivery = () => readDb(tasksDb, db => db.prepare(
    'SELECT task_id, revision, status FROM task_notifications ORDER BY notification_id',
  ).all().map(({ task_id, revision, status }) => [task_id, revision, status]));
  const expectFileDelivery = async (count, status = 'sent') => {
    await observe(() => readDelivery()[count - 1]?.[2] === status, '第 ' + count + ' 次 QQ 文件发送结果持久记录');
    assert.equal(sent.filter(({ body }) => body.msg_type === 7).length, count);
    assert.equal(uploads.length, count);
    assert.ok(uploads[count - 1].url.includes('/users/' + member + '/files'));
    assert.match(uploads[count - 1].name, /\.md$/);
    return uploads[count - 1].bytes;
  };
  const countTasks = () => readDb(tasksDb, db => db.prepare('SELECT count(*) AS count FROM tasks').get().count);
  const readLegacy = () => readDb(legacyDb, db => ({
    requests: db.prepare('SELECT * FROM requests ORDER BY request_id').all(),
    notifications: db.prepare('SELECT * FROM notifications ORDER BY task_id').all(),
  }));

  await run(false);
  const oldInput = '查一下以前的记录';
  assert.equal(await receive('legacy-event', oldInput), 'sent');
  assert.equal(legacyWrites.length, 1);
  assert.match(renderText(userReply('legacy-event')?.body), /OLD-42/);
  originalTask.status = 'completed';
  await observe(() => readLegacy().notifications.find(row => row.status === 'uncertain'), '旧任务的未知回执记录');
  loseLegacyDelivery = false;
  await stop();
  const oldState = readLegacy();
  const oldReadCount = legacyReads.length;
  const oldSendCount = sent.filter(({ body }) => !body.msg_id && renderText(body).includes('旧任务已有结论')).length;

  await run(true);
  assert.equal(await receive('legacy-event', oldInput), 'duplicate');
  assert.equal(await receive('legacy-query', '/task 历史 OLD-42'), 'sent');
  assert.match(renderText(userReply('legacy-query')?.body), /OLD-42/);
  assert.match(renderText(userReply('legacy-query')?.body), /旧任务已有结论/);
  assert.ok(legacyReads.includes('/tasks/OLD-42'));
  assert.equal(await receive('guest-submit', '/task 新建 其他用户的任务', otherMember), 'sent');
  assert.match(renderText(userReply('guest-submit')?.body), /仅对已配置的本人 QQ 私聊开放/);
  assert.equal(countTasks(), 0);

  const request = '请交给后台，' + initialGoal;
  assert.equal(await receive('new-event', request), 'sent');
  const taskId = taskReceipt('new-event');
  assert.equal(await receive('new-event', request), 'duplicate');
  assert.deepEqual(await expectFileDelivery(1, 'unknown'), Buffer.from(originalFile));

  assert.equal(await receive('guest-read', '/task 查询 ' + taskId + ' 1', otherMember), 'sent');
  assert.match(renderText(userReply('guest-read')?.body), /仅对已配置的本人 QQ 私聊开放/);
  assert.equal(await receive('guest-reclaim', '/task 重领 ' + taskId + ' 1', otherMember), 'sent');
  assert.match(renderText(userReply('guest-reclaim')?.body), /仅对已配置的本人 QQ 私聊开放/);
  assert.equal(uploads.length, 1);
  assert.equal(await receive('status-1', '/task 查询 ' + taskId + ' 1'), 'sent');
  assert.match(renderText(userReply('status-1')?.body), /已完成[\s\S]*送达未确认/);

  assert.equal(await receive('independent-event', '/task 新建 ' + independentGoal), 'sent');
  const independentId = taskReceipt('independent-event');
  assert.notEqual(independentId, taskId);
  assert.deepEqual(await expectFileDelivery(2), Buffer.from(independentFile));
  assert.equal(await receive('independent-status', '/task 查询 ' + independentId + ' 1'), 'sent');
  assert.match(renderText(userReply('independent-status')?.body), /已完成[\s\S]*已送达/);

  const revise = '/task 续办 ' + taskId + ' 1 ' + revisedGoal;
  assert.equal(await receive('revise-2', revise), 'sent');
  const revisionStart = await observe(() => workerStarts.find(attempt => attempt.goal === revisedGoal), '第二版开始执行');
  assert.equal(revisionStart.priorResult, originalFile);
  assert.equal(await receive('status-running', '/task 查询 ' + taskId + ' 2'), 'sent');
  assert.match(renderText(userReply('status-running')?.body), /(?:执行中|处理中|运行中|正在)/);
  revisionGate.resolve();
  assert.deepEqual(await expectFileDelivery(3), Buffer.from(revisedFile));
  await stop();

  await run(true);
  assert.equal(await receive('revise-2', revise), 'duplicate');
  assert.equal(await receive('cancel-closed', '/task 取消 ' + taskId + ' 2'), 'sent');
  assert.match(renderText(userReply('cancel-closed')?.body), /已经?结案/);
  const reclaim = '/task 重领 ' + taskId + ' 1';
  assert.equal(await receive('reclaim-1', reclaim), 'sent');
  assert.equal(await receive('reclaim-1', reclaim), 'duplicate');
  assert.deepEqual(await expectFileDelivery(4), Buffer.from(originalFile));
  await stop();

  await run(true);
  const faultDb = new DatabaseSync(tasksDb);
  try {
    faultDb.exec('ALTER TABLE task_scheduler_policy RENAME TO unavailable_policy');
    await observe(() => coordinatorFailures.length, '无新 QQ 消息时协调器主动上报停止');
    assert.equal(coordinatorFailures.length, 1);
    assert.equal(coordinatorFailures[0].failed, true);
    assert.equal(harness.info().taskCoordinator.failed, true);
  } finally {
    faultDb.exec('ALTER TABLE unavailable_policy RENAME TO task_scheduler_policy');
    faultDb.close();
    await stop();
  }
  await run(false);
  assert.equal(await receive('status-after-disable', '/task 查询 ' + taskId + ' 1'), 'sent');
  assert.equal(renderText(userReply('status-after-disable')?.body), renderText(userReply('status-1')?.body));
  const attemptsBefore = modelRequests.length;
  assert.equal(await receive('rollback-new', '请帮我重新整理记录'), 'sent');
  const callsAfterRollback = modelRequests.slice(attemptsBefore);
  assert.ok(callsAfterRollback.length > 0);
  assert.ok(callsAfterRollback.every(call => !call.tools?.some(tool => tool.function.name === 'delegate_task')));
  assert.equal(legacyWrites.length, 1);
  assert.deepEqual(legacyReads.slice(oldReadCount), ['/tasks/OLD-42']);
  assert.equal(sent.filter(({ body }) => !body.msg_id && renderText(body).includes('旧任务已有结论')).length, oldSendCount);
  assert.deepEqual(readLegacy(), oldState);
  assert.equal(countTasks(), 2);
  assert.deepEqual(workerStarts, [{ goal: initialGoal }, { goal: independentGoal }, { goal: revisedGoal, priorResult: originalFile }]);
  const attempts = readDb(tasksDb, db => db.prepare('SELECT task_id, revision FROM task_attempts ORDER BY rowid').all()
    .map(({ task_id, revision }) => [task_id, revision]));
  assert.deepEqual(attempts, [[taskId, 1], [independentId, 1], [taskId, 2]]);
  const delivery = readDelivery();
  assert.deepEqual(delivery, [[taskId, 1, 'unknown'], [independentId, 1, 'sent'], [taskId, 2, 'sent'], [taskId, 1, 'sent']]);
  t.diagnostic(JSON.stringify({ taskId, independentId, attempts,
    delivery, uploads: uploads.map(file => ({ name: file.name, size: file.bytes.length })),
    legacyWrites: legacyWrites.length, legacyUnknownPreserved: true }));
});

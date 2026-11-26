import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { TaskCoordinatorStore } from '../dist/task-coordinator/store.js';
import { startCoordinator } from '../dist/task-coordinator/service.js';

function call(socketPath, token, operation, body) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/v1/' + operation, method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ code: response.statusCode, ...JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Local coordinator did not respond')));
    req.on('error', reject);
    req.end(JSON.stringify({ protocolVersion: 1, ...body }));
  });
}

test('P1: authenticated acceptance and atomic revision closure survive restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pa-coordinator-p1-'));
  const dbPath = join(dir, 'tasks.sqlite');
  const pathFor = owner => process.platform === 'win32' ? '\\\\.\\pipe\\pa-p1-' + randomUUID() : join(dir, owner + '.sock');
  const socketA = pathFor('a'), socketB = pathFor('b');
  const tokenA = randomBytes(32).toString('hex'), tokenB = randomBytes(32).toString('hex');
  let store, first, second, inspect;
  const open = async () => {
    store = new TaskCoordinatorStore(dbPath);
    first = await startCoordinator({ socketPath: socketA, owner: 'owner-a', token: tokenA, store });
    second = await startCoordinator({ socketPath: socketB, owner: 'owner-b', token: tokenB, store });
    inspect = new DatabaseSync(dbPath);
  };
  const close = async () => {
    await first?.close();
    await second?.close();
    first = second = undefined;
    inspect?.close(); store?.close();
    inspect = store = undefined;
  };
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  await open();
  const spec = { goal: 'Compare the two lists', capability: 'analyze', materials: ['upload-a:1', 'upload-b:1'],
    deadlineAt: Date.now() + 600_000, budget: 3 };
  const payload = { sourceKey: 'qq-inbound-17-action-1', spec };
  const send = (command, body) => call(socketA, tokenA, command, body);
  const count = table => inspect.prepare('SELECT count(*) AS n FROM ' + table).get().n;

  assert.equal((await call(socketA, tokenB, 'submit', payload)).code, 401);
  const [accepted, replayed] = await Promise.all([send('submit', payload), send('submit', payload)]);
  assert.equal(accepted.code, 200, JSON.stringify(accepted));
  assert.deepEqual(accepted.result, replayed.result);
  assert.equal(accepted.result.revision, 1);
  assert.equal(count('tasks'), 1);
  assert.equal((await send('submit', { ...payload, spec: { ...spec, goal: 'different' } })).code, 409);
  const { taskId } = accepted.result;
  assert.equal((await call(socketB, tokenB, 'status', { taskId })).code, 404);
  assert.equal((await call(socketB, tokenB, 'lookup', { sourceKey: payload.sourceKey })).code, 404);
  assert.equal((await send('lookup', { sourceKey: payload.sourceKey })).result.taskId, taskId);
  assert.equal((await send('status', { taskId })).result.phase, 'queued');

  const outcome = { status: 'succeeded', summary: 'First version ready' };
  inspect.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON task_notifications BEGIN SELECT RAISE(ABORT,'fixture unavailable'); END");
  assert.throws(() => store.settle('owner-a', taskId, 1, outcome));
  assert.equal(count('task_conclusions'), 0);
  assert.equal((await send('status', { taskId })).result.phase, 'queued');
  inspect.exec('DROP TRIGGER reject_notice');
  store.settle('owner-a', taskId, 1, outcome);
  store.settle('owner-a', taskId, 1, outcome);
  assert.throws(() => store.settle('owner-a', taskId, 1, { status: 'failed', summary: 'late' }));
  assert.equal(count('task_notifications'), 1);
  assert.equal(count('task_conclusions'), 1);

  const revise = sourceKey => ({ taskId, sourceKey, expectedRevision: 1, newGoal: 'Sort descending' });
  const edits = await Promise.all([send('revise', revise('change-a')), send('revise', revise('change-b'))]);
  assert.deepEqual(edits.map(r => r.code).sort(), [200, 409]);
  const winner = edits[0].code === 200 ? 'change-a' : 'change-b';
  await close();
  await open();
  assert.deepEqual((await send('revise', revise(winner))).result, { taskId, revision: 2 });
  assert.deepEqual((await send('submit', payload)).result, accepted.result);
  const latest = (await send('status', { taskId })).result;
  assert.equal(latest.revision, 2);
  assert.deepEqual(latest.spec.materials, spec.materials);
  assert.deepEqual((await send('status', { taskId, revision: 1 })).result.conclusion, outcome);
  assert.equal(count('task_notifications'), 1);
});

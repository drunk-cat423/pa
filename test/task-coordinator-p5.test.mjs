import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TaskDeliveryStore } from '../dist/task-coordinator/delivery-store.js';
import { TaskDeliveryWorker } from '../dist/task-coordinator/delivery.js';
import { WorkerRegistry } from '../dist/task-coordinator/registry.js';
import { TaskScheduler } from '../dist/task-coordinator/scheduler.js';
import { startCoordinator } from '../dist/task-coordinator/service.js';
import { TaskCoordinatorStore } from '../dist/task-coordinator/store.js';

const owner = 'owner-a';
const otherOwner = 'owner-b';
const workerId = 'reporter';
const secret = 'a'.repeat(64);
const room = { roomKey: 'controlled-room', recipientKey: 'controlled-recipient' };
const format = 'text/plain';

function file(reference, data) {
  const bytes = Buffer.from(data);
  return { reference, format, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function fence(attempt) {
  const { attemptKey, leaseGeneration, attemptToken } = attempt;
  return { attemptKey, leaseGeneration, attemptToken };
}

function post(socketPath, token, operation, fields) {
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath, path: '/v1/' + operation, method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(8_000),
    }, async res => {
      try {
        const chunks = await Array.fromAsync(res);
        resolve({ code: res.statusCode, ...JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.end(JSON.stringify({ protocolVersion: 1, ...fields }));
  });
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-p5-'));
  const dbPath = join(directory, 'tasks.sqlite');
  const fixture = { dbPath, now: Date.now(), starts: [] };
  const registry = new WorkerRegistry();
  const register = id => registry.register({
    declaration: {
      workerId: id, protocolVersion: 1,
      capabilities: [{ name: 'write', inputFormats: [], outputFormats: [format], requiredPermissions: [] }],
      resources: [{ poolId: 'cpu', units: 1 }],
      limits: { maxConcurrent: 4, operationTimeoutMs: 2_000, reportBytes: 8_192 },
      idempotentStart: false, canResume: true, canInspect: false, canStop: false, effects: 'external',
    },
    async start(attempt) {
      fixture.starts.push(attempt);
      return { disposition: 'accepted', externalId: 'controlled-execution' };
    },
  });
  register(workerId);
  register('other-worker');
  const secrets = new Map([[workerId, secret], ['other-worker', 'b'.repeat(64)]]);
  let endpoints = [];
  let auxiliaryStores = [];
  fixture.stopChildren = [];
  const close = async () => {
    for (const endpoint of endpoints.splice(0)) await endpoint.close();
    await fixture.scheduler?.close();
    for (const store of auxiliaryStores.splice(0)) store.close();
    fixture.delivery?.close();
    fixture.inspect?.close();
    fixture.store?.close();
  };
  t.after(async () => {
    for (const stop of fixture.stopChildren) await stop();
    await close();
    await rm(directory, { recursive: true, force: true });
  });
  const start = async () => {
    fixture.store = new TaskCoordinatorStore(dbPath);
    fixture.scheduler = new TaskScheduler({
      store: fixture.store, registry, connectionSecrets: secrets, now: () => fixture.now,
      maxConcurrent: 4, poolLimits: new Map([['cpu', 4]]),
    });
    fixture.delivery = new TaskDeliveryStore(dbPath);
    fixture.inspect = new DatabaseSync(dbPath);
    fixture.client = Object.fromEntries(await Promise.all([owner, otherOwner].map(async identity => {
      const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\pa-p5-' + randomUUID() : join(directory, identity + '.sock');
      const token = randomBytes(32).toString('hex');
      endpoints.push(await startCoordinator({ socketPath, owner: identity, token, store: fixture.store, deliveryStore: fixture.delivery }));
      return [identity, (operation, fields) => post(socketPath, token, operation, fields)];
    })));
  };
  fixture.reopen = async () => {
    await close();
    await start();
  };
  fixture.worker = (id = workerId) => {
    const connection = fixture.scheduler.endpoint.authenticate(id, secrets.get(id));
    assert.ok(connection);
    return connection;
  };
  fixture.dispatch = async receipt => {
    const dispatches = fixture.scheduler.tick().dispatches;
    assert.deepEqual((await Promise.all(dispatches)).map(reply => reply.disposition), ['accepted']);
    const attempt = fixture.starts.at(-1);
    assert.equal(attempt.taskId, receipt.taskId);
    assert.equal(attempt.revision, receipt.revision);
    return { receipt, attempt };
  };
  fixture.submit = async (sourceKey, wantsFile = true) => {
    const response = await fixture.client[owner]('submit', {
      sourceKey,
      spec: {
        goal: sourceKey, capability: 'write', materials: [], deadlineAt: fixture.now + 60_000, budget: 1,
        outputFormats: [format], ...(wantsFile ? { requiredArtifactFormats: [format] } : {}),
      },
    });
    assert.equal(response.code, 200, JSON.stringify(response));
    return fixture.dispatch(response.result);
  };
  fixture.report = (attempt, artifacts, summary = 'Controlled result') => fixture.worker().report(Buffer.from(JSON.stringify({
    protocolVersion: 1, ...fence(attempt), eventSeq: 1,
    event: { kind: 'result', outcome: 'succeeded', summary, evidence: [],
      artifacts: artifacts.map(({ reference, format }) => ({ reference, format })) },
  })));
  fixture.sender = (adapter, independent = false) => {
    const store = independent ? new TaskDeliveryStore(dbPath) : fixture.delivery;
    if (independent) auxiliaryStores.push(store);
    return new TaskDeliveryWorker(store, adapter, { now: () => fixture.now, leaseMs: 10_000, sendTimeoutMs: 5_000 });
  };
  await start();
  return fixture;
}

async function readResult(f, receipt) {
  const response = await f.client[owner]('result', receipt);
  assert.equal(response.code, 200, JSON.stringify(response));
  return response.result;
}

async function readDelivery(f, notificationId) {
  const response = await f.client[owner]('delivery', { notificationId });
  assert.equal(response.code, 200, JSON.stringify(response));
  return response.result;
}

async function reclaim(f, receipt, sourceKey) {
  const response = await f.client[owner]('reclaim', { ...receipt, sourceKey });
  assert.equal(response.code, 200, JSON.stringify(response));
  return response.result.notificationId;
}

async function startInterruptedSender(f, notificationId) {
  const script = fileURLToPath(new URL('./fixtures/task-coordinator-delivery-interrupted.mjs', import.meta.url));
  const child = fork(script, [f.dbPath, String(f.now)], {
    execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = once(child, 'exit');
  f.stopChildren.push(async () => {
    if (child.connected) child.disconnect();
    await exited;
  });
  const [sent] = await Promise.race([
    once(child, 'message', { signal: AbortSignal.timeout(8_000) }),
    exited.then(([code]) => { throw new Error('Sender exited before its second send: ' + code); }),
  ]);
  assert.notEqual(sent.pid, process.pid);
  assert.equal(sent.notificationId, notificationId);
  assert.equal(sent.totalParts, 3);
  assert.deepEqual(sent.parts, [1, 2]);
  return async () => {
    child.send('interrupt');
    assert.deepEqual(await exited, [42, null]);
  };
}

test('V09 artifacts and delivery intent freeze atomically and survive restart', async t => {
  const f = await fixture(t);
  const { receipt, attempt } = await f.submit('verified-file');
  const upload = file('report.txt', 'PA 的结果保留原始中文。\r\n末行\n');
  const { bytes, ...info } = upload;
  const metadata = { ...info, byteCount: bytes.length };
  const uploader = f.worker();
  assert.throws(() => f.worker('other-worker').stageArtifact(fence(attempt), upload));
  assert.throws(() => uploader.stageArtifact(fence(attempt), { ...upload, sha256: '0'.repeat(64) }),
    { code: 'invalid_request' });
  assert.deepEqual(uploader.stageArtifact(fence(attempt), upload), metadata);
  assert.deepEqual(uploader.stageArtifact(fence(attempt), upload), metadata);
  assert.throws(() => uploader.stageArtifact(fence(attempt), file(upload.reference, 'different')), { code: 'conflict' });

  const getFile = { ...receipt, reference: upload.reference };
  const foundBefore = await f.client[owner]('artifact', getFile);
  assert.equal(foundBefore.code, 404);
  await f.reopen();
  f.inspect.exec("CREATE TRIGGER reject_artifact_freeze BEFORE INSERT ON task_artifacts BEGIN SELECT RAISE(ABORT, 'injected freeze failure'); END;");
  assert.throws(() => f.report(attempt, [upload]), /injected freeze failure/);
  const counts = () => Object.fromEntries(['task_conclusions', 'task_artifacts', 'task_notifications'].map(table =>
    [table, f.inspect.prepare('SELECT count(*) AS total FROM ' + table).get().total]));
  assert.deepEqual(counts(), { task_conclusions: 0, task_artifacts: 0, task_notifications: 0 });
  assert.equal(f.store.status(owner, receipt.taskId, receipt.revision).phase, 'running');
  assert.equal(f.scheduler.usage().global, 1);
  assert.equal((await f.client[owner]('result', receipt)).code, 404);
  f.inspect.exec('DROP TRIGGER reject_artifact_freeze;');
  assert.deepEqual(f.report(attempt, [upload]), { disposition: 'recorded' });
  assert.deepEqual(f.report(attempt, [upload]), { disposition: 'duplicate' });
  await f.reopen();

  const ready = await readResult(f, receipt);
  assert.equal(ready.conclusion.status, 'succeeded');
  assert.deepEqual(ready.artifacts, [{ ...metadata, available: true }]);
  assert.equal(ready.deliveries.length, 1);
  assert.equal(ready.deliveries[0].status, 'pending');
  assert.equal(ready.deliveries[0].purpose, 'automatic');
  assert.deepEqual(counts(), { task_conclusions: 1, task_artifacts: 1, task_notifications: 1 });
  const fetched = await f.client[owner]('artifact', getFile);
  assert.deepEqual(fetched.result, { ...metadata, bytesBase64: bytes.toString('base64') });
  assert.equal((await f.client[otherOwner]('artifact', getFile)).code, 404);
  assert.equal((await f.client[otherOwner]('result', receipt)).code, 404);
  assert.throws(() => f.worker().stageArtifact(fence(attempt), file('extra.txt', 'too late')));

  const revisionSource = 'verified-file-revised';
  const revised = await f.client[owner]('revise', {
    taskId: receipt.taskId, expectedRevision: receipt.revision, sourceKey: revisionSource, newGoal: 'Revise the same report',
  });
  assert.equal(revised.code, 200, JSON.stringify(revised));
  const revision = await f.dispatch(revised.result);
  assert.deepEqual(f.report(revision.attempt, [upload]), { disposition: 'recorded' });
  const wrongVersion = await readResult(f, revision.receipt);
  assert.equal(wrongVersion.conclusion.status, 'failed', 'an artifact from an earlier attempt cannot close a new revision');
  assert.deepEqual(wrongVersion.artifacts, []);
  assert.deepEqual((await f.client[owner]('artifact', getFile)).result, fetched.result);
  assert.equal(f.delivery.pending().find(intent => intent.notificationId === wrongVersion.deliveries[0].notificationId)?.sourceKey,
    revisionSource);

  const corrupted = await f.submit('corrupted-file');
  const bad = file('bad.txt', 'original');
  f.worker().stageArtifact(fence(corrupted.attempt), bad);
  f.inspect.prepare('UPDATE task_artifact_staging SET bytes=? WHERE attempt_key=? AND reference=?')
    .run(Buffer.alloc(bad.bytes.length, 65), corrupted.attempt.attemptKey, bad.reference);
  assert.deepEqual(f.report(corrupted.attempt, [bad]), { disposition: 'recorded' });
  const rejected = await readResult(f, corrupted.receipt);
  assert.equal(rejected.conclusion.status, 'failed');
  assert.deepEqual(rejected.artifacts, []);
  assert.equal((await f.client[owner]('artifact', { ...corrupted.receipt, reference: bad.reference })).code, 404);

  f.inspect.prepare('UPDATE task_artifact_staging SET bytes=? WHERE attempt_key=? AND reference=?')
    .run(Buffer.alloc(upload.bytes.length, 66), attempt.attemptKey, upload.reference);
  assert.deepEqual((await readResult(f, receipt)).artifacts, [{ ...metadata, available: false }]);
  const unreadable = await f.client[owner]('artifact', getFile);
  assert.equal(unreadable.code, 409);
  assert.equal(unreadable.error, 'artifact_unavailable');

  t.diagnostic(JSON.stringify({ original: receipt, artifact: metadata, pending: ready.deliveries[0], corrupted: rejected.conclusion.status }));
});

test('V10 uncertain delivery stops remaining parts and authorized reclaim reuses the original result', async t => {
  const f = await fixture(t);
  const original = await f.submit('three-part-result');
  const upload = file('original.txt', 'Exact original artifact.\n');
  f.worker().stageArtifact(fence(original.attempt), upload);
  assert.deepEqual(f.report(original.attempt, [upload], 'x'.repeat(1000) + '\n' + 'y'.repeat(1000)), { disposition: 'recorded' });
  const first = (await readResult(f, original.receipt)).deliveries[0].notificationId;
  const next = await f.submit('next-result', false);
  assert.deepEqual(f.report(next.attempt, []), { disposition: 'recorded' });
  const nextResult = await readResult(f, next.receipt);
  assert.equal(nextResult.conclusion.status, 'succeeded', 'a text response can complete without an attachment');
  const second = nextResult.deliveries[0].notificationId;

  const events = [];
  const revoked = new Set();
  const adapter = {
    resolveRoute(source) { return revoked.has(source.sourceKey) ? undefined : room; },
    async sendPart(part) {
      events.push(part);
      return { status: 'sent', receipt: 'controlled-' + part.notificationId + '-' + part.partNumber };
    },
  };
  const interrupt = await startInterruptedSender(f, first);
  const competitor = f.sender(adapter, true);
  assert.equal(await competitor.tick(), false);
  assert.equal(events.length, 0, 'same room must stay reserved by the first sender');
  const third = await f.submit('task-finishes-while-delivery-waits', false);
  assert.deepEqual(f.report(third.attempt, []), { disposition: 'recorded' });
  const thirdNotification = (await readResult(f, third.receipt)).deliveries[0].notificationId;
  const starts = f.starts.length;

  await interrupt();
  await f.reopen();
  f.now += 60_001;
  const sender = f.sender(adapter);
  assert.equal(await sender.tick(), true);
  assert.equal(await sender.tick(), true);
  assert.equal(await sender.tick(), false);
  assert.deepEqual(events.map(part => part.notificationId), [second, thirdNotification]);

  const interrupted = await readDelivery(f, first);
  assert.equal(interrupted.status, 'unknown');
  assert.deepEqual(interrupted.parts.map(({ status, receipt }) => ({ status, receipt })), [
    { status: 'sent', receipt: 'child-first-part' },
    { status: 'unknown', receipt: null },
    { status: 'pending', receipt: null },
  ]);
  assert.equal((await readDelivery(f, second)).status, 'sent');
  assert.equal((await f.client[otherOwner]('delivery', { notificationId: first })).code, 404);
  assert.equal((await f.client[otherOwner]('reclaim', { ...original.receipt, sourceKey: 'unauthorized_reclaim' })).code, 404);
  const [reclaimed, duplicate] = await Promise.all([
    reclaim(f, original.receipt, 'reclaim-current-owner'),
    reclaim(f, original.receipt, 'reclaim-current-owner'),
  ]);
  assert.equal(duplicate, reclaimed);
  assert.notEqual(reclaimed, first);
  assert.equal((await f.client[owner]('reclaim', { ...next.receipt, sourceKey: 'reclaim-current-owner' })).code, 409);
  assert.equal(await sender.tick(), true);
  const retried = events.filter(part => part.notificationId === reclaimed);
  assert.deepEqual(retried.map(part => part.partNumber), [1, 2, 3]);
  const artifact = retried[2].body.artifact;
  assert.equal(artifact.sha256, upload.sha256);
  assert.deepEqual(Buffer.from(artifact.bytes), upload.bytes);
  assert.equal((await readDelivery(f, reclaimed)).status, 'sent');
  assert.equal((await readResult(f, original.receipt)).deliveries.length, 2);

  const noLongerAuthorized = await reclaim(f, original.receipt, 'revoked-reclaim');
  revoked.add('revoked-reclaim');
  await sender.tick();
  assert.equal(events.some(({ notificationId }) => notificationId === noLongerAuthorized), false);
  const denied = await readDelivery(f, noLongerAuthorized);
  assert.equal(denied.status, 'rejected');
  assert.equal(denied.detail, 'route_revoked');
  assert.equal(f.scheduler.tick().attempts.length, 0);
  assert.equal(f.starts.length, starts);
  t.diagnostic(JSON.stringify({ original: first, parts: interrupted.parts, next: second, reclaimed,
    deliveredInOrder: events.map(({ notificationId, partNumber }) => [notificationId, partNumber]), starts, denied: denied.detail }));
});

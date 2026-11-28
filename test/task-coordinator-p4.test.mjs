import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WorkerRegistry } from '../dist/task-coordinator/registry.js';
import { TaskScheduler } from '../dist/task-coordinator/scheduler.js';
import { startCoordinator } from '../dist/task-coordinator/service.js';
import { TaskCoordinatorStore } from '../dist/task-coordinator/store.js';

const owner = 'owner-a';
const interval = 100;
const grace = 5_000;
const secret = 'a'.repeat(64);
const unknown = { disposition: 'unknown' };

function worker(workerId, capability, poolId, behavior = {}, maxConcurrent = 4) {
  return {
    declaration: {
      workerId, protocolVersion: 1,
      capabilities: [{ name: capability, inputFormats: [], outputFormats: [], requiredPermissions: [] }],
      resources: [{ poolId, units: 1 }],
      limits: { maxConcurrent, operationTimeoutMs: 2_000, reportBytes: 4_096 },
      idempotentStart: false, canResume: true,
      canInspect: Boolean(behavior.inspect), canStop: Boolean(behavior.stop), effects: 'external',
    },
    async start() { return { disposition: 'accepted', externalId: 'controlled-run' }; },
    ...behavior,
  };
}

async function fixture(t, workers, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-coordinator-p4-'));
  const dbPath = join(directory, 'tasks.sqlite');
  const f = { directory, dbPath, now: Date.now() };
  const registry = new WorkerRegistry();
  const connectionSecrets = new Map();
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) await socket.close();
    await f.scheduler?.close();
    f.inspect?.close();
    f.store?.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (const [index, adapter] of workers.entries()) {
    registry.register(adapter);
    connectionSecrets.set(adapter.declaration.workerId, (index + 10).toString(16).repeat(64));
  }
  f.store = new TaskCoordinatorStore(dbPath);
  const buildScheduler = () => new TaskScheduler({
    store: f.store, registry, connectionSecrets, now: () => f.now,
    maxConcurrent: 4, poolLimits: new Map([['metered', 4]]),
    recoveryIntervalMs: interval, recoveryGraceMs: grace, ...options,
  });
  const inspect = new DatabaseSync(dbPath, { readOnly: true });
  f.inspect = inspect;
  f.scheduler = buildScheduler();
  f.reopen = async () => {
    await f.scheduler.close();
    f.store.close();
    f.store = new TaskCoordinatorStore(dbPath);
    f.scheduler = buildScheduler();
  };
  f.round = async () => {
    const result = f.scheduler.tick();
    await Promise.all([...result.dispatches, ...result.recoveries]);
    return result;
  };
  f.spec = (goal, capability, overrides = {}) => ({
    goal, capability, materials: ['source:1'], deadlineAt: f.now + 60_000, budget: 10, ...overrides,
  });
  f.submit = (goal, capability, overrides) => f.store.submit(owner, goal, f.spec(goal, capability, overrides));
  f.status = ({ taskId, revision }) => f.store.status(owner, taskId, revision);
  f.report = (attempt, outcome = 'succeeded', eventSeq = 1) => {
    const connection = f.scheduler.endpoint.authenticate(attempt.workerId, connectionSecrets.get(attempt.workerId));
    assert.ok(connection);
    return connection.report(Buffer.from(JSON.stringify({
      protocolVersion: 1, attemptKey: attempt.attemptKey, attemptToken: attempt.attemptToken,
      leaseGeneration: attempt.leaseGeneration, eventSeq,
      event: { kind: 'result', outcome, summary: 'Controlled result', evidence: [], artifacts: [] },
    })));
  };
  f.attempt = ({ taskId, revision }) => ({
    ...inspect.prepare(`SELECT attempt_key AS attemptKey, worker_id AS workerId, attempt_token AS attemptToken,
      lease_generation AS leaseGeneration, dispatch_state AS state, ended_at AS endedAt
      FROM task_attempts WHERE task_id = ? AND revision = ? ORDER BY lease_generation DESC LIMIT 1`).get(taskId, revision),
  });
  f.client = async (boundOwner, label) => {
    const socketPath = process.platform === 'win32'
      ? '\\\\.\\pipe\\pa-p4-' + randomUUID()
      : join(directory, label);
    const token = randomBytes(32).toString('hex');
    const service = await startCoordinator({ socketPath, owner: boundOwner, token, store: f.store });
    sockets.push(service);
    return (operation, fields) => new Promise((resolve, reject) => {
      const call = request({
        socketPath, path: '/v1/' + operation, method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(8_000),
      }, async incoming => {
        try {
          const chunks = await Array.fromAsync(incoming);
          resolve({ code: incoming.statusCode, ...JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) { reject(error); }
      });
      call.on('error', reject);
      call.end(JSON.stringify({ protocolVersion: 1, ...fields }));
    });
  };
  return f;
}

test('V06 recovery resumes an unsent claim and reconciles possibly sent attempts without replay', async t => {
  const starts = [], inspections = [];
  let invisibleAttempt;
  const f = await fixture(t, [worker('metered', 'summarize', 'metered', {
    async start(attempt) {
      starts.push(attempt);
      return { disposition: 'accepted', externalId: 'recovered-local' };
    },
    async inspect(attempt) {
      inspections.push(attempt.attemptKey);
      return attempt.attemptKey === invisibleAttempt ? { disposition: 'never_started' } : unknown;
    },
    async stop() { return unknown; },
  })]);
  const path = fileURLToPath(new URL('./fixtures/task-coordinator-interrupted.mjs', import.meta.url));
  const effectLog = join(f.directory, 'controlled-effects.log');
  const deadlineAt = f.now + 20_000;
  const crashed = new Map();
  const before = f.now;
  for (const boundary of ['unsent', 'possibly-sent', 'response-lost']) {
    const receipt = f.submit(boundary, 'summarize', { deadlineAt });
    const child = spawnSync(process.execPath, [path, f.dbPath, boundary, String(f.now), String(grace), effectLog], {
      encoding: 'utf8', timeout: 8_000,
    });
    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.status, 42, child.stderr);
    const evidence = JSON.parse(child.stdout);
    assert.notEqual(evidence.pid, process.pid);
    const { attemptKey, state } = f.attempt(receipt);
    assert.equal(attemptKey, evidence.attemptKey);
    assert.equal(state, boundary === 'unsent' ? 'unsent' : 'possibly_sent');
    crashed.set(boundary, { receipt, attemptKey });
  }
  invisibleAttempt = crashed.get('possibly-sent').attemptKey;
  await f.reopen();
  f.now = before + interval;
  await f.round();
  await f.round();
  assert.deepEqual(starts.map(({ attemptKey }) => attemptKey), [crashed.get('unsent').attemptKey]);
  assert.equal(starts[0].deadlineAt, deadlineAt);
  assert.ok(inspections.includes(crashed.get('possibly-sent').attemptKey));
  assert.ok(inspections.includes(crashed.get('response-lost').attemptKey));
  assert.equal((await readFile(effectLog, 'utf8')).trim(), crashed.get('response-lost').attemptKey);
  assert.equal(f.scheduler.usage().global, 3, 'an unseen possibly-sent request still holds its resources');
  assert.equal(f.inspect.prepare('SELECT count(*) AS total FROM task_attempts').get().total, 3);
  f.now = deadlineAt + grace;
  await f.reopen();
  await f.round();
  for (const {receipt} of crashed.values()) {
    assert.equal(f.status(receipt).spec.deadlineAt, deadlineAt);
    assert.equal(f.status(receipt).conclusion?.status, 'outcome_unknown', JSON.stringify(f.attempt(receipt)));
  }
  assert.equal(starts.length, 1);
  t.diagnostic(JSON.stringify({ crashed: Object.fromEntries(crashed), before, deadlineAt, closedAt: f.now,
    recoveredStarts: starts.map(({ attemptKey }) => attemptKey), inspections, recordedEffects: 1 }));
});

test('V07 a lost worker closes its dependency chain without blocking independent work', async t => {
  const starts = new Map(), writeOwners = new Map();
  const f = await fixture(t, [
    worker('lost', 'blocked', 'slow', {
      async start(attempt) {
        assert.equal(writeOwners.has(attempt.workspaceKey), false);
        writeOwners.set(attempt.workspaceKey, attempt.attemptKey);
        starts.set(attempt.taskId + ':' + attempt.revision, attempt);
        return unknown;
      },
      async inspect() { return unknown; },
      async stop() { return unknown; },
    }, 2),
    worker('healthy', 'independent', 'fast', {
      async start(attempt) {
        starts.set(attempt.taskId + ':' + attempt.revision, attempt);
        return { disposition: 'accepted', externalId: 'healthy-result' };
      },
    }, 1),
  ], { maxConcurrent: 2, poolLimits: new Map([['slow', 2], ['fast', 1]]) });
  const expiry = f.now + 12_000;
  const a = f.submit('Lost job', 'blocked', { deadlineAt: expiry });
  const b = f.submit('Independent B', 'independent');
  const c = f.submit('Dependent C', 'independent', { dependencies: [a] });
  await f.round();
  const active = receipt => starts.get(receipt.taskId + ':' + receipt.revision);
  const original = active(a);
  assert.ok(original);
  assert.equal(f.status(a).phase, 'reconciling');
  assert.equal(f.scheduler.usage().global, 2);
  assert.deepEqual(f.report(active(b)), { disposition: 'recorded' });
  const d = f.submit('Independent D', 'independent');
  f.now += interval;
  let duringLost = await f.round();
  // The durable owner cursor may first finish the pass whose upper bound predates D.
  if (!active(d)) {
    f.now += interval;
    duringLost = await f.round();
  }
  assert.ok(active(d), JSON.stringify({
    checked: duringLost.examined, claimed: duringLost.attempts, usage: f.scheduler.usage().global,
    a: f.status(a).phase, c: f.status(c).phase, d: f.status(d).phase,
  }));
  assert.deepEqual(f.report(active(d)), { disposition: 'recorded' });
  assert.equal(active(c), undefined);
  f.now = expiry + grace;
  await f.round();
  await f.round();
  assert.equal(f.status(a).conclusion.status, 'outcome_unknown');
  assert.equal(f.status(c).conclusion.status, 'dependency_failed');
  for (const job of [b, d]) assert.equal(f.status(job).conclusion.status, 'succeeded');
  assert.equal(f.scheduler.usage().pools.get('slow'), 1);
  assert.equal(f.scheduler.usage().global, 1);

  const revised = f.store.revise(owner, 'revise-lost', a.taskId, a.revision, 'Continue the same work', {
    deadlineAt: f.now + 60_000,
  });
  await f.round();
  assert.equal(active(revised), undefined);
  assert.equal(f.status(revised).phase, 'queued');
  assert.equal(f.scheduler.usage().workspaces.has(original.workspaceKey), true);
  assert.equal(writeOwners.get(original.workspaceKey), original.attemptKey);
  writeOwners.delete(original.workspaceKey);
  assert.deepEqual(f.report(original), { disposition: 'late' });
  assert.deepEqual(f.report(original), { disposition: 'duplicate' });
  assert.equal(f.status(a).conclusion.status, 'outcome_unknown');
  assert.equal(f.scheduler.usage().global, 0);
  const late = f.inspect.prepare('SELECT late FROM task_attempt_events WHERE attempt_key = ?').all(original.attemptKey);
  assert.deepEqual(late.map(({ late }) => late), [1]);
  const releaseCount = f.inspect.prepare(`SELECT count(*) AS total FROM task_reservations
    WHERE attempt_key = ? AND released_at IS NULL`).get(original.attemptKey).total;
  assert.equal(releaseCount, 0);
  await f.round();
  const continuation = active(revised);
  assert.equal(continuation.workspaceKey, original.workspaceKey);
  assert.equal(continuation.resumeFrom.attemptKey, original.attemptKey);
  assert.equal(f.scheduler.usage().global, 1);
  assert.deepEqual(f.report(original), { disposition: 'duplicate' });
  assert.deepEqual(f.report(original, 'failed', 2), { disposition: 'late' });
  assert.equal(f.scheduler.usage().global, 1);
  assert.equal(f.status(revised).conclusion, null);
  t.diagnostic(JSON.stringify({ a, b, c, d, revised, late: late.length, releaseCount, continuationStarted: true }));
});

test('V08 cancellation and waiting deadlines close once without inventing stop evidence', async t => {
  const starts = new Map(), stops = [];
  const pendingStop = Promise.withResolvers();
  const stopObserved = Promise.withResolvers();
  let endedWithoutResult;
  const f = await fixture(t, [worker('metered', 'summarize', 'metered', {
    async start(attempt) {
      starts.set(attempt.attemptKey, attempt);
      return { disposition: 'accepted', externalId: 'known-run' };
    },
    async inspect(attempt) {
      return attempt.attemptKey === endedWithoutResult ? { disposition: 'finished' } : unknown;
    },
    async stop(attempt) {
      stops.push(attempt.attemptKey);
      if (starts.get(attempt.attemptKey).goal === 'Racing completion') {
        stopObserved.resolve();
        return pendingStop.promise;
      }
      if (['Unconfirmed stop', 'Ended before stop confirmation'].includes(starts.get(attempt.attemptKey).goal)) return unknown;
      return { disposition: 'stopped' };
    },
  })]);
  const client = await f.client(owner, 'a');
  const other = await f.client('owner-b', 'b');
  const submit = async (goal, overrides) => {
    const reply = await client('submit', { sourceKey: goal, spec: f.spec(goal, 'summarize', overrides) });
    assert.equal(reply.code, 200, JSON.stringify(reply));
    return reply.result;
  };
  const cancel = async (receipt, disposition, who = client) => {
    const reply = await who('cancel', receipt);
    assert.equal(reply.code, 200, JSON.stringify(reply));
    assert.equal(reply.result.disposition, disposition);
  };
  const queued = await submit('Queued cancellation');
  assert.equal((await other('cancel', queued)).code, 404);
  await cancel(queued, 'cancelled');
  await cancel(queued, 'already_closed');
  const needsInput = await submit('Input timeout', { waitingForInput: true, deadlineAt: f.now + 1_000 });
  const delayed = await submit('Delayed timeout', { notBeforeAt: f.now + 900, deadlineAt: f.now + 1_000 });
  await f.round();
  assert.equal(starts.size, 0);
  assert.equal(f.status(needsInput).phase, 'waiting_input');
  assert.equal(f.status(delayed).phase, 'queued');
  assert.equal(f.scheduler.usage().global, 0);
  const waiting = await submit('Capacity timeout', { deadlineAt: f.now + 1_000 });
  const stopped = await submit('Confirmed stop');
  const race = await submit('Racing completion');
  const unclear = await submit('Unconfirmed stop');
  const incomplete = await submit('Await materials', { materials: [], waitingForInput: true });
  const missingMaterials = await client('revise', {
    sourceKey: 'without-materials', taskId: incomplete.taskId, expectedRevision: 1, newGoal: 'Continue',
  });
  assert.deepEqual(missingMaterials, { code: 400, protocolVersion: 1, error: 'invalid_request' });
  assert.equal(f.status(incomplete).phase, 'waiting_input');
  const filled = await client('revise', {
    sourceKey: 'supply-materials', taskId: incomplete.taskId, expectedRevision: 1,
    newGoal: 'Use supplied materials', materials: ['remaining:2'], deadlineAt: f.now + 60_000,
  });
  assert.equal(filled.code, 200, JSON.stringify(filled));
  assert.equal(f.status(incomplete).conclusion.status, 'cancelled');
  assert.equal(f.status(filled.result).phase, 'queued');
  assert.deepEqual(f.status(filled.result).spec.materials, ['remaining:2']);

  f.now += 1_000;
  await f.round();
  for (const job of [needsInput, delayed, waiting]) assert.equal(f.status(job).conclusion.status, 'timed_out');
  assert.deepEqual([...starts.values()].map(({taskId}) => taskId).sort(),
    [stopped.taskId, race.taskId, unclear.taskId, incomplete.taskId].sort());
  assert.deepEqual(f.report(f.attempt(filled.result)), { disposition: 'recorded' });
  const stoppedAttempt = f.attempt(stopped);
  const racedAttempt = f.attempt(race);
  await cancel(stopped, 'pending');
  await cancel(stopped, 'pending');
  assert.equal(f.status(stopped).conclusion, null);
  f.now += interval;
  await f.round();
  assert.equal(f.status(stopped).conclusion.status, 'cancelled');
  assert.equal(stops.filter(key => key === stoppedAttempt.attemptKey).length, 1);
  await cancel(stopped, 'already_closed');

  await cancel(race, 'pending');
  f.now += interval;
  const ongoing = f.round();
  try {
    await Promise.race([stopObserved.promise, ongoing.then(() => assert.fail('Stop was not requested'))]);
    assert.equal(f.status(race).conclusion, null);
    assert.deepEqual(f.report(racedAttempt), { disposition: 'recorded' });
  } finally { pendingStop.resolve({ disposition: 'stopped' }); }
  await ongoing;
  await cancel(race, 'already_closed');
  assert.equal(f.status(race).conclusion.status, 'succeeded');
  await cancel(unclear, 'pending');
  f.now += interval;
  await f.round();
  assert.equal(f.status(unclear).conclusion, null);

  const examined = await submit('Ended before stop confirmation');
  await f.round();
  const examinedAttempt = f.attempt(examined);
  assert.equal(f.scheduler.usage().global, 2);
  await cancel(examined, 'pending');
  f.now += interval;
  await f.round();
  assert.ok(stops.includes(examinedAttempt.attemptKey));
  assert.equal(f.status(examined).conclusion, null);
  endedWithoutResult = examinedAttempt.attemptKey;
  f.now += interval;
  await f.round();
  assert.equal(f.status(examined).conclusion.status, 'outcome_unknown');
  assert.equal(f.scheduler.usage().global, 1, 'the finished worker frees only its own occupancy');
  f.now += grace + 15_000;
  await f.round();
  assert.equal(f.status(unclear).conclusion.status, 'outcome_unknown');
  assert.equal(f.scheduler.usage().global, 1);
  const rows = f.inspect.prepare('SELECT count(*) AS total FROM task_conclusions').get();
  const notices = f.inspect.prepare('SELECT count(*) AS total FROM task_notifications').get();
  assert.equal(rows.total, 10);
  assert.equal(notices.total, 10);
  t.diagnostic(JSON.stringify({ queued, needsInput, delayed, waiting, stopped, race, unclear, examined, refilled: filled.result,
    starts: starts.size, stops, rows, notices }));
});

import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
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

const ownerA = 'owner-a';
const ownerB = 'owner-b';

function spec(goal, capability, fields = {}) {
  return {
    goal, capability, materials: ['source:1'], deadlineAt: Date.now() + 60_000, budget: 0,
    inputFormats: ['text/plain'], outputFormats: ['text/plain'], ...fields,
  };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-coordinator-p3-'));
  const dbPath = join(directory, 'tasks.sqlite');
  const close = [];
  t.after(async () => {
    for (const dispose of close.toReversed()) await dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const store = new TaskCoordinatorStore(dbPath);
  close.push(() => store.close());
  const submit = (goal, capability, fields, owner = ownerA) => store.submit(owner, goal, spec(goal, capability, fields));
  const phase = ({ taskId, revision }, owner = ownerA) => store.status(owner, taskId, revision).phase;
  return { directory, dbPath, store, close, submit, phase };
}

async function submitClient(f, owner, name) {
  const socketPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\pa-p3-' + randomUUID()
    : join(f.directory, name);
  const token = randomBytes(32).toString('hex');
  const endpoint = await startCoordinator({ socketPath, owner, token, store: f.store });
  f.close.push(() => endpoint.close());
  return async (sourceKey, capability) => {
    const response = await new Promise((resolve, reject) => {
      const call = request({
        socketPath, path: '/v1/submit', method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(8_000),
      }, async incoming => {
        try {
          const chunks = await Array.fromAsync(incoming);
          resolve({ code: incoming.statusCode, ...JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) { reject(error); }
      });
      call.on('error', reject);
      call.end(JSON.stringify({ protocolVersion: 1, sourceKey, spec: spec(sourceKey, capability) }));
    });
    assert.equal(response.code, 200, JSON.stringify(response));
    return response.result;
  };
}

function contender(f) {
  const path = fileURLToPath(new URL('./fixtures/task-coordinator-claim.mjs', import.meta.url));
  const child = fork(path, [f.dbPath], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = new Promise(resolve => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  f.close.push(async () => {
    if (child.connected) child.disconnect();
    await exited;
  });
  const mailbox = [];
  child.on('message', message => mailbox.push(message));
  const receive = async type => {
    const timeout = AbortSignal.timeout(8_000);
    for (;;) {
      const index = mailbox.findIndex(message => message.type === type);
      if (index >= 0) return mailbox.splice(index, 1)[0];
      try { await once(child, 'message', { signal: timeout }); }
      catch (error) { throw new Error(`Process ${child.pid} did not report ${type}`, { cause: error }); }
    }
  };
  const send = (op, fields) => child.send({ op, ...fields });
  return { send, receive };
}

test('V04 two processes claim once and run independent tasks concurrently', async t => {
  const f = await fixture(t);
  const inspect = new DatabaseSync(f.dbPath);
  f.close.push(() => inspect.close());
  const submitA = await submitClient(f, ownerA, 'a');
  const submitB = await submitClient(f, ownerB, 'b');
  const processes = [contender(f), contender(f)];
  const ready = await Promise.all(processes.map(process => process.receive('ready')));
  assert.equal(new Set([process.pid, ...ready.map(event => event.pid)]).size, 3);

  const first = await submitA('First summary', 'summarize');
  inspect.exec('BEGIN IMMEDIATE');
  try {
    for (const process of processes) process.send('claim');
    await Promise.all(processes.map(process => process.receive('contending')));
  } finally {
    inspect.exec('ROLLBACK');
  }
  const race = await Promise.all(processes.map(process => process.receive('claimed')));
  assert.deepEqual(race.map(round => round.attempts.length).sort(), [0, 1]);
  const winnerIndex = race.findIndex(round => round.attempts.length === 1);
  const winner = processes[winnerIndex];
  const other = processes[1 - winnerIndex];
  const beganFirst = await winner.receive('started');
  assert.equal(beganFirst.taskId, first.taskId);
  assert.equal(beganFirst.revision, first.revision);
  assert.equal(beganFirst.attemptKey, race[winnerIndex].attempts[0].attemptKey);
  const attemptCount = inspect.prepare('SELECT count(*) AS total FROM task_attempts WHERE task_id = ? AND revision = ?');
  assert.equal(attemptCount.get(first.taskId, first.revision).total, 1);
  assert.equal(f.phase(first), 'running');

  // The first adapter cannot return until this test explicitly unblocks it.
  const second = await submitB('Another summary', 'summarize');
  const write = { type: 'other-client-write-committed', taskId: second.taskId, at: Date.now() };
  const committed = inspect.prepare('SELECT task_id AS taskId, revision FROM task_requests WHERE owner = ? AND source_key = ?')
    .get(ownerB, 'Another summary');
  assert.deepEqual({ ...committed }, second);
  assert.equal(f.phase(second, ownerB), 'queued');

  other.send('claim');
  const parallel = await other.receive('claimed');
  assert.equal(parallel.attempts.length, 1);
  const beganSecond = await other.receive('started');
  assert.equal(beganSecond.taskId, second.taskId);
  assert.equal(beganSecond.revision, second.revision);
  assert.equal(beganSecond.attemptKey, parallel.attempts[0].attemptKey);
  assert.notEqual(beganFirst.pid, beganSecond.pid);
  assert.equal(f.phase(first), 'running');
  assert.equal(f.phase(second, ownerB), 'running');

  winner.send('finish', { attemptKey: beganFirst.attemptKey });
  const endedFirst = await winner.receive('finished');
  assert.equal(f.phase(second, ownerB), 'running');
  other.send('finish', { attemptKey: beganSecond.attemptKey });
  const endedSecond = await other.receive('finished');
  for (const ended of [endedFirst, endedSecond]) {
    assert.equal(ended.startCount, 1);
    assert.equal(ended.dispatch.disposition, 'accepted');
    assert.deepEqual(ended.result, { disposition: 'recorded' });
  }
  assert.equal(f.store.status(ownerA, first.taskId).conclusion.status, 'succeeded');
  assert.equal(f.store.status(ownerB, second.taskId).conclusion.status, 'succeeded');
  assert.equal(attemptCount.get(first.taskId, first.revision).total, 1);
  assert.equal(attemptCount.get(second.taskId, second.revision).total, 1);
  t.diagnostic(JSON.stringify({ race, interval: [beganFirst, write, beganSecond, endedFirst, endedSecond] }));
});

function useWorkers(f, workers, schedulerOptions) {
  const registry = new WorkerRegistry();
  const connectionSecrets = new Map();
  const active = new Map();
  const events = [];
  for (const [index, { workerId, maxConcurrent, resources, canResume = false }] of workers.entries()) {
    connectionSecrets.set(workerId, (index + 1).toString(16).padStart(64, '0'));
    registry.register({
      declaration: {
        workerId, protocolVersion: 1,
        capabilities: [{ name: workerId, inputFormats: ['text/plain'], outputFormats: ['text/plain'], requiredPermissions: [] }],
        resources: resources.map(([poolId, units]) => ({ poolId, units })),
        limits: { maxConcurrent, operationTimeoutMs: 2_000, reportBytes: 2_048 },
        idempotentStart: true, canResume, canInspect: false, canStop: false, effects: 'none',
      },
      async start(attempt) {
        active.set(attempt.attemptKey, attempt);
        const { taskId, revision, attemptKey, resumeFrom } = attempt;
        events.push({ type: 'started', taskId, revision, workerId, attemptKey, resumeFrom });
        return { disposition: 'accepted', externalId: 'local-fixture' };
      },
    });
  }

  const createScheduler = store => new TaskScheduler({
    store, registry, connectionSecrets,
    ...schedulerOptions, poolLimits: new Map(schedulerOptions.poolLimits),
  });
  let scheduler = createScheduler(f.store);
  let reopened;
  f.close.push(async () => {
    await scheduler.close();
    reopened?.close();
  });
  const reopen = async () => {
    await scheduler.close();
    reopened?.close();
    reopened = undefined;
    reopened = new TaskCoordinatorStore(f.dbPath);
    scheduler = createScheduler(reopened);
  };
  const round = async () => {
    const { attempts, dispatches, examined } = scheduler.tick();
    assert.equal(attempts.length, dispatches.length);
    const replies = await Promise.all(dispatches);
    assert.deepEqual(replies.map(reply => reply.disposition), attempts.map(() => 'accepted'));
    const started = attempts.map(({ attemptKey }) => {
      assert.ok(active.has(attemptKey), `Adapter never began ${attemptKey}`);
      const { taskId, revision } = active.get(attemptKey);
      return { taskId, revision };
    });
    return { examined, started };
  };
  const finish = ({ taskId, revision }) => {
    const attempt = Array.from(active.values()).find(attempt => attempt.taskId === taskId && attempt.revision === revision);
    assert.ok(attempt, 'A real adapter must start before reporting a result');
    const { attemptKey, attemptToken, leaseGeneration, workerId } = attempt;
    const connection = scheduler.endpoint.authenticate(workerId, connectionSecrets.get(workerId));
    const report = Buffer.from(JSON.stringify({
      protocolVersion: 1, attemptKey, attemptToken, leaseGeneration, eventSeq: 1,
      event: { kind: 'result', outcome: 'succeeded', summary: 'Done', evidence: [], artifacts: [] },
    }));
    assert.deepEqual(connection.report(report), { disposition: 'recorded' });
    active.delete(attemptKey);
    events.push({ type: 'finished', taskId, revision, workerId });
  };
  const usage = () => {
    const { global, workers, pools, workspaces } = scheduler.usage();
    const used = entries => Object.fromEntries([...entries].filter(([, units]) => units > 0));
    return { global, workers: used(workers), pools: used(pools), workspaces: [...workspaces].sort() };
  };
  return { round, finish, usage, events, reopen };
}

test('V04 global, worker, pool and workspace capacity each block an eligible task', async t => {
  const f = await fixture(t);
  const { round, finish, usage } = useWorkers(f, [
    { workerId: 'general', maxConcurrent: 5, resources: [['cpu', 1]] },
    { workerId: 'serial', maxConcurrent: 1, resources: [['cpu', 1]] },
    { workerId: 'render', maxConcurrent: 4, resources: [['shared', 2], ['cpu', 1]] },
    { workerId: 'convert', maxConcurrent: 4, resources: [['shared', 1]] },
  ], { maxConcurrent: 3, poolLimits: [['cpu', 8], ['shared', 2]] });

  const snapshots = [];
  const expectStarts = async (...expected) => assert.deepEqual((await round()).started, expected);
  const expectBlocked = async (limit, extra, expected) => {
    const { started, examined } = await round();
    assert.deepEqual(started, []);
    if (limit !== 'global') assert.ok(examined > 0);
    assert.equal(f.phase(extra), 'queued');
    const current = usage();
    assert.deepEqual({ global: current.global, workers: current.workers, pools: current.pools }, expected);
    snapshots.push({ limit, examined, queued: extra, ...current });
    return current;
  };

  const globalHolders = [1, 2, 3].map(index => f.submit(`Global place ${index}`, 'general'));
  await expectStarts(...globalHolders);
  const globalExtra = f.submit('Blocked at global capacity', 'general');
  await expectBlocked('global', globalExtra, { global: 3, workers: { general: 3 }, pools: { cpu: 3 } });
  finish(globalHolders[0]);
  await expectStarts(globalExtra);
  for (const receipt of [...globalHolders.slice(1), globalExtra]) finish(receipt);
  assert.equal(usage().global, 0);

  const serial = f.submit('Serial worker holder', 'serial');
  await expectStarts(serial);
  const serialExtra = f.submit('Blocked at worker capacity', 'serial');
  await expectBlocked('worker', serialExtra, { global: 1, workers: { serial: 1 }, pools: { cpu: 1 } });
  const differentWorker = f.submit('Different worker still available', 'general');
  await expectStarts(differentWorker);
  assert.equal(f.phase(serialExtra), 'queued');
  finish(serial);
  await expectStarts(serialExtra);
  finish(serialExtra);
  finish(differentWorker);
  assert.equal(usage().global, 0);

  const shared = f.submit('Reserve two shared units', 'render');
  await expectStarts(shared);
  const sharedExtra = f.submit('Blocked at shared pool capacity', 'convert');
  await expectBlocked('pool', sharedExtra, { global: 1, workers: { render: 1 }, pools: { cpu: 1, shared: 2 } });
  const differentPool = f.submit('Independent pool still available', 'general');
  await expectStarts(differentPool);
  assert.equal(f.phase(sharedExtra), 'queued');
  finish(shared);
  await expectStarts(sharedExtra);
  finish(sharedExtra);
  finish(differentPool);
  assert.equal(usage().global, 0);

  const workspaceKey = 'shared-workspace';
  const writer = f.submit('Workspace writer', 'general', { workspaceKey });
  await expectStarts(writer);
  const writerExtra = f.submit('Blocked at workspace capacity', 'serial', { workspaceKey });
  const blocked = await expectBlocked('workspace', writerExtra,
    { global: 1, workers: { general: 1 }, pools: { cpu: 1 } });
  assert.equal(blocked.workspaces.length, 1);
  const differentWorkspace = f.submit('Other owner has an independent workspace', 'serial', { workspaceKey }, ownerB);
  await expectStarts(differentWorkspace);
  assert.equal(usage().workspaces.length, 2);
  finish(differentWorkspace);
  assert.equal(f.phase(writerExtra), 'queued');
  finish(writer);
  await expectStarts(writerExtra);
  finish(writerExtra);
  assert.deepEqual(usage(), { global: 0, workers: {}, pools: {}, workspaces: [] });
  t.diagnostic(JSON.stringify(snapshots));
});

test('V05 bounded scans and owner rotation preserve runnable FIFO', async t => {
  const f = await fixture(t);
  const scanLimit = 2;
  const { round, finish, usage, events, reopen } = useWorkers(f, [
    { workerId: 'busy', maxConcurrent: 4, resources: [['busy-pool', 1]] },
    { workerId: 'free', maxConcurrent: 4, resources: [['free-pool', 1]] },
  ], { maxConcurrent: 2, scanLimit, poolLimits: [['busy-pool', 1], ['free-pool', 4]] });

  const blocker = f.submit('Busy pool holder', 'busy');
  assert.deepEqual((await round()).started, [blocker]);
  const blocked = Array.from({ length: 5 }, (_, index) => f.submit(`Contended queue head ${index + 1}`, 'busy'));
  const first = f.submit('First runnable A', 'free');
  const second = f.submit('Second runnable A', 'free');
  const third = f.submit('Third runnable A', 'free');
  const rounds = [];
  const next = async (expected, maxRounds, reopenAfterMiss = false) => {
    for (let index = 0; index < maxRounds; index += 1) {
      const result = await round();
      rounds.push(result);
      assert.ok(result.examined >= result.started.length && result.examined <= scanLimit, JSON.stringify(result));
      if (result.started.length) {
        assert.deepEqual(result.started, [expected]);
        return;
      }
      if (reopenAfterMiss) await reopen();
    }
    assert.fail(`Task ${expected.taskId} did not start within ${maxRounds} bounded rounds`);
  };

  // The earliest runnable row follows more blocked rows than one scan can examine.
  const maxRounds = Math.ceil((blocked.length + 4) / scanLimit) + 1;
  await next(first, maxRounds, true);
  assert.equal(f.phase(blocker), 'running');
  for (const receipt of blocked) assert.equal(f.phase(receipt), 'queued');
  assert.equal(usage().global, 2);
  finish(first);

  // B arrives behind two already runnable A rows. The next free place must rotate to B.
  const fromB = f.submit('Runnable B', 'free', {}, ownerB);
  await next(fromB, maxRounds);
  assert.equal(f.phase(second), 'queued');
  assert.equal(f.phase(third), 'queued');
  finish(fromB);
  await next(second, maxRounds);
  finish(second);
  await next(third, maxRounds);
  finish(third);
  finish(blocker);
  await next(blocked[0], maxRounds);
  finish(blocked[0]);
  t.diagnostic(JSON.stringify({ rounds, events }));
});

test('V05 dependencies are pinned to revisions and cycles are refused', async t => {
  const f = await fixture(t);
  const { round, finish, usage, events } = useWorkers(f, [
    { workerId: 'transform', maxConcurrent: 4, resources: [['cpu', 1]], canResume: true },
  ], { maxConcurrent: 3, poolLimits: [['cpu', 3]] });
  const starts = async (...expected) => assert.deepEqual((await round()).started, expected);

  const input = f.submit('Prepare input', 'transform');
  const usesFirst = f.submit('Read first input revision', 'transform', { dependencies: [input] });
  assert.equal(f.phase(usesFirst), 'waiting_dependency');
  await starts(input);
  assert.equal(f.phase(usesFirst), 'waiting_dependency');
  assert.equal(usage().global, 1);
  finish(input);

  const revised = f.store.revise(ownerA, 'New input revision', input.taskId, input.revision, 'Prepare input again');
  assert.equal(revised.revision, 2);
  const usesSecond = f.submit('Read second input revision', 'transform', { dependencies: [revised] });
  const byTaskId = (a, b) => a.taskId.localeCompare(b.taskId);
  assert.deepEqual((await round()).started.sort(byTaskId), [usesFirst, revised].sort(byTaskId));
  const previous = events.find(event => event.type === 'started' && event.taskId === input.taskId && event.revision === 1);
  const continuation = events.find(event => event.type === 'started' && event.taskId === input.taskId && event.revision === 2);
  assert.deepEqual(continuation.resumeFrom, { attemptKey: previous.attemptKey, revision: 1, externalId: 'local-fixture' });
  assert.equal(f.phase(usesFirst), 'running');
  assert.equal(f.phase(usesSecond), 'waiting_dependency');
  finish(usesFirst);
  await starts();
  finish(revised);
  await starts(usesSecond);
  finish(usesSecond);
  assert.equal(usage().global, 0);

  const left = f.submit('Cycle first node', 'transform');
  const middle = f.submit('Cycle middle node', 'transform');
  const right = f.submit('Cycle second node', 'transform');
  f.store.setDependencies(ownerA, left, [middle]);
  f.store.setDependencies(ownerA, middle, [right]);
  assert.throws(() => f.store.setDependencies(ownerA, right, [left]), { code: 'invalid_request' });
  assert.equal(usage().global, 0);
  assert.equal(f.phase(left), 'waiting_dependency');
  assert.equal(f.phase(middle), 'waiting_dependency');
  assert.equal(f.phase(right), 'queued');
  await starts(right);
  assert.equal(f.phase(left), 'waiting_dependency');
  finish(right);
  await starts(middle);
  assert.equal(f.phase(left), 'waiting_dependency');
  finish(middle);
  await starts(left);
  finish(left);
  assert.equal(usage().global, 0);
  t.diagnostic(JSON.stringify({ dependencies: [[usesFirst, input], [usesSecond, revised], [left, middle], [middle, right]], events }));
});

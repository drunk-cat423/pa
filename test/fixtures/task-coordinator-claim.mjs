import { TaskScheduler } from '../../dist/task-coordinator/scheduler.js';
import { TaskCoordinatorStore } from '../../dist/task-coordinator/store.js';
import { WorkerRegistry } from '../../dist/task-coordinator/registry.js';

const store = new TaskCoordinatorStore(process.argv[2]);
const registry = new WorkerRegistry();
const workerId = 'summary';
const secret = 'a'.repeat(64);
const active = new Map();
const batches = new Map();
let startCount = 0;

registry.register({
  declaration: {
    workerId, protocolVersion: 1,
    capabilities: [{ name: 'summarize', inputFormats: ['text/plain'], outputFormats: ['text/plain'], requiredPermissions: [] }],
    resources: [{ poolId: 'cpu', units: 1 }],
    limits: { maxConcurrent: 2, operationTimeoutMs: 15_000, reportBytes: 2_048 },
    idempotentStart: true, canResume: false, canInspect: false, canStop: false, effects: 'none',
  },
  async start(attempt) {
    const gate = Promise.withResolvers();
    const running = { attempt, gate };
    active.set(attempt.attemptKey, running);
    startCount += 1;
    process.send({
      type: 'started', pid: process.pid, taskId: attempt.taskId, revision: attempt.revision,
      attemptKey: attempt.attemptKey, at: Date.now(),
    });
    const receipt = await gate.promise;
    running.endedAt = Date.now();
    return receipt;
  },
});

const scheduler = new TaskScheduler({
  store, registry, connectionSecrets: new Map([[workerId, secret]]),
  maxConcurrent: 2, poolLimits: new Map([['cpu', 2]]),
});
const connection = scheduler.endpoint.authenticate(workerId, secret);
process.send({ type: 'ready', pid: process.pid });

process.on('message', async message => {
  if (message.op === 'claim') {
    process.send({ type: 'contending', pid: process.pid });
    const before = startCount;
    const alreadyActive = new Set(active.keys());
    const round = scheduler.tick();
    for (const [index, key] of round.attempts.entries()) batches.set(key.attemptKey, round.dispatches[index]);
    // tick queues dispatch in a microtask. Only the process that wins claimStart calls the adapter.
    await Promise.resolve();
    const started = [...active.keys()].filter(key => !alreadyActive.has(key));
    process.send({ type: 'claimed', pid: process.pid, attempts: round.attempts, examined: round.examined,
      started, startCount: startCount - before });
    return;
  }
  if (message.op === 'finish') {
    const { attemptKey } = message;
    const running = active.get(attemptKey);
    const { attempt, gate } = running;
    gate.resolve({ disposition: 'accepted', externalId: 'summary-local' });
    const dispatch = await batches.get(attemptKey);
    active.delete(attemptKey);
    batches.delete(attemptKey);
    const result = connection.report(Buffer.from(JSON.stringify({
      protocolVersion: 1, attemptKey, attemptToken: attempt.attemptToken, leaseGeneration: attempt.leaseGeneration,
      eventSeq: 1, event: { kind: 'result', outcome: 'succeeded', summary: 'Summary ready', evidence: [], artifacts: [] },
    })));
    process.send({
      type: 'finished', pid: process.pid, taskId: attempt.taskId, attemptKey, dispatch, result, startCount, at: running.endedAt,
    });
  }
});

process.on('disconnect', async () => {
  for (const { gate } of active.values()) gate.resolve({ disposition: 'unknown' });
  await scheduler.close();
  store.close();
});

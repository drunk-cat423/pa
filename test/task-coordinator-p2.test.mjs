import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerRegistry } from '../dist/task-coordinator/registry.js';
import { WorkerEndpoint } from '../dist/task-coordinator/worker-endpoint.js';

const secrets = new Map([['summarizer', 'a'.repeat(64)], ['renderer', 'b'.repeat(64)]]);
const attemptToken = 'opaque-attempt-token-for-v03-use-only';

function describe(workerId, capability, format, requiredPermissions = []) {
  return {
    workerId,
    protocolVersion: 1,
    capabilities: [{ name: capability, inputFormats: ['text/plain'], outputFormats: [format], requiredPermissions }],
    resources: [{ poolId: 'local_cpu', units: 1 }],
    limits: { maxConcurrent: 1, operationTimeoutMs: 1_000, reportBytes: 2_048 },
    idempotentStart: true,
    canResume: false,
    canInspect: true,
    canStop: true,
    effects: 'none',
  };
}

function requirements(overrides = {}) {
  return {
    protocolVersion: 1,
    capability: 'render',
    inputFormats: ['text/plain'],
    outputFormats: ['image/png'],
    ...overrides,
  };
}

function createHarness() {
  const registry = new WorkerRegistry();
  const attempts = new Map();
  const marked = new Set();
  const recorded = [];
  const calls = [];
  const port = {
    getAttempt: key => attempts.get(key),
    claimStart: fence => {
      if (marked.has(fence.attemptKey)) return false;
      const current = attempts.get(fence.attemptKey);
      assert.equal(fence.workerId, current.workerId);
      assert.equal(fence.leaseGeneration, current.leaseGeneration);
      assert.equal(fence.attemptToken, current.attemptToken);
      marked.add(fence.attemptKey);
      return true;
    },
    recordReport: report => {
      recorded.push(report);
      return 'recorded';
    },
  };
  const admit = (attemptKey, spec = {}) => {
    const key = { attemptKey, workerId: 'renderer', leaseGeneration: 3 };
    attempts.set(attemptKey, {
      ...key, taskId: 'task-17', revision: 1, attemptToken, requirements: requirements(), goal: 'Render a stationary diagram',
      materials: ['input-1'], deadlineAt: 1_800_000_000_000, budget: 0,
      allowedPermissions: new Set(['render_local']), ...spec,
    });
    return key;
  };
  registry.register({
    declaration: describe('summarizer', 'summarize', 'text/plain'),
    async start(attempt) {
      calls.push(['summarizer', attempt]);
      return { disposition: 'accepted', externalId: 'local-summary' };
    },
    async inspect() { return { disposition: 'finished' }; },
    async stop() { return { disposition: 'stopped' }; },
  });
  return { registry, port, marked, recorded, calls, admit };
}

test('V03 selects a new compatible worker and fences start and authenticated reports', async () => {
  const { registry, port, marked, recorded, calls, admit } = createHarness();
  const permissions = new Set(['render_local']);
  assert.deepEqual(registry.select(requirements(), permissions), { reason: 'unsupported_capability' });

  let renderer;
  let finishStart;
  const waiting = new Promise(resolve => { finishStart = resolve; });
  const rendererAdapter = {
    declaration: describe('renderer', 'render', 'image/png', ['render_local']),
    async start(attempt) {
      assert.ok(marked.has(attempt.attemptKey));
      assert.equal(attempt.taskId, 'task-17');
      assert.equal(attempt.revision, 1);
      calls.push(['renderer', attempt]);
      assert.deepEqual(renderer.report(reportBody(attempt)), { disposition: 'recorded' });
      return waiting;
    },
    async inspect() { return { disposition: 'running' }; },
    async stop() { return { disposition: 'requested' }; },
  };
  registry.register(rendererAdapter);
  assert.throws(() => registry.register(rendererAdapter), { message: 'duplicate_worker_id' });
  assert.deepEqual(registry.describe().map(worker => [worker.workerId, worker.capabilities[0].name]), [
    ['summarizer', 'summarize'], ['renderer', 'render'],
  ]);
  assert.deepEqual(registry.select(requirements(), permissions), { workerId: 'renderer' });
  assert.deepEqual(registry.select(requirements(), permissions, { isHealthy: () => false }),
    { reason: 'unavailable_worker' });
  assert.deepEqual(registry.select(requirements(), permissions, { hasCapacity: () => false }),
    { reason: 'unavailable_worker' });

  const endpoint = new WorkerEndpoint(registry, port, secrets);
  renderer = endpoint.authenticate('renderer', secrets.get('renderer'));
  const summarizer = endpoint.authenticate('summarizer', secrets.get('summarizer'));
  assert.ok(renderer);
  assert.ok(summarizer);
  assert.equal(endpoint.authenticate('renderer', secrets.get('summarizer')), undefined);
  const key = admit('diagram-v1');

  assert.deepEqual(await endpoint.start({ ...key, workerId: 'summarizer' }),
    { disposition: 'rejected', reason: 'stale_attempt' });
  assert.deepEqual(await endpoint.start({ ...key, leaseGeneration: 1 }),
    { disposition: 'rejected', reason: 'stale_attempt' });
  assert.deepEqual(await endpoint.start({ ...key, attemptKey: 'invented' }),
    { disposition: 'rejected', reason: 'stale_attempt' });

  for (const [index, [reason, spec]] of [
    ['unsupported_version', { requirements: requirements({ protocolVersion: 2 }) }],
    ['unsupported_capability', { requirements: requirements({ capability: 'summarize' }) }],
    ['unsupported_format', { requirements: requirements({ outputFormats: ['image/jpeg'] }) }],
    ['unsupported_format', { requirements: requirements({ inputFormats: ['application/pdf'] }) }],
    ['permission_denied', { allowedPermissions: new Set() }],
  ].entries()) {
    const incompatible = admit(`invalid-${index}`, spec);
    assert.deepEqual(await endpoint.start(incompatible), { disposition: 'rejected', reason });
  }
  assert.deepEqual(calls, []);
  assert.equal(marked.size, 0);

  assert.deepEqual(summarizer.report(reportBody(key)), { disposition: 'unauthorized' });
  assert.deepEqual(summarizer.report(reportBody(key, { workerId: 'renderer' })), { disposition: 'invalid_report' });
  assert.deepEqual(renderer.report(reportBody(key, { attemptToken: 'x'.repeat(64) })), { disposition: 'unauthorized' });
  assert.deepEqual(renderer.report(reportBody(key, { leaseGeneration: 2 })), { disposition: 'stale_attempt' });
  assert.deepEqual(renderer.report(reportBody(key, { protocolVersion: 2 })), { disposition: 'unsupported_version' });
  assert.deepEqual(renderer.report(reportBody(key, { eventSeq: 0 })), { disposition: 'invalid_report' });
  assert.deepEqual(renderer.report(Buffer.alloc(2_049)), { disposition: 'invalid_report' });
  assert.deepEqual(renderer.report(Buffer.from([0xff])), { disposition: 'invalid_report' });
  assert.deepEqual(recorded, []);

  const start = endpoint.start(key);
  assert.deepEqual(calls, [['renderer', {
    ...key, taskId: 'task-17', revision: 1, attemptToken, requirements: requirements(), goal: 'Render a stationary diagram',
    materials: ['input-1'], deadlineAt: 1_800_000_000_000, budget: 0,
  }]]);
  assert.deepEqual(await endpoint.start(key), { disposition: 'rejected', reason: 'dispatch_not_claimed' });
  assert.deepEqual(await endpoint.inspect(key), { disposition: 'running' });
  assert.deepEqual(await endpoint.stop(key), { disposition: 'requested' });
  finishStart({ disposition: 'accepted', externalId: 'local-diagram' });
  assert.deepEqual(await start, { disposition: 'accepted', externalId: 'local-diagram' });

  const result = {
    kind: 'result', outcome: 'succeeded', summary: 'Diagram rendered',
    evidence: ['rendered 1 frame'], artifacts: [{ reference: 'frame-1', format: 'image/png' }],
  };
  assert.deepEqual(renderer.report(reportBody(key, {
    eventSeq: 2, event: { ...result, artifacts: [{ reference: '../frame-1', format: 'image/png' }] },
  })), { disposition: 'invalid_report' });
  assert.deepEqual(renderer.report(reportBody(key, { eventSeq: 2, event: result })), { disposition: 'recorded' });
  assert.deepEqual(recorded, [
    { ...key, attemptToken, eventSeq: 1, event: { kind: 'progress', message: 'Started' } },
    { ...key, attemptToken, eventSeq: 2, event: result },
  ]);
  assert.equal(calls.length, 1);
});

test('a silent adapter times out with unknown effects and no second start', async () => {
  const { registry, port, admit } = createHarness();
  const calls = [];
  registry.register({
    declaration: {
      ...describe('renderer', 'render', 'image/png'), limits: { maxConcurrent: 1, operationTimeoutMs: 20, reportBytes: 2_048 },
      canInspect: false, canStop: false, effects: 'external', idempotentStart: false,
    },
    async start(_attempt, signal) {
      calls.push(signal);
      return new Promise(() => {});
    },
  });
  const endpoint = new WorkerEndpoint(registry, port, secrets);
  const key = admit('unresponsive-v1');

  assert.deepEqual(await endpoint.start(key), { disposition: 'unknown' });
  assert.equal(calls[0].aborted, true);
  assert.deepEqual(await endpoint.start(key), { disposition: 'rejected', reason: 'dispatch_not_claimed' });
  assert.deepEqual(await endpoint.inspect(key), { disposition: 'unsupported' });
  assert.deepEqual(await endpoint.stop(key), { disposition: 'unsupported' });
  assert.equal(calls.length, 1);
});

function reportBody(key, fields = {}) {
  return Buffer.from(JSON.stringify({
    protocolVersion: 1, attemptKey: key.attemptKey, leaseGeneration: key.leaseGeneration,
    attemptToken, eventSeq: 1, event: { kind: 'progress', message: 'Started' }, ...fields,
  }));
}

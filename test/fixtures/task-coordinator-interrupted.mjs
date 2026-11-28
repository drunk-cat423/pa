import assert from 'node:assert/strict';
import { appendFileSync, writeSync } from 'node:fs';
import { TaskCoordinatorStore } from '../../dist/task-coordinator/store.js';
import { WorkerRegistry } from '../../dist/task-coordinator/registry.js';
import { WorkerEndpoint } from '../../dist/task-coordinator/worker-endpoint.js';

const [database, boundary, at, grace, effectLog] = process.argv.slice(2);
const now = () => Number(at);
const store = new TaskCoordinatorStore(database);
const registry = new WorkerRegistry();
const workerId = 'metered';
const connectionSecrets = new Map([[workerId, 'a'.repeat(64)]]);
const declaration = {
  workerId, protocolVersion: 1,
  capabilities: [{ name: 'summarize', inputFormats: [], outputFormats: [], requiredPermissions: [] }],
  resources: [{ poolId: 'metered', units: 1 }],
  limits: { maxConcurrent: 4, operationTimeoutMs: 2_000, reportBytes: 4_096 },
  idempotentStart: false, canResume: true, canInspect: true, canStop: true, effects: 'external',
};
registry.register({
  declaration,
  async start({ attemptKey }) {
    appendFileSync(effectLog, attemptKey + '\n');
    process.exit(42);
  },
  async inspect() { return { disposition: 'unknown' }; },
  async stop() { return { disposition: 'unknown' }; },
});
const limits = { maxConcurrent: 4, maxConcurrentPerOwner: 4, poolLimits: new Map([['metered', 4]]) };
store.scheduling.configure(limits, [declaration]);
const { attempts } = store.scheduling.claimRound({
  limits, scanLimit: 1, now: now(), recoveryGraceMs: Number(grace),
  permissions: () => new Set(), select: () => declaration,
});
assert.equal(attempts.length, 1);
const attempt = attempts[0];
writeSync(1, JSON.stringify({ pid: process.pid, ...attempt }));
const port = store.scheduling.workerPort(now);
if (boundary === 'possibly-sent') assert.ok(port.claimStart(port.getAttempt(attempt.attemptKey)));
if (boundary === 'response-lost') {
  await new WorkerEndpoint(registry, port, connectionSecrets).start(attempt);
  throw new Error('The process must exit after the worker records the effect');
}
assert.ok(boundary === 'unsent' || boundary === 'possibly-sent');
process.exit(42);
